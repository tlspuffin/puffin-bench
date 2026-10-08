import './nav.js';
import { Help, helpTexts } from './help.js';
import { TaskCard } from './taskcard.js';
import { OpenClickTip } from './tips.js';
import * as Launchers from './launchers/launchers.js';

let taskCard;

function DisableUI() {
  document.body.setAttribute('inert', '');
  document.body.setAttribute('aria-busy', 'true');
}

function EnableUI() {
  document.body.removeAttribute('inert');
  document.body.removeAttribute('aria-busy');
}

async function GetServerStatus() {
  var response = await fetch(`http://${window.location.host}/api/tasks/running`);
  if (!response.ok) {
    return [ false, [] ];
  }
  var data = await response.json();
  if (!data.success) {
    return [ data.error === 'Server can\'t read schedule status', [] ];
  }
  return [ true, data.data.tasksmanager.tasks, data.data.executors ];
}

// thresholds of the bar colours (orange, red): 50 / 80 % by default; the disks: 80 / 90 %
function CreateMetric(label, value, perCores, helpKey, thresholds = [50, 80]) {
  const metric = document.createElement('div');
  metric.classList.add('executor-stat-metric');

  const lbl = document.createElement('div');
  lbl.classList.add('executor-stat-label');
  if (helpKey) {
    lbl.dataset.help = helpKey;
  }
  lbl.textContent = label;

  const bar = document.createElement('div');
  bar.classList.add('exec-bar');
  const fill = document.createElement('div');
  fill.classList.add('exec-bar-fill');
  fill.style.width = Math.min(value, 100) + '%';
  if (value > thresholds[1]) fill.classList.add('high');
  else if (value > thresholds[0]) fill.classList.add('medium');
  bar.appendChild(fill);

  const val = document.createElement('div');
  val.classList.add('executor-stat-value');
  val.textContent = value + '%';

  metric.append(lbl, bar, val);

  // Tooltip per-core on CPU bar
  if (perCores && perCores.length > 0) {
    const tooltip = document.getElementById('exec-tooltip');

    bar.addEventListener('mouseenter', (e) => {
      tooltip.innerHTML = '';

      const ROW_HEIGHT_PX = 18;
      const availableHeight = window.innerHeight - e.clientY - 24;
      const MAX_ROWS = Math.max(1, Math.floor(availableHeight / ROW_HEIGHT_PX));
      const cols = Math.ceil(perCores.length / MAX_ROWS);
      const rows = Math.ceil(perCores.length / cols);
      tooltip.style.gridTemplateRows = `repeat(${rows}, auto)`;

      perCores.forEach((load, i) => {
        const row = document.createElement('div');
        row.classList.add('tooltip-core-row');

        const coreLbl = document.createElement('div');
        coreLbl.classList.add('tooltip-core-label');
        coreLbl.textContent = `Core ${i}`;

        const coreBar = document.createElement('div');
        coreBar.classList.add('tooltip-core-bar');
        const coreFill = document.createElement('div');
        coreFill.classList.add('tooltip-core-fill');
        coreFill.style.width = Math.min(load, 100) + '%';
        if (load > 80) coreFill.classList.add('high');
        else if (load > 50) coreFill.classList.add('medium');
        coreBar.appendChild(coreFill);

        const coreVal = document.createElement('div');
        coreVal.classList.add('tooltip-core-value');
        coreVal.textContent = load + '%';

        row.append(coreLbl, coreBar, coreVal);
        tooltip.appendChild(row);
      });
      tooltip.classList.add('visible');
    });

    bar.addEventListener('mousemove', (e) => {
      const rect = tooltip.getBoundingClientRect();
      const left = (e.clientX + 12 + rect.width > window.innerWidth)
          ? e.clientX - rect.width - 12 : e.clientX + 12;
      tooltip.style.left = left + 'px';
      tooltip.style.top  = (e.clientY + 12) + 'px';
    });

    bar.addEventListener('mouseleave', () => {
      tooltip.classList.remove('visible');
    });
  }

  return metric;
}

// Counters of tasks: running and queued from the board's tasks (steps in the hover), done from the History DB
function SetHeader(counters, executors) {
  const set = (id, value, title) => {
    const element = document.getElementById(id);
    element.innerText = value;
    if (title) element.title = title;
  };
  set('running-count', counters.tasks.running,
      `${counters.tasks.running} task(s) with a step running: ${counters.steps['Running'] ?? 0} running step(s)`);
  set('queued-count', counters.tasks.queued,
      `${counters.tasks.queued} task(s) waiting for cores or scheduled: ${counters.steps['Pending'] ?? 0} pending step(s)`);
  DoneCounters();
  const lastUpdate = document.getElementById('last-update');
  lastUpdate.innerText = new Date().toLocaleTimeString("fr-FR");
  lastUpdate.title = new Date().toLocaleString("fr-FR");

  const container = document.getElementById('executors-stats');
  container.innerHTML = '';
  if (!executors) return;
  executors.forEach(executor => {
    const row = document.createElement('div');
    row.classList.add('executor-stat-row');

    const name = document.createElement('div');
    name.classList.add('executor-stat-name');
    name.textContent = executor.name;

    const storages = document.createElement('div');
    storages.classList.add('executor-stat-storages');
    Object.entries(executor.stats.storage ?? {}).forEach(([label, storage]) => {
        const usedPercentage = Math.round((storage.capacity - storage.available) / storage.capacity * 100);
        const metric = CreateMetric(label, usedPercentage, null, 'board.storage', [80, 90]);
        DiskDetails(metric, executor, label, storage, usedPercentage);
        storages.appendChild(metric);
    });
    const mem = CreateMetric('MEM', executor.stats.load_memory, null, 'board.mem');
    // a small window on click (the box cursor): the use, and the machine's RAM once the scheduler reports it
    mem.dataset.clickTip = `Memory used: ${executor.stats.load_memory} %`
        + (executor.stats.memory_total ? ` of ${Size(executor.stats.memory_total)} (the machine's RAM)` : '')
        + (executor.stats.memory_minimum ? `\nNew steps start only with ${Size(executor.stats.memory_minimum)} free (memMinimumRatio)` : '');
    row.append(name, 
        CreateMetric('CPU', executor.stats.load_cores, executor.stats.load_per_core, 'board.cpu'), 
        CoresMax(executor),
        mem,
        storages
    );
    // new steps wait for disk space: in red on the row
    if (executor.disk_blocked) {
      const warning = document.createElement('span');
      warning.className = 'disk-blocked';
      warning.textContent = `⚠ new steps wait: less than ${Size(executor.disk_minimum)} free on disk`;
      warning.dataset.clickTip = `New steps wait until ${Size(executor.disk_minimum)} are free on the run and export storage (diskMinimumGB); running steps go on.\nClick the disk bar: remove the folders of tasks that no longer exist.`;
      row.appendChild(warning);
    }
    container.appendChild(row);
  });
}

// Done < 12 h and Done: finished tasks of the History DB (every user and job type), by their end time
async function DoneCounters() {
  const base = `http://${window.location.host}/api`;
  const get = async (url) => { const json = await (await fetch(url, { cache: 'no-store' })).json(); return json?.success ? json.data : []; };
  try {
    const users = await get(`${base}/users`);
    const types = (await Promise.all(users.map(async user => (await get(`${base}/user/${user}/job_types`)).map(type => [user, type])))).flat();
    const tasks = (await Promise.all(types.map(([user, type]) => get(`${base}/user/${user}/${type}/tasks`)))).flat()
        .filter(task => !task.running);
    const since = Date.now() - 12 * 3600 * 1000;
    const recent = tasks.filter(task => (task.end_timestamp ?? 0) >= since);
    const cancelled = recent.filter(task => task.cancelled).length;
    const set = (id, value, title) => { const e = document.getElementById(id); e.innerText = value; e.title = title; };
    set('done12-count', recent.length, `${recent.length} task(s) ended in the last 12 hours` + (cancelled ? `, ${cancelled} of them cancelled` : '') + ' (History)');
    set('done-count', tasks.length, `${tasks.length} finished task(s) in the History`);
  } catch (error) {
    for (const id of ['done12-count', 'done-count']) document.getElementById(id).title = `History not available: ${error.message}`;
  }
}

// Folds (true) or unfolds (false) the steps of every task; 'active': unfolds only the steps running an attempt
function FoldAll(fold) {
  document.querySelectorAll('#container-running-steps .card-step').forEach(step => {
      const folded = (fold === 'active') ? (step.dataset.active !== 'true') : fold;
      step.classList.toggle('collapsed', folded);
      const icon = step.querySelector('.card-step-toggle');
      if (icon) icon.innerText = folded ? '➕' : '➖';
  });
}

async function RefreshBoard() {
  DisableUI();
  const [success, tasks, executors] = await GetServerStatus();
  EnableUI();
  if (!success) {
    return;
  }
  // running tasks first, then the ones waiting for cores, then the scheduled ones; by priority within each
  const rank = { cancelling: 0, running: 0, waiting: 1, scheduled: 2, done: 3 };
  // the status of a task walks all its steps: computed once per task, not in every comparison
  const order = new Map(tasks.map(task => [task, rank[TaskCard.Status(task).state]]));
  tasks.sort((a, b) => (order.get(a) - order.get(b)) || (b.priority - a.priority) || (a.id - b.id));
  document.getElementById('container-running-steps').innerHTML = '';
  const stateCount = { steps: {}, tasks: { running: 0, queued: 0 } };
  tasks.forEach((task, _) => {
      Object.entries(task.steps).forEach(([_, step]) => {
          stateCount.steps[step.state] = (stateCount.steps[step.state] ?? 0) + 1;
      });
      const state = TaskCard.Status(task).state;
      if (state === 'running' || state === 'cancelling') stateCount.tasks.running++;
      else if (state === 'waiting' || state === 'scheduled') stateCount.tasks.queued++;
      document.getElementById('container-running-steps').appendChild(taskCard.Create(task));
  });
  SetHeader(stateCount, executors);
}

function Main() {
  // hovers of the outlined elements; the help panel and the refresh are in the top bar (nav.js)
  new Help(helpTexts);
  window.addEventListener('pb-refresh', (event) => { event.preventDefault(); RefreshBoard(); });

  fetch('custom/header.html')
    .then(response => response.text())
    .then(data => {
      document.getElementById('custom_header').innerHTML = data;
    });

  taskCard = new TaskCard({ onRefresh: RefreshBoard, launchers: Launchers.launchers, describeTask: Launchers.DescribeTask,
    describeMonitor: Launchers.DescribeMonitor });

  document.getElementById('fold-button').onclick = () => FoldAll(true);
  document.getElementById('unfold-button').onclick = () => FoldAll(false);
  document.getElementById('unfold-active-button').onclick = () => FoldAll('active');

  RefreshBoard();
}

Launchers.BuildUI();
Main();

// #launch=<project>&job=<job type>&commit=<sha>: the launcher of that project opened pre-filled (Results' "no Perf run")
{
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const project = params.get('launch');
  const entry = project && Launchers.launchers.find(launcher => launcher.label === project);
  if (entry) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    entry.open({ jobType: params.get('job') || null, commit: params.get('commit') || null });
  }
}

// ── Maximum of cores ─────────────────────────────────────────────────────────────────────────────────────────
// "cores 12 / 32 · change max": the cores used by the steps and their maximum (the default of the configuration, or
// a temporary one, in orange with its end); the button opens a small window to set a temporary maximum: more cores
// let more steps start, fewer kill nothing (running steps keep their cores, the next ones follow the new maximum);
// the default comes back at the end of the duration (PATCH /api/executor/<name>/max_cores/<max>/<seconds>)
function CoresMax(executor) {
  const box = document.createElement('div');
  box.className = 'cores-max';
  if (executor.nb_cores_default === undefined) return box;  // a scheduler without the feature
  const temporary = executor.nb_cores_until > 0;
  const until = temporary ? new Date(executor.nb_cores_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const text = document.createElement('span');
  text.className = `cores-max-text${temporary ? ' temporary' : ''}`;
  text.textContent = `cores ${executor.nb_cores_used ?? '?'} / ${executor.nb_cores}${temporary ? ` until ${until}` : ''}`;
  text.dataset.clickTip = `Cores used by the steps / their maximum\nmaximum: ${executor.nb_cores}${temporary ? ` (temporary, until ${new Date(executor.nb_cores_until).toLocaleString()})` : ' (the default)'}`
      + `\ndefault: ${executor.nb_cores_default} (configuration: nbCores)\nat most: ${executor.nb_cores_limit} (the cores of the configuration)`;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cores-max-button';
  button.textContent = 'change max';
  button.title = 'Set a temporary maximum of cores for the steps';
  button.addEventListener('click', () => OpenCoresMaxDialog(executor));
  box.append(text, button);
  return box;
}

function OpenCoresMaxDialog(executor) {
  document.getElementById('cores-max-dialog')?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'cores-max-dialog';
  dialog.className = 'cores-max-dialog';
  const temporary = executor.nb_cores_until > 0;
  dialog.innerHTML = `
    <h3>Maximum of cores · ${executor.name}</h3>
    <p class="muted">Now: <b>${executor.nb_cores}</b>${temporary ? ` (temporary, until ${new Date(executor.nb_cores_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : ''}
      · default <b>${executor.nb_cores_default}</b> · ${executor.nb_cores_used} in use · at most ${executor.nb_cores_limit}</p>
    <label>New maximum <input type="number" id="cm-max" min="1" max="${executor.nb_cores_limit}" value="${executor.nb_cores}"></label>
    <label>For <input type="number" id="cm-hours" min="0" max="168" value="2"> h <input type="number" id="cm-minutes" min="0" max="59" value="0"> min</label>
    <p class="muted">More cores: more steps can start at once. Fewer: nothing is killed, running steps keep their cores
      and the next ones follow the new maximum. The default (${executor.nb_cores_default}) comes back at the end.</p>
    <p class="cm-error" id="cm-error" hidden></p>
    <div class="cm-actions">
      <button type="button" class="primary" id="cm-apply">Apply</button>
      ${temporary ? '<button type="button" id="cm-reset">Back to the default now</button>' : ''}
      <button type="button" id="cm-cancel">Cancel</button>
    </div>`;
  document.body.appendChild(dialog);
  const send = async (max, seconds) => {
    const error = dialog.querySelector('#cm-error');
    try {
      const response = await fetch(`http://${window.location.host}/api/executor/${encodeURIComponent(executor.name)}/max_cores/${max}/${seconds}`, { method: 'PATCH' });
      const json = await response.json().catch(() => ({ success: false, error: `HTTP ${response.status}` }));
      if (!json.success) throw new Error(json.error || 'refused');
      dialog.close();
      RefreshBoard();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    }
  };
  dialog.querySelector('#cm-apply').addEventListener('click', () => {
    const max = parseInt(dialog.querySelector('#cm-max').value, 10);
    const seconds = (parseInt(dialog.querySelector('#cm-hours').value, 10) || 0) * 3600 + (parseInt(dialog.querySelector('#cm-minutes').value, 10) || 0) * 60;
    const error = dialog.querySelector('#cm-error');
    if (!(max >= 1 && max <= executor.nb_cores_limit)) { error.textContent = `Between 1 and ${executor.nb_cores_limit}.`; error.hidden = false; return; }
    if (!(seconds > 0)) { error.textContent = 'A duration of at least one minute.'; error.hidden = false; return; }
    send(max, seconds);
  });
  dialog.querySelector('#cm-reset')?.addEventListener('click', () => send(0, 0));
  dialog.querySelector('#cm-cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

// ── Disk ─────────────────────────────────────────────────────────────────────────────────────────────────────
const Size = (bytes) => {
  const b = Number(bytes) || 0;
  return b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : b >= 1e9 ? `${Math.round(b / 1e9)} GB` : `${Math.round(b / 1e6)} MB`;
};

// the click window of a disk bar: its use, the minimum to start a step, and a button that removes the folders of
// tasks that no longer exist (left by a stop: POST /api/runs/cleanup)
function DiskDetails(metric, executor, label, storage, used) {
  const bar = metric.querySelector('.exec-bar');
  bar.style.cursor = 'context-menu';
  bar.addEventListener('click', (event) => {
    event.stopPropagation();
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const html = `<div class="pb-tip-title">${esc(label)}: ${used} % used</div>`
        + `<div class="pb-tip-grid"><span class="pb-tip-key">capacity</span><span>${Size(storage.capacity)}</span>`
        + `<span class="pb-tip-key">free</span><span>${Size(storage.available)}</span>`
        + (executor.disk_minimum ? `<span class="pb-tip-key">to start a step</span><span>${Size(executor.disk_minimum)} free (diskMinimumGB)</span>` : '')
        + `</div>`
        + (executor.disk_blocked ? `<div class="pb-tip-warn">⚠ new steps wait for disk space; running ones go on</div>` : '')
        + `<div class="pb-tip-gap"></div><button type="button" class="disk-cleanup">Remove the folders of tasks that no longer exist</button>`
        + `<div class="pb-tip-line disk-cleanup-result"></div>`;
    const tip = OpenClickTip(bar, html);
    tip?.querySelector('.disk-cleanup')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const out = tip.querySelector('.disk-cleanup-result');
      out.textContent = 'Removing…';
      try {
        const response = await fetch(`http://${window.location.host}/api/runs/cleanup`, { method: 'POST' });
        const json = await response.json();
        if (!json.success) throw new Error(json.error || `HTTP ${response.status}`);
        out.textContent = json.removed.length
            ? `${json.removed.length} folder(s) being removed in the background: ${json.removed.join(', ')}`
            : 'None: every folder belongs to a task of the scheduler.';
      } catch (error) {
        out.textContent = `Failed: ${error.message} (a scheduler without this feature?)`;
      }
    });
  });
}
