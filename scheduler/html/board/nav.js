// Navigation bar on top of every page of the bench: the scheduler board, History, Results (publisher),
// Analyzer (comparator), each one click away, the package shown by Results and Analyzer, a refresh button and
// the help.
// Refresh: the bar sends a cancelable "pb-refresh" event on window; a page with its own refresh handles it and
// calls preventDefault(), otherwise the page is reloaded. A page may color the button by sending
// "pb-refresh-state" with { detail: { level: 'gold' | '', title } } (e.g. a refresh that costs GitHub credits).
// Help (❔ or the ? key): a panel with the help of this page (its <template id="help-panel">, read when the panel
// opens) and the guide of the bench (navhelp.js).
// Keys, on every page: Cmd/Ctrl+R = 🔄 (Shift for the browser's reload); g then s / r / a / h = Scheduler, Results,
// Analyzer, History; Esc closes the topmost popup. A popup handles Cmd/Ctrl+R and Esc through cancelable events on
// window, sent from the top layer down until one calls preventDefault(): "pb-escape" with { detail: { layer } },
// layer 'modal' (logs, launcher) then 'panel' (drawer, unfolded panels), and "pb-modal-refresh" (e.g. the logs
// window refreshes its logs instead of the page). A key a page already handled (defaultPrevented) is left alone.
// A page includes it once, as its first script: <script type="module" src="…/board/nav.js"></script>; it also
// makes the links to this machine follow the address typed in the browser (hostlinks.js).
// The links use the host of the page and the default ports of the services.
import './hostlinks.js';
// one look for every hover of the bench (tips.js)
import './tips.js';

const ports = { scheduler: '10082', publisher: '10083', comparator: '10084' };
const packages = ['tlspuffin', 'sshpuffin'];

const host = window.location.hostname;
const Base = (port) => `${window.location.protocol}//${host}:${port}`;

// the package of a Results or Analyzer page (/files/<package>…), otherwise the first one
function CurrentPackage() {
  const match = window.location.pathname.match(/^\/files\/([^/]+)/);
  return match && packages.includes(match[1]) ? match[1] : packages[0];
}

const services = [
  { id: 'scheduler', key: 's', label: '🗓️ Scheduler', url: () => `${Base(ports.scheduler)}/files/board/board.html` },
  { id: 'results', key: 'r', label: '🗂️ Results', url: (pkg) => `${Base(ports.publisher)}/files/${pkg}` },
  { id: 'analyzer', key: 'a', label: '🔬 Analyzer', url: (pkg) => `${Base(ports.comparator)}/files/${pkg}/index.html` },
  { id: 'history', key: 'h', label: '📰 History', url: () => `${Base(ports.scheduler)}/files/board/history.html` },
];

// the service of this page; the objectives pages belong to Results
function CurrentService() {
  const { port, pathname } = window.location;
  if (pathname.includes('/objectives/')) return 'results';
  if (port === ports.publisher) return 'results';
  if (port === ports.comparator) return 'analyzer';
  if (pathname.endsWith('/history.html')) return 'history';
  return 'scheduler';
}

const style = `
.pb-nav { position: sticky; top: 0; z-index: 1000; flex: 0 0 34px; height: 34px; display: flex; align-items: center;
  gap: 2px; padding: 0 10px; background: #0a0a0a; border-bottom: 1px solid #262626; overflow-x: auto; white-space: nowrap;
  font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #e8e8e8; box-sizing: border-box; }
.pb-nav * { box-sizing: border-box; }
.pb-nav .pb-brand { font-weight: 700; margin-right: 14px; }
.pb-nav .pb-version { font: 400 11px ui-monospace, Menlo, monospace; color: #8b8b8b; text-decoration: none; }
.pb-nav .pb-version:hover { color: #58a6ff; text-decoration: underline; }
.pb-nav a.pb-item { color: #c9c9c9; padding: 6px 12px; border-radius: 6px; text-decoration: none; line-height: 1.2; }
.pb-nav a.pb-item:hover { background: #1c1c1c; text-decoration: none; }
.pb-nav a.pb-item.on { color: #fff; background: #1f2937; box-shadow: inset 0 -2px 0 #58a6ff; }
.pb-nav .pb-package { margin-left: auto; display: flex; gap: 6px; align-items: center; color: #8b8b8b; }
.pb-nav select { background: #161616; color: #e8e8e8; border: 1px solid #333; border-radius: 5px; padding: 2px 6px; font: inherit; }
.pb-nav .pb-btn { margin-left: 4px; width: 28px; height: 24px; padding: 0; border: 1px solid #333; border-radius: 6px;
  background: #161616; color: #e8e8e8; font-size: 14px; line-height: 1; cursor: pointer; }
.pb-nav .pb-btn:hover { background: #1f2937; border-color: #58a6ff; }
.pb-nav .pb-btn.on { background: #1f2937; border-color: #58a6ff; }
.pb-nav .pb-btn.gold { background: #ffc400; border-color: #ffc400; }
.pb-nav .pb-btn.spin { animation: pb-spin .6s linear; }
.pb-nav .pb-health { margin-left: 10px; display: flex; gap: 4px; align-items: center; padding: 2px 7px;
  border: 1px solid #333; border-radius: 999px; background: #161616; font-size: 11px; color: #8b8b8b;
  cursor: default; }
.pb-nav .pb-health.down { border-color: #a33; color: #ff9b9b; }
.pb-nav .pb-health.warn { border-color: #a97; color: #ffd089; }
.pb-nav a.pb-live { margin-left: 12px; padding: 3px 11px; border-radius: 999px; background: #ffc400; color: #1a1a1a;
  font-weight: 700; text-decoration: none; line-height: 1.2; }
.pb-nav a.pb-live:hover { background: #ffd54d; text-decoration: none; }
.pb-nav a.pb-live.unconfirmed { background: transparent; color: #ffb74d; border: 1px solid #f08c00; }
@keyframes pb-spin { to { transform: rotate(360deg); } }

.pb-help { position: fixed; z-index: 1001; top: 34px; right: 0; bottom: 0; width: min(620px, 100vw); display: none;
  flex-direction: column; background: #111; color: #e0e0e0; border-left: 1px solid #333; box-shadow: -8px 0 24px #000a;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; box-sizing: border-box; }
.pb-help.open { display: flex; }
.pb-help * { box-sizing: border-box; }
.pb-help .pb-help-tabs { display: flex; align-items: center; gap: 4px; padding: 6px 10px; border-bottom: 1px solid #262626; }
.pb-help .pb-help-tabs button { padding: 3px 12px; border: 1px solid #333; border-radius: 999px; background: transparent;
  color: #bbb; font: inherit; cursor: pointer; }
.pb-help .pb-help-tabs button.on { background: #1d2a52; border-color: #4b6bd6; color: #fff; }
.pb-help .pb-help-tabs .pb-help-close { margin-left: auto; border: none; font-size: 15px; }
.pb-help .pb-help-body { flex: 1; overflow: auto; padding: 4px 16px 24px; }
.pb-help h2 { font-size: 14px; color: #fff; margin: 16px 0 4px; border-bottom: 1px solid #262626; padding-bottom: 2px; }
.pb-help h3, .pb-help h4 { font-size: 13px; color: #ddd; margin: 10px 0 2px; }
.pb-help p { margin: 4px 0; }
.pb-help ul { margin: 4px 0; padding-left: 20px; }
.pb-help li { margin: 2px 0; }
.pb-help code, .pb-help kbd { font: 12px ui-monospace, Menlo, monospace; background: #1f1f1f; border: 1px solid #2a2a2a;
  border-radius: 4px; padding: 0 4px; }
.pb-help table { border-collapse: collapse; margin: 4px 0; width: 100%; }
.pb-help th, .pb-help td { text-align: left; padding: 2px 6px; border-bottom: 1px solid #222; vertical-align: top; }
.pb-help th { color: #8b8b8b; font-weight: 600; }
.pb-help a { color: #58a6ff; }
.pb-help .pb-help-none { color: #8b8b8b; font-style: italic; margin-top: 12px; }
`;

// Status light of the scheduler, on every page: the board, Results and the Analyzer all submit or read
// through it, and when it stops answering the launcher used to fail with an opaque
// "no answer from the scheduler (NetworkError)".
// It polls /api/health, which (unlike /api/tasks/running, that only reads the state file) takes the
// schedule lock -- the very lock a submission waits for -- and reports the HTTP thread pool, so a
// saturated pool is visible instead of silent.
const healthStates = {
  up: { dot: '\u{1F7E2}', text: 'scheduler' },
  slow: { dot: '\u{1F7E0}', text: 'slow', cls: 'warn' },
  busy: { dot: '\u{1F7E0}', text: 'busy', cls: 'warn' },
  down: { dot: '\u{1F534}', text: 'no answer', cls: 'down' },
};

let lastHealth = null;

// Reads the health once. Returns the parsed state, or a "down" state when the scheduler does not answer.
async function FetchHealth() {
  try {
    // a deadline: a scheduler whose HTTP threads are all taken accepts the connection and never answers; without it
    // the probes piled up and the light never turned "down"
    const response = await fetch(`${Base(ports.scheduler)}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
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

// Reads the health now, for a page that is about to submit (the launcher).
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
    lines.push(`No answer from the scheduler on port ${ports.scheduler}${health.error ? ` (${health.error})` : ''}.`);
  } else if (health.legacy) {
    lines.push('The scheduler answers (this version cannot report its load).');
  } else {
    lines.push(`Schedule lock taken in ${health.lock_wait_ms} ms${health.lock_taken ? '' : ' (timed out)'}.`);
  }
  const http = health.http;
  if (http) {
    lines.push(`HTTP: ${http.threads}/${http.threads_max} threads, ${http.connections} connections` +
        `${http.queued ? `, ${http.queued} queued` : ''}.`);
    if (http.refused) lines.push(`\u26A0 ${http.refused} connection(s) refused since the start: pool saturated.`);
  }
  lines.push('A launch waits for the schedule lock, so this is what a submission would see.');
  pill.dataset.clickTip = lines.join('\n');
}

function Health(nav) {
  const pill = document.createElement('span');
  pill.className = 'pb-health';
  pill.textContent = '\u{26AA} scheduler';
  pill.dataset.clickTip = 'Checking the scheduler\u2026';
  nav.appendChild(pill);

  const Poll = async () => RenderHealth(pill, await FetchHealth());
  Poll();
  setInterval(Poll, 10000);
  // a page that refreshes itself also refreshes the light
  window.addEventListener('pb-refresh', () => { Poll(); });
  return pill;
}

// Objectives found by running tasks (objectives/live.json, written every 5 minutes by objectives_live.sh): a yellow
// pill next to the services, to the live objectives page. VulnA/VulnB tasks look for known bugs: their objectives
// are expected and not announced. Outlined while no replay confirmed a bug.
const objectivesExpected = new Set(['vuln-a', 'vuln-b']);

function LiveObjectives(nav, after) {
  const pill = document.createElement('a');
  pill.className = 'pb-live';
  pill.hidden = true;
  pill.href = `${Base(ports.publisher)}/html/objectives/live.html`;
  pill.target = '_blank';
  pill.rel = 'noopener';
  after.after(pill);

  const Poll = async () => {
    try {
      const response = await fetch(`${Base(ports.publisher)}/html/objectives/live.json`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const tasks = ((await response.json())?.tasks ?? []).filter(task => !objectivesExpected.has(task.job_type));
      const bugs = tasks.reduce((sum, task) => sum + (task.bugs ?? 0), 0);
      pill.hidden = tasks.length === 0;
      pill.classList.toggle('unconfirmed', bugs === 0);
      pill.textContent = bugs > 0 ? `\u{1F41E} ${bugs} bug${bugs > 1 ? 's' : ''} found live (${tasks.length} task${tasks.length > 1 ? 's' : ''})`
          : `\u{1F41E} live objectives (${tasks.length} task${tasks.length > 1 ? 's' : ''}, none confirmed)`;
      pill.title = ['Running tasks with objectives (not VulnA/VulnB), replayed and grouped by bug:',
          ...tasks.map(task => `${task.name}: ${task.found} found, ${task.bugs ?? 0} bug(s)`), 'Click: live objectives page']
          .join('\n');
    } catch (error) {
      pill.hidden = true;
    }
  };
  Poll();
  setInterval(Poll, 60000);
  window.addEventListener('pb-refresh', () => { Poll(); });
}

// the deployed version of the bench, written by deploy.sh next to this script: the first characters of its
// commit, linked to the commit in the repository (branch, date and deployment time in the hover)
async function Version(brand) {
  try {
    const response = await fetch(new URL('version.json', import.meta.url), { cache: 'no-cache' });
    if (!response.ok) return;
    const version = await response.json();
    if (!/^[0-9a-f]{40}$/.test(version.commit ?? '')) return;
    const link = document.createElement('a');
    link.className = 'pb-version';
    link.href = `${version.repository ?? 'https://github.com/tlspuffin/puffin-bench'}/commit/${version.commit}`;
    link.target = '_blank';
    link.textContent = version.commit.slice(0, 3) + (version.dirty ? '+' : '');
    link.title = `puffin-bench ${version.commit.slice(0, 10)} on ${version.branch ?? '?'} (${version.date ?? '?'})` +
        (version.dirty ? ', with local changes' : '') + (version.deployed ? `, deployed ${version.deployed}` : '');
    brand.append(' ', link);
  } catch {
    // no version file (not deployed with deploy.sh): no version shown
  }
}

// ── Help panel ──────────────────────────────────────────────────────────────────────────────────────────────
let helpPanel = null;
let helpTab = 'page';

async function ToggleHelp(button, open = null) {
  if (!helpPanel) {
    helpPanel = document.createElement('aside');
    helpPanel.className = 'pb-help';
    helpPanel.setAttribute('aria-label', 'Help');
    helpPanel.innerHTML = `<div class="pb-help-tabs">
        <button type="button" data-tab="page">This page</button>
        <button type="button" data-tab="bench">puffin-bench guide</button>
        <button type="button" class="pb-help-close" title="Close (Esc)">✕</button>
      </div><div class="pb-help-body"></div>`;
    helpPanel.querySelectorAll('[data-tab]').forEach(tab => {
      tab.onclick = () => { helpTab = tab.dataset.tab; RenderHelp(); };
    });
    helpPanel.querySelector('.pb-help-close').onclick = () => ToggleHelp(button, false);
    document.body.appendChild(helpPanel);
  }
  const show = open ?? !helpPanel.classList.contains('open');
  helpPanel.classList.toggle('open', show);
  button.classList.toggle('on', show);
  if (show) await RenderHelp();
}

async function RenderHelp() {
  helpPanel.querySelectorAll('[data-tab]').forEach(tab => tab.classList.toggle('on', tab.dataset.tab === helpTab));
  const body = helpPanel.querySelector('.pb-help-body');
  if (helpTab === 'page') {
    const template = document.getElementById('help-panel');
    if (template) {
      body.replaceChildren(template.content.cloneNode(true));
    } else {
      body.innerHTML = '<p class="pb-help-none">No help for this page: see the puffin-bench guide.</p>';
    }
  } else {
    try {
      const { benchGuide } = await import('./navhelp.js');
      body.innerHTML = benchGuide;
    } catch (error) {
      body.textContent = `The guide could not be loaded: ${error.message}`;
    }
  }
  body.scrollTop = 0;
}

function Build() {
  // the page is already shown under a bar (in a frame of the bench)
  if (window.self !== window.top || document.querySelector('.pb-nav')) return;
  const service = CurrentService();
  let pkg = CurrentPackage();

  const css = document.createElement('style');
  css.textContent = style;
  document.head.appendChild(css);

  const nav = document.createElement('nav');
  nav.className = 'pb-nav';
  const brand = document.createElement('span');
  brand.className = 'pb-brand';
  brand.textContent = '🐡 puffin-bench';
  nav.appendChild(brand);
  Version(brand);

  const links = services.map(s => {
    const link = document.createElement('a');
    link.className = `pb-item ${s.id === service ? 'on' : ''}`;
    link.textContent = s.label;
    link.title = `${s.label.replace(/^\S+\s/, '')} (keys: g then ${s.key})`;
    link.href = s.url(pkg);
    nav.appendChild(link);
    return link;
  });

  LiveObjectives(nav, links[links.length - 1]);

  const label = document.createElement('label');
  label.className = 'pb-package';
  label.title = 'Package shown by Results and Analyzer';
  label.append('package');
  const select = document.createElement('select');
  for (const name of packages) select.add(new Option(name, name));
  select.value = pkg;
  select.onchange = () => {
    pkg = select.value;
    services.forEach((s, i) => { links[i].href = s.url(pkg); });
    // on a page of a package, show the other package
    if (['results', 'analyzer'].includes(service) && !window.location.pathname.includes('/objectives/')) {
      window.location.href = services.find(s => s.id === service).url(pkg);
    }
  };
  label.appendChild(select);
  nav.appendChild(label);

  Health(nav);

  // refresh: the page's own refresh (pb-refresh event), or a reload
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'pb-btn';
  refresh.textContent = '🔄';
  refresh.title = 'Refresh this page (Cmd/Ctrl+R)';
  refresh.onclick = () => {
    refresh.classList.remove('spin');
    void refresh.offsetWidth;
    refresh.classList.add('spin');
    const event = new CustomEvent('pb-refresh', { cancelable: true });
    window.dispatchEvent(event);
    if (!event.defaultPrevented) window.location.reload();
  };
  window.addEventListener('pb-refresh-state', (event) => {
    refresh.classList.toggle('gold', event.detail?.level === 'gold');
    refresh.title = `${event.detail?.title || 'Refresh this page'} (Cmd/Ctrl+R)`;
  });
  nav.appendChild(refresh);

  const help = document.createElement('button');
  help.type = 'button';
  help.className = 'pb-btn';
  help.textContent = '❔';
  help.title = 'Help: this page and the bench (?)';
  help.onclick = () => ToggleHelp(help);
  nav.appendChild(help);
  // on window, after the page's own handlers (document): a key they handled is left alone
  let goPending = 0;
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    const command = event.metaKey || event.ctrlKey;
    // Cmd/Ctrl+R: the logs window (or another popup) first, else 🔄; with Shift, the browser's reload
    if (command && !event.shiftKey && !event.altKey && (event.key.toLowerCase() === 'r')) {
      event.preventDefault();
      const modal = new CustomEvent('pb-modal-refresh', { cancelable: true });
      window.dispatchEvent(modal);
      if (!modal.defaultPrevented) refresh.click();
      return;
    }
    if (event.key === 'Escape') {
      if (helpPanel?.classList.contains('open')) { ToggleHelp(help, false); return; }
      for (const layer of ['modal', 'panel']) {
        const escape = new CustomEvent('pb-escape', { cancelable: true, detail: { layer } });
        window.dispatchEvent(escape);
        if (escape.defaultPrevented) break;
      }
      // out of a text field
      if (event.target.closest?.('input, textarea, select, [contenteditable]')) event.target.blur();
      return;
    }
    if (command || event.altKey || event.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (event.key === '?') {
      event.preventDefault();
      ToggleHelp(help);
    } else if (event.key === 'g') {
      goPending = Date.now();
    } else if (goPending && (Date.now() - goPending < 1500)) {
      goPending = 0;
      const index = services.findIndex(s => s.key === event.key);
      if (index >= 0) {
        event.preventDefault();
        window.location.href = links[index].href;
      }
    } else {
      goPending = 0;
    }
  });

  document.body.prepend(nav);
  // for the sticky headers of the pages: top: var(--pb-nav-height, 0px)
  document.documentElement.style.setProperty('--pb-nav-height', '34px');
}

if (document.body) Build();
else document.addEventListener('DOMContentLoaded', Build);
