import './nav.js';
import { Help, helpTexts } from './help.js';
import { TaskCard } from './taskcard.js';
import { logsManager } from './logsmanager.js';
import * as Launchers from './launchers/launchers.js';

// One task, running or finished: header (commit line, state, times), actions (relaunch as template, results,
// objectives, artefacts; priority and cancel while it runs), settings (readable, then every argument as given), the
// steps as a grid (one row per step, one column per configuration, a chip per attempt), and the Scheduler's card of the
// task with every detail (monitor messages, exit codes, per-step actions).

let taskCard;
let dataUrl = null;
let taskId = null;

const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const pad = (n) => String(n).padStart(2, '0');

function GetQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function SetError(message) {
  const stat = document.getElementById('error-stat');
  stat.hidden = !message;
  document.getElementById('error-message').textContent = message ?? '';
}

async function FetchTask() {
  if (!dataUrl) {
    SetError('No data source — add ?id=<task id> (or ?data=<url>) to the address');
    return null;
  }
  let resp;
  try {
    resp = await fetch(dataUrl, { cache: 'no-store' });
  } catch (e) {
    SetError('Fetch failed: ' + e.message);
    return null;
  }
  if (!resp.ok) {
    SetError(`HTTP ${resp.status} ${resp.statusText}`);
    return null;
  }
  let json;
  try {
    json = await resp.json();
  } catch (e) {
    SetError('Invalid JSON: ' + e.message);
    return null;
  }
  if (!json.task || typeof json.task !== 'object') {
    SetError(json.error ? `Task not found: ${json.error}` : 'JSON has no top-level "task" object');
    return null;
  }
  return json.task;
}

// ── Formatting ───────────────────────────────────────────────────────────────────────────────────────────────────

function Duration(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${pad(Math.floor(seconds / 60) % 60)}`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)} min ${pad(seconds % 60)}s`;
  return `${seconds}s`;
}

function DateTime(ms) {
  const d = new Date(ms);
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Time(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const ExitLabel = (code) => ({ null: 'not set', 0: '0', 0x0100: 'not set', 0x0200: 'timed out', 0x0400: 'cancelled',
  0x0800: 'launch error' })[code] ?? String(code);

// state of an attempt for its chip
function AttemptState(step) {
  if (step.state === 'Running') return 'running';
  if (step.state === 'Pending') return 'pending';
  if (step.exit_code === 0x0200) return 'timedout';
  if (step.exit_code === 0x0400 || /cancel/i.test(step.state ?? '')) return 'cancelled';
  if (step.exit_code !== 0 && step.exit_code != null) return 'failed';
  return 'done';
}

const Times = (step) => {
  const [start, end] = step.time_points_ms ?? [];
  return { start: start || 0, end: end || 0 };
};

// ── Header ───────────────────────────────────────────────────────────────────────────────────────────────────────

const STATES = {
  running: ['▶ RUNNING', 'running'], cancelling: ['… CANCELLING', 'cancelled'], waiting: ['⏸ WAITING FOR CORES', 'pending'],
  scheduled: ['⏳ SCHEDULED', 'pending'], done: ['✔ DONE', 'done'], cancelled: ['✖ CANCELLED', 'cancelled'],
};

async function RenderHeader(task, steps) {
  const description = await Launchers.DescribeTask(task).catch(() => null);
  document.getElementById('task-title').innerHTML = description?.title ?? esc(task.name || `task ${task.id}`);
  document.title = `${(task.name || `task ${task.id}`)} · task`;

  let state = TaskCard.Status(task).state;
  const cancelled = task.request_cancel || steps.some(step => AttemptState(step) === 'cancelled');
  if (state === 'done' && cancelled) state = 'cancelled';
  const [label, cls] = STATES[state] ?? [state, ''];
  const badge = document.getElementById('task-state');
  badge.textContent = label;
  badge.className = `task-state ${cls}`;

  const starts = steps.map(step => Times(step).start).filter(Boolean);
  const ends = steps.map(step => Times(step).end).filter(Boolean);
  const start = starts.length ? Math.min(...starts) : 0;
  const finished = steps.every(step => !['running', 'pending'].includes(AttemptState(step)));
  const end = finished && ends.length ? Math.max(...ends) : 0;
  const counts = {};
  steps.forEach(step => { const s = AttemptState(step); counts[s] = (counts[s] ?? 0) + 1; });
  const parts = [`task <b>${esc(task.id)}</b>`, `<b>${esc(task.user ?? '')}</b>`];
  if (start) parts.push(`started <b>${esc(DateTime(start))}</b>` + (end ? ` → ended <b>${esc(Time(end))}</b>` : ''));
  if (start) parts.push(`<b>${esc(Duration(((end || Date.now()) - start) / 1000))}</b>${end ? '' : ' so far'}`);
  if (!end && task.estimated_end_time) parts.push(`estimated end <b>~${esc(Time(task.estimated_end_time))}</b>`);
  parts.push(`${steps.length} steps (` + Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ') + ')');
  document.getElementById('task-meta').innerHTML = parts.join(' · ');
  return { running: ['running', 'waiting', 'scheduled', 'cancelling'].includes(state) && !task.request_cancel };
}

// the objectives of the task, from the monitor summaries of its attempts (see launchers.js DescribeMonitor)
function Objectives(task, steps) {
  let count = 0;
  let link = null;
  for (const step of steps) {
    if (!step.message_from_run) continue;
    const description = Launchers.DescribeMonitor(task, step.message_from_run);
    const taskLink = description?.taskLink;
    if (taskLink?.key !== 'objectives') continue;
    count += taskLink.count ?? 0;
    link = taskLink;
  }
  return link ? { ...link, count } : null;
}

async function RenderActions(task, steps, running) {
  const box = document.getElementById('task-actions');
  box.innerHTML = '';
  const button = (text, cls, onclick, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `task-btn ${cls ?? ''}`;
    b.textContent = text;
    if (title) b.title = title;
    b.onclick = onclick;
    box.appendChild(b);
    return b;
  };
  const link = (text, href, title, download) => {
    const a = document.createElement('a');
    a.className = 'task-btn';
    a.textContent = text;
    a.href = href;
    if (title) a.title = title;
    if (download) a.download = download; else { a.target = '_blank'; a.rel = 'noopener'; }
    box.appendChild(a);
    return a;
  };

  // a task started automatically (a commit, a PR) has no launcher record: the template is rebuilt from its arguments
  // (job type, commit, campaign); the other settings are the launcher's defaults
  const argOf = key => (task.args ?? []).find(arg => arg.key === key)?.value;
  const recorded = Launchers.launchers.find(launcher => launcher.label === task.launcher?.project);
  const entry = recorded ?? Launchers.launchers.find(launcher => launcher.label === (argOf('PACKAGE') || 'tlspuffin'));
  if (entry) {
    const custom = recorded ? (task.launcher?.custom ?? null)
        : { jobType: ['vuln-a', 'vuln-b', 'perf', 'campaign'].includes(task.job_type) ? task.job_type : null,
            commit: argOf('COMMIT_ID') ?? null, campaignId: argOf('CAMPAIGN_ID') ?? '' };
    button('↻ Relaunch as template', 'primary', () => entry.open(custom), recorded
        ? 'The launcher, pre-filled with every setting of this task: edit any field, then launch'
        : 'This task was started automatically (no launcher record): the launcher with its job type and commit, the other settings at their defaults; check them, then launch');
  }
  if (task.publish_link) link('📊 Results ↗', task.publish_link, 'The published results of this task');
  // 🕘 N runs: the other tasks of the same commit and type kept by the publisher (its /html/runs/ page, written by
  // runs_report.py): shown when there are several, the index read from the publisher of the results link
  const commitId = (task.args ?? []).find(arg => arg.key === 'COMMIT_ID')?.value;
  if (task.publish_link && commitId) {
    const type = /^vuln/i.test(task.job_type ?? '') ? 'Vuln' : /^perf/i.test(task.job_type ?? '') ? 'Perf' : null;
    let origin = null;
    try { origin = new URL(task.publish_link, window.location.href).origin; } catch (error) {}
    if (type && origin) {
      const runs = link('🕘 runs', `${origin}/html/runs/runs.html#commit=${encodeURIComponent(commitId)}&tab=PR/${type}`,
          'Every task of this commit and type kept by the publisher, with the puffin-bench version of each (new tab)');
      runs.hidden = true;
      fetch(`${origin}/html/runs/index.json`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null).then(index => {
        const entry = index?.[commitId] ?? Object.entries(index ?? {}).find(([c]) => c.startsWith(commitId))?.[1];
        const count = entry?.[`PR/${type}`];
        if (count > 1) { runs.textContent = `🕘 ${count} runs`; runs.hidden = false; }
      });
    }
  }

  const objectives = Objectives(task, steps);
  if (objectives?.url) {
    const label = String(objectives.label ?? '{count} objectives').replace('{count}', objectives.count.toLocaleString('en-US'));
    const a = link(`🐞 ${label.replace(/^🎉\s*/, '')}`, objectives.url, objectives.title);
    if (objectives.pending) {
      // the final report is written a few minutes after the end of the task
      fetch(objectives.url, { cache: 'no-store' }).then(r => r.ok).catch(() => true).then(async exists => {
        if (exists) return;
        // the live page, kept until the final report is written
        const liveURL = objectives.url.replace(/\/(\d+)\.html$/, '/live-$1.html');
        if (await fetch(liveURL, { cache: 'no-store' }).then(r => r.ok).catch(() => false)) {
          a.href = liveURL;
          a.textContent = `${a.textContent} · live ⏳`;
          a.title = 'The final report is being written (within minutes of the end of the task): the live objectives page meanwhile';
          return;
        }
        a.removeAttribute('href');
        a.textContent = `🐞 ${String(objectives.pending.label).replace('{count}', objectives.count.toLocaleString('en-US')).replace(/^🎉\s*/, '')}`;
        a.title = objectives.pending.title ?? '';
      });
    }
  }
  if (taskId) link('⬇️ Artefacts', `/api/task/${taskId}/artefacts`, 'Logs, outputs of every attempt, objectives and their replay reports', `${taskId}-artefacts.tgz`);
  const copy = button('🔗 Copy link', 'ghost', async () => {
    try { await navigator.clipboard.writeText(window.location.href); copy.textContent = '✓ Copied'; }
    catch (error) { copy.textContent = 'Copy failed'; }
  });

  // a finished task: delete its archived results here and on the publisher, which merges the commit's results again
  // from its other tasks (the previous run of the same commit and type is then the one Results shows)
  if (!running && taskId) {
    button('💣 Delete', 'danger', async () => {
      if (!confirm(`Delete the results of task ${taskId}:\n\t${task.name}\n\nHere and on the publisher; Results then shows the previous run of this commit and type, if any. This cannot be undone.`)) return;
      try {
        const response = await fetch(`http://${window.location.host}/api/task/${taskId}`, { method: 'DELETE' });
        const json = await response.json();
        if (!json?.success) throw new Error(json?.error ?? `HTTP ${response.status}`);
        window.location.href = 'history.html';
      } catch (error) {
        alert(`Unable to delete task ${taskId}: ${error.message}`);
      }
    }, 'Delete this task\'s archived results, here and on the publisher (Results then shows the previous run of this commit and type). Cannot be undone.');
  }

  if (running) {
    const priority = taskCard.PriorityUI(task);
    if (priority) { priority.classList.add('task-priority'); box.appendChild(priority); }
    button('✖ Cancel', 'danger', async () => {
      if (!confirm(`Cancel task "${task.name || task.id}"?`)) return;
      await taskCard.Cancel(task.id);
      Refresh();
    }, 'Cancel the task: its running steps are stopped');
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

function RenderSettings(task) {
  const rows = [...(Launchers.DescribeSettings(task) ?? [])];
  // every argument as it was given: nothing of the task's settings is hidden by the readable form above
  const args = (task.args ?? []).filter(arg => arg?.key).map(arg => `<span class="chip mono">${esc(arg.key)}=${esc(arg.value)}</span>`);
  rows.push({ label: 'all arguments', html: args.join('') || '<span class="task-hint">none</span>', wide: true });
  document.getElementById('task-settings').innerHTML = rows.map(row =>
      `<div class="${row.wide ? 'wide' : ''}"><span class="label">${esc(row.label)}</span><span class="value">${row.html}</span></div>`).join('');
}

// ── Steps ────────────────────────────────────────────────────────────────────────────────────────────────────────

function Chip(task, step) {
  const state = AttemptState(step);
  const { start, end } = Times(step);
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `att ${state}`;
  let text = state === 'pending' ? 'pending' : state === 'running' ? `▶ ${Duration((Date.now() - start) / 1000)}`
      : Duration(((end || start) - start) / 1000);
  const monitor = step.message_from_run ? Launchers.DescribeMonitor(task, step.message_from_run) : null;
  const found = monitor?.taskLink?.key === 'objectives' ? monitor.taskLink.count : 0;
  chip.innerHTML = esc(text) + (found ? ` <b class="obj" title="objectives found by this attempt">${esc(found)}</b>` : '');
  if (monitor?.highlight) chip.classList.add(`highlight-${monitor.highlight}`);
  const summary = monitor?.summary ? monitor.summary.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
  chip.title = [`${step.name} ${step.id} · attempt ${step.attempt_id ?? 0}: ${step.state}`,
    `exit code ${ExitLabel(step.exit_code)}`, step.nb_cores ? `${step.nb_cores} cores` : '',
    start ? `${DateTime(start)}${end ? ` → ${Time(end)}` : ''}` : '', summary, 'click: its logs'].filter(Boolean).join('\n');
  chip.onclick = () => logsManager.Open(step, task.name);
  return chip;
}

function RenderSteps(task, steps) {
  const table = document.getElementById('task-steps');
  table.innerHTML = '';
  // the order of the flow (step uuids), one column per configuration
  const firstUuid = new Map();
  steps.forEach(step => { const u = Number(step.uuid ?? 0); if (!firstUuid.has(step.name) || u < firstUuid.get(step.name)) firstUuid.set(step.name, u); });
  const names = [...firstUuid.keys()].sort((a, b) => firstUuid.get(a) - firstUuid.get(b));
  const configs = [...new Set(steps.map(step => step.id).filter(id => id && id !== '.'))].sort();

  const head = table.createTHead().insertRow();
  head.appendChild(document.createElement('th'));
  configs.forEach(c => { const th = document.createElement('th'); th.textContent = c; head.appendChild(th); });
  if (!configs.length) { const th = document.createElement('th'); head.appendChild(th); }
  const body = table.createTBody();
  for (const name of names) {
    const row = body.insertRow();
    const th = document.createElement('th');
    th.textContent = name;
    row.appendChild(th);
    const ofName = steps.filter(step => step.name === name).sort((a, b) => (a.attempt_id ?? 0) - (b.attempt_id ?? 0));
    if (ofName.every(step => !step.id || step.id === '.') || !configs.length) {
      const cell = row.insertCell();
      cell.colSpan = Math.max(1, configs.length);
      ofName.forEach(step => cell.appendChild(Chip(task, step)));
      continue;
    }
    for (const c of configs) {
      const cell = row.insertCell();
      ofName.filter(step => step.id === c).forEach(step => cell.appendChild(Chip(task, step)));
    }
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function Refresh() {
  SetError(null);
  const task = await FetchTask();
  const page = document.getElementById('task');
  if (!task) { page.hidden = true; return; }
  page.hidden = false;
  const steps = Object.values(task.steps ?? {});
  const { running } = await RenderHeader(task, steps);
  await RenderActions(task, steps, running);
  RenderSettings(task);
  RenderSteps(task, steps);

  // the Scheduler's card of the task, unfolded: every detail the grid summarizes
  const container = document.getElementById('container-running-steps');
  container.innerHTML = '';
  container.appendChild(taskCard.Create(task));
  container.querySelectorAll('.card-step').forEach(step => {
    step.classList.remove('collapsed');
    const icon = step.querySelector('.card-step-toggle');
    if (icon) icon.innerText = '➖';
  });
}

function Main() {
  new Help(helpTexts);
  window.addEventListener('pb-refresh', (event) => { event.preventDefault(); Refresh(); });
  taskId = GetQueryParam('id');
  dataUrl = taskId ? `/api/task/${taskId}/state` : GetQueryParam('data');
  taskCard = new TaskCard({ onRefresh: Refresh, launchers: Launchers.launchers, describeTask: Launchers.DescribeTask,
    describeMonitor: Launchers.DescribeMonitor });
  Refresh();
}

Main();
