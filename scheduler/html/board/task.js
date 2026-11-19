import { ShowSchedulerHealth } from './frame.js';
import { Help, helpTexts } from './help.js';
import { TaskCard, ResultsLink, TaskLinkElement } from './taskcard.js';
import { logsManager } from './logsmanager.js';
import * as Plugins from './plugins.js';

// the status light of this scheduler in the top bar
ShowSchedulerHealth();

// One task, running or finished: header (title of its project, state, times), actions (relaunch as template, results,
// the buttons and links of its project, artefacts; priority and cancel while it runs), settings (readable, then every
// argument as given), the
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
  const description = await Plugins.DescribeTask(task).catch(() => null);
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

// the buttons of the task gathered from the monitor summaries of its attempts (see plugins.js DescribeMonitor): one per
// key, its count summed over the attempts
function TaskLinks(task, steps) {
  const links = new Map();
  for (const step of steps) {
    if (!step.message_from_run) continue;
    const taskLink = Plugins.DescribeMonitor(task, step.message_from_run)?.taskLink;
    if (!taskLink?.key) continue;
    const known = links.get(taskLink.key);
    if (known) {
      known.count += taskLink.count ?? 0;
      known.url ??= taskLink.url;
    } else {
      links.set(taskLink.key, { ...taskLink, count: taskLink.count ?? 0 });
    }
  }
  return [...links.values()];
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

  // the launcher the task was started with, pre-filled with its settings; a task started otherwise (no launcher
  // record): the template its project rebuilds from its arguments
  const recorded = Plugins.launchers.find(launcher => launcher.label === task.launcher?.project);
  const rebuilt = recorded ? null : Plugins.TaskRelaunch(task);
  if (recorded || rebuilt) {
    const entry = recorded ?? rebuilt.launcher;
    const custom = recorded ? (task.launcher?.custom ?? null) : (rebuilt.custom ?? null);
    button('↻ Relaunch as template', 'primary', () => entry.open(custom), recorded
        ? 'The launcher, pre-filled with every setting of this task: edit any field, then launch'
        : (rebuilt.title || 'The launcher with the settings its project could read from this task; check them, then launch'));
  }
  if (task.publish_link && !task.cancelled) link('📊 Results ↗', ResultsLink(task), 'The published results of this task: its card on Results, marked');
  // more links of its project (plugins.js TaskLinks)
  for (const item of Plugins.TaskLinks(task, steps)) {
    if (!item?.url) continue;
    const a = link(item.label ?? '', item.url, item.title);
    a.hidden = !!item.hidden;
    if (typeof item.update === 'function') {
      Promise.resolve().then(() => item.update(a)).catch(error => console.warn('task.links update', error));
    }
  }
  // the buttons gathered from the monitor summaries of its attempts (e.g. a page of the project about the task)
  for (const taskLink of TaskLinks(task, steps)) {
    if (taskLink.url) box.appendChild(TaskLinkElement(taskLink, 'task-btn'));
  }
  if (taskId) link('⬇️ Artefacts', `/api/task/${taskId}/artefacts`, 'Logs and outputs of every attempt', `${taskId}-artefacts.tgz`);
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
  const rows = [...(Plugins.DescribeSettings(task) ?? [])];
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
  const monitor = step.message_from_run ? Plugins.DescribeMonitor(task, step.message_from_run) : null;
  // the badge of its project (e.g. what the attempt found)
  const badge = monitor?.badge?.text ? ` <b class="badge" title="${esc(monitor.badge.title ?? '')}">${esc(monitor.badge.text)}</b>` : '';
  chip.innerHTML = esc(text) + badge;
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
  new Help({ ...helpTexts, ...Plugins.helpTexts });
  window.addEventListener('pb-refresh', (event) => { event.preventDefault(); Refresh(); });
  taskId = GetQueryParam('id');
  dataUrl = taskId ? `/api/task/${taskId}/state` : GetQueryParam('data');
  taskCard = new TaskCard({ onRefresh: Refresh, launchers: Plugins.launchers, describeTask: Plugins.DescribeTask,
    describeMonitor: Plugins.DescribeMonitor });
  Refresh();
}

Main();
