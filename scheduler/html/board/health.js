// Status light of the scheduler: a pill in the top bar (frame.js) and the check a page makes before submitting a task
// (CheckScheduler, e.g. a launcher). When the scheduler stops answering, a launch used to fail with an opaque
// "no answer from the scheduler (NetworkError)".
// It polls <scheduler>/api/health, which (unlike /api/tasks/running, that only reads the state file) takes the
// schedule lock -- the very lock a submission waits for -- and reports the HTTP thread pool, so a saturated pool is
// visible instead of silent.
// The scheduler is the origin of the page by default (its own pages); a page served by another service names it with
// SetSchedulerURL (frame.js: ShowSchedulerHealth).

let base = window.location.origin;
let lastHealth = null;

export function SetSchedulerURL(url) {
  base = String(url).replace(/\/+$/, '');
}

export function SchedulerURL() {
  return base;
}

const healthStates = {
  up: { dot: '\u{1F7E2}', text: 'scheduler' },
  slow: { dot: '\u{1F7E0}', text: 'slow', cls: 'warn' },
  busy: { dot: '\u{1F7E0}', text: 'busy', cls: 'warn' },
  down: { dot: '\u{1F534}', text: 'no answer', cls: 'down' },
};

// Reads the health once. Returns the parsed state, or a "down" state when the scheduler does not answer.
async function FetchHealth() {
  try {
    // a deadline: a scheduler whose HTTP threads are all taken accepts the connection and never answers; without it
    // the probes piled up and the light never turned "down"
    const response = await fetch(`${base}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    // a scheduler older than /api/health answers 404: it is up, its lock just cannot be probed
    if (response.status === 404) {
      lastHealth = { state: 'up', legacy: true };
      return lastHealth;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const data = body?.data;
    if (!data?.state) throw new Error('no state');
    lastHealth = data;
    return data;
  } catch (error) {
    lastHealth = { state: 'down', error: String(error.message || error) };
    return lastHealth;
  }
}

// What a page should tell the user before submitting. null when the scheduler looks healthy.
export function SchedulerWarning(health = lastHealth) {
  if (!health) return null;
  if (health.state === 'down') return 'The scheduler does not answer. The launch would fail; check the service.';
  if (health.state === 'busy') {
    return `The scheduler did not answer within ${health.lock_timeout_ms} ms. A launch may time out; try again in a moment.`;
  }
  if (health.state === 'slow') return `The scheduler is busy (${health.lock_wait_ms} ms to answer). A launch may be slow.`;
  return null;
}

// Reads the health now, for a page that is about to submit (a launcher).
export async function CheckScheduler() {
  const health = await FetchHealth();
  return { health, warning: SchedulerWarning(health) };
}

function RenderHealth(pill, health) {
  const state = healthStates[health.state] || healthStates.down;
  pill.className = `pb-health ${state.cls || ''}`;
  pill.textContent = `${state.dot} ${state.text}`;
  const lines = [];
  if (health.state === 'down') {
    lines.push(`No answer from the scheduler (${base})${health.error ? ` (${health.error})` : ''}.`);
  } else if (health.legacy) {
    lines.push('The scheduler answers (this version cannot report its load).');
  } else {
    lines.push(`Schedule lock taken in ${health.lock_wait_ms} ms${health.lock_taken ? '' : ' (timed out)'}.`);
  }
  const http = health.http;
  if (http) {
    lines.push(`HTTP: ${http.threads}/${http.threads_max} threads, ${http.connections} connections` +
        `${http.queued ? `, ${http.queued} queued` : ''}.`);
    if (http.refused) lines.push(`⚠ ${http.refused} connection(s) refused since the start: pool saturated.`);
  }
  lines.push('A launch waits for the schedule lock, so this is what a submission would see.');
  pill.dataset.clickTip = lines.join('\n');
}

// The pill, polled every 10 s and on every refresh of the page (pb-refresh); its details on click (tips.js)
export function HealthPill() {
  const pill = document.createElement('span');
  pill.className = 'pb-health';
  pill.textContent = '\u{26AA} scheduler';
  pill.dataset.clickTip = 'Checking the scheduler…';

  const Poll = async () => RenderHealth(pill, await FetchHealth());
  Poll();
  setInterval(Poll, 10000);
  // a page that refreshes itself also refreshes the light
  window.addEventListener('pb-refresh', () => { Poll(); });
  return pill;
}
