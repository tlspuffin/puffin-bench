import { ShowSchedulerHealth } from './frame.js';
import { Help, helpTexts } from './help.js';
import { TaskCard, ResultsLink } from './taskcard.js';
import { Clipboard } from './clipboard.js';
import * as Plugins from './plugins.js';

// the status light of this scheduler in the top bar
ShowSchedulerHealth();

// History: every finished task (done or cancelled) of every user in one list, newest first, grouped by day, with
// filters; the details of a task in a drawer (actions, times, core-hours, arguments, configurations, task card).
// Each task comes from /api/user/<user>/<job type>/tasks ({id, name, cancelled, publish_link, flag, end_timestamp,
// args?, summary?}; args: the task arguments; summary, recorded by the scheduler when the task ends: steps by outcome, core-hours, first start and
// last end). The plugin of its project may describe the task (title, words for the search, its arguments: plugins.js
// DescribeTask), add buttons to it and a class to its row (HistoryCard), name its job type (HistoryTypeLabel); the
// plugins add filters (HistoryFilters) and counts (HistoryStats), and read what they need with the list
// (HistoryLoad).

const taskCard = new TaskCard({ onRefresh: () => {}, launchers: Plugins.launchers, describeTask: Plugins.DescribeTask,
    describeMonitor: Plugins.DescribeMonitor });

const ui = {
  list: document.getElementById('list'),
  drawer: document.getElementById('drawer'),
  stats: document.getElementById('header-stats'),
  search: document.getElementById('search'),
  plugins: document.getElementById('filter-plugins'),
  users: document.getElementById('filter-users'),
  types: document.getElementById('filter-types'),
  states: document.getElementById('filter-states'),
  sort: document.getElementById('sortIndex-select'),
};

const state = {
  tasks: [],                 // finished tasks, with user and type
  descriptions: new Map(),   // id -> { title, commit, custom, search, args } of the project (DescribeTask)
  filters: { search: '', users: new Set(), types: new Set(), states: new Set() },
  // filters of the plugins (HistoryFilters), by plugin and label: a set of the values selected, or on (true)
  pluginFilters: new Map(),
  sort: 'end_timestamp',
  selected: null,
};

const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const DAY_MS = 86400000;

function DisableUI() {
  document.body.setAttribute('inert', '');
  document.body.setAttribute('aria-busy', 'true');
}

function EnableUI() {
  document.body.removeAttribute('inert');
  document.body.removeAttribute('aria-busy');
}

// ── Data ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function FetchJSON(url) {
  const response = await fetch(url);
  const json = await response.json();
  return json?.success ? json.data : null;
}

// in batches of 10 requests
async function InBatches(items, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += 10) {
    results.push(...await Promise.all(items.slice(i, i + 10).map(fn)));
  }
  return results;
}

async function LoadTasks() {
  const base = `http://${window.location.host}/api`;
  const users = (await FetchJSON(`${base}/users`)) ?? [];
  const pairs = (await InBatches(users, async user => {
    try {
      return ((await FetchJSON(`${base}/user/${user}/job_types`)) ?? []).map(type => [user, type]);
    } catch (error) {
      console.error(`Unable to list the job types of ${user}: ${error.message}`);
      return [];
    }
  })).flat();
  const lists = await InBatches(pairs, async ([user, type]) => {
    try {
      return ((await FetchJSON(`${base}/user/${user}/${type}/tasks`)) ?? []).map(task => ({ ...task, user, type }));
    } catch (error) {
      console.error(`Unable to list the tasks of ${user}/${type}: ${error.message}`);
      return [];
    }
  });
  return lists.flat().filter(task => !task.running);
}

async function DescribeTasks() {
  await Plugins.PrefetchTasks(state.tasks).catch(() => {});
  await Promise.all(state.tasks.map(async task => {
    if (state.descriptions.has(task.id)) return;
    const description = await Plugins.DescribeTask({ id: task.id, name: task.name, type: task.type, args: task.args ?? [] })
        .catch(() => null);
    state.descriptions.set(task.id, description);
  }));
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

const Start = (task) => task.summary?.start_timestamp || task.id;
const End = (task) => task.end_timestamp || task.summary?.end_steps_timestamp || task.id;
const StateOf = (task) => task.cancelled ? 'cancelled' : 'done';

function Duration(ms) {
  if (!(ms > 0)) return '';
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.round(ms / 60000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
}

function DayLabel(time) {
  const date = new Date(time);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(date); day.setHours(0, 0, 0, 0);
  const label = date.toLocaleDateString(navigator.languages, { weekday: 'short', day: '2-digit', month: 'short' });
  if (day.getTime() === today.getTime()) return `Today · ${label}`;
  if (day.getTime() === today.getTime() - DAY_MS) return `Yesterday · ${label}`;
  return label;
}

const Time = (time) => new Date(time).toLocaleTimeString(navigator.languages, { hour: '2-digit', minute: '2-digit' });
const DateTime = (time) => new Date(time).toLocaleString(navigator.languages,
    { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const CoreHours = (value) => value >= 100 ? Math.round(value).toLocaleString('en-US') : value.toFixed(1);

function Steps(task) {
  const steps = task.summary?.steps;
  if (!steps?.total) return null;
  const good = steps.ok;
  const cls = good === steps.total ? 'ok' : (good === 0 ? 'fail' : 'mixed');
  const title = [`${steps.ok} of ${steps.total} steps ended well`, steps.failed && `${steps.failed} failed`,
    steps.timed_out && `${steps.timed_out} timed out`, steps.cancelled && `${steps.cancelled} cancelled`,
    steps.other && `${steps.other} other`].filter(Boolean).join(', ');
  return { text: `${good}/${steps.total}`, cls, title };
}

function TitleHTML(task) {
  const description = state.descriptions.get(task.id);
  if (description?.commit) {
    return (description.custom ? `<span class="name">${esc(description.custom)}</span> · ` : '') + description.commit;
  }
  return `<span class="name">${esc(task.name || `Task ${task.id}`)}</span>`;
}

function SearchText(task) {
  const description = state.descriptions.get(task.id);
  const div = document.createElement('div');
  div.innerHTML = description?.title ?? '';
  return [task.name, task.id, task.user, task.type, TypeOf(task).label, div.textContent, description?.search ?? '']
      .join(' ').toLowerCase();
}

// the job type as its project names it ({ label, cls }), else as it is
const TypeOf = (task) => Plugins.HistoryTypeLabel(task) ?? { label: task.type, cls: '' };

// the buttons of the task's project (HistoryCard)
function LinkButtons(task, cls) {
  return (Plugins.HistoryCard(task)?.buttons ?? []).filter(button => button?.url).map(button =>
    `<a class="${cls} ${esc(button.cls ?? '')}" href="${esc(new URL(button.url, window.location.href))}"
        target="_blank" rel="noopener" title="${esc(button.title ?? '')}">${esc(button.label ?? '')}</a>`).join('');
}

// ── List ─────────────────────────────────────────────────────────────────────────────────────────────────────

const FilterKey = (filter) => `${filter.plugin}\u0000${filter.label}`;

// a filter of a plugin, as selected: the task matches one of its values (or the filter when it has none); a task its
// plugin does not know does not match (see plugins.js)
function MatchesPluginFilter(task, filter, selected) {
  try {
    return (selected === true) ? !!filter.match(task) : [...selected].some(value => filter.match(task, value));
  } catch (error) {
    console.warn('history filter', filter.plugin, filter.label, error);
    return false;
  }
}

function Visible(task) {
  const f = state.filters;
  if (f.users.size && !f.users.has(task.user)) return false;
  if (f.types.size && !f.types.has(task.type)) return false;
  if (f.states.size && !f.states.has(StateOf(task))) return false;
  for (const filter of Plugins.HistoryFilters()) {
    const selected = state.pluginFilters.get(FilterKey(filter));
    if (!selected || (selected !== true && selected.size === 0)) continue;
    if (!MatchesPluginFilter(task, filter, selected)) return false;
  }
  if (f.search && !f.search.split(/\s+/).every(word => SearchText(task).includes(word))) return false;
  return true;
}

function RenderStats() {
  const since = Date.now() - 30 * DAY_MS;
  const recent = state.tasks.filter(task => End(task) >= since);
  const hours = recent.reduce((sum, task) => sum + (task.summary?.core_hours ?? 0), 0);
  // compact, at the end of the filter row (explained by its hover, help.js history.stats); then the counts of the
  // plugins over the same tasks
  ui.stats.innerHTML = `<b>${state.tasks.length}</b> tasks · 30 d: <b>${recent.length}</b>` +
      (hours > 0 ? ` · <b>${CoreHours(hours)}</b> core-h` : '') +
      Plugins.HistoryStats(recent).map(html => ` · ${html}`).join('');
}

function RenderList() {
  const key = state.sort === 'id' ? Start : End;
  const tasks = state.tasks.filter(Visible).sort((a, b) => key(b) - key(a));
  const fragment = document.createDocumentFragment();
  let day = null, dayHeader = null, dayCount = 0, dayHours = 0;
  const closeDay = () => {
    if (dayHeader) {
      dayHeader.lastElementChild.textContent = `${dayCount} task${dayCount > 1 ? 's' : ''}` +
          (dayHours > 0 ? ` · ${CoreHours(dayHours)} core-h` : '');
    }
  };
  for (const task of tasks) {
    const taskDay = new Date(key(task)).toDateString();
    if (taskDay !== day) {
      closeDay();
      day = taskDay; dayCount = 0; dayHours = 0;
      dayHeader = document.createElement('div');
      dayHeader.className = 'day';
      dayHeader.innerHTML = `<span>${esc(DayLabel(key(task)))}</span><span></span>`;
      fragment.appendChild(dayHeader);
    }
    dayCount++;
    dayHours += task.summary?.core_hours ?? 0;
    fragment.appendChild(TaskRow(task, key));
  }
  closeDay();
  if (tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = state.tasks.length ? 'No task matches the filters.' : 'No finished task.';
    fragment.appendChild(empty);
  }
  ui.list.replaceChildren(fragment);
}

function TaskRow(task, key) {
  const row = document.createElement('div');
  row.className = 'task';
  row.dataset.help = 'history.card';
  row.dataset.id = task.id;
  if (state.selected === task.id) row.classList.add('selected');
  // a class of its project (e.g. a task to look at)
  const rowClass = Plugins.HistoryCard(task)?.cls;
  if (rowClass) row.classList.add(...String(rowClass).split(/\s+/).filter(Boolean));
  if (task.flag?.color) row.style.setProperty('--flag-color', task.flag.color);
  const steps = Steps(task);
  const artefacts = `http://${window.location.host}/api/task/${task.id}/artefacts`;
  row.innerHTML = `
    <span class="time">${esc(Time(key(task)))}</span>
    <span class="dur" title="from ${esc(DateTime(Start(task)))} to ${esc(DateTime(End(task)))}">${esc(Duration(End(task) - Start(task)))}</span>
    <div class="title"><span class="type ${esc(TypeOf(task).cls ?? '')}">${esc(TypeOf(task).label)}</span>${TitleHTML(task)}
      <div class="sub">${esc(task.user)} · task ${esc(task.id)} · ${task.cancelled ? 'cancelled' : 'finished'}</div></div>
    <div class="badges">
      ${LinkButtons(task, 'link-badge')}
      ${steps ? `<span class="res ${steps.cls}" title="${esc(steps.title)}">${esc(steps.text)}</span>` : ''}
      ${task.publish_link && !task.cancelled ? `<a class="icon" href="${esc(ResultsLink(task))}" target="_blank" rel="noopener" title="📊 Results: the published results of this task, its card marked">📊</a>` : ''}
      <a class="icon" href="${esc(artefacts)}" title="artefacts (zip)">⬇️</a>
      <span class="dot ${StateOf(task)}" title="${StateOf(task)}"></span>
    </div>`;
  row.addEventListener('click', (event) => {
    if (event.target.closest('a')) return;
    Select(task);
  });
  // keyboard: Tab reaches the row, Enter or Space opens its drawer
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', `task ${task.id}: details`);
  row.addEventListener('keydown', (event) => {
    if ((event.target !== row) || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    Select(task);
  });
  return row;
}

// ── Filters ──────────────────────────────────────────────────────────────────────────────────────────────────

// a few values: chips; more (e.g. many users): a drop-down with checkboxes, which keeps the filter row on one line
const maxChips = 4;

function Chips(container, values, set, label = (value) => value, name = '') {
  for (const value of [...set]) {
    if (!values.includes(value)) set.delete(value);
  }
  if (values.length > maxChips) {
    Picker(container, values, set, label, name);
    return;
  }
  container.replaceChildren(...values.map(value => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip ${set.has(value) ? 'on' : ''}`;
    chip.textContent = label(value);
    chip.onclick = () => {
      set.has(value) ? set.delete(value) : set.add(value);
      chip.classList.toggle('on', set.has(value));
      RenderList();
    };
    return chip;
  }));
}

function Picker(container, values, set, label, name) {
  const picker = document.createElement('details');
  picker.className = 'picker';
  const summary = document.createElement('summary');
  summary.className = `chip ${set.size ? 'on' : ''}`;
  const Summarize = () => {
    summary.textContent = `${name}: ${set.size === 0 ? 'all' : [...set].map(label).join(', ')} ▾`;
    summary.classList.toggle('on', set.size > 0);
  };
  const menu = document.createElement('div');
  menu.className = 'picker-menu';
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'picker-all';
  all.textContent = 'All';
  all.onclick = () => {
    set.clear();
    menu.querySelectorAll('input').forEach(input => { input.checked = false; });
    Summarize();
    RenderList();
  };
  menu.appendChild(all);
  for (const value of values) {
    const item = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = set.has(value);
    input.onchange = () => {
      input.checked ? set.add(value) : set.delete(value);
      Summarize();
      RenderList();
    };
    item.append(input, ` ${label(value)}`);
    menu.appendChild(item);
  }
  Summarize();
  picker.append(summary, menu);
  container.replaceChildren(picker);
}

// Esc (top bar, board/frame.js): close the drawer of a task
window.addEventListener('pb-escape', (event) => {
  if ((event.detail?.layer !== 'panel') || event.defaultPrevented || ui.drawer.hidden) return;
  event.preventDefault();
  ui.drawer.querySelector('.close')?.click();
});

// a click outside an open drop-down closes it
document.addEventListener('click', event => {
  document.querySelectorAll('details.picker[open]').forEach(picker => {
    if (!picker.contains(event.target)) picker.open = false;
  });
});

// one chip on or off
function ToggleChip(filter, key) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `chip ${state.pluginFilters.get(key) === true ? 'on' : ''}`;
  chip.textContent = filter.label;
  chip.onclick = () => {
    const on = state.pluginFilters.get(key) !== true;
    on ? state.pluginFilters.set(key, true) : state.pluginFilters.delete(key);
    chip.classList.toggle('on', on);
    RenderList();
  };
  return chip;
}

// one value at a time: "all" first (the filter does not filter), then its values
function SingleChips(container, values, selected) {
  if (selected.size && !values.includes([...selected][0])) selected.clear();
  const current = selected.size ? [...selected][0] : '';
  container.replaceChildren(...['', ...values].map(value => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip ${current === value ? 'on' : ''}`;
    chip.textContent = value || 'all';
    chip.onclick = () => {
      selected.clear();
      if (value) selected.add(value);
      container.querySelectorAll('.chip').forEach((other, i) => other.classList.toggle('on', ['', ...values][i] === value));
      RenderList();
    };
    return chip;
  }));
}

// the filters of the plugins: chips of their values (any of those selected; with single, one of them or all), or one
// chip on or off; in the zone of the plugins at the start of the row, or in a group of History (group)
function RenderPluginFilters() {
  const own = [];
  const groups = { users: ui.users, types: ui.types, states: ui.states };
  for (const filter of Plugins.HistoryFilters()) {
    const key = FilterKey(filter);
    let element;
    if (filter.values == null) {
      element = ToggleChip(filter, key);
    } else {
      let values = [];
      try {
        values = (typeof filter.values === 'function' ? filter.values(state.tasks) : filter.values) ?? [];
      } catch (error) {
        console.warn('history filter values', filter.plugin, filter.label, error);
      }
      if (!(state.pluginFilters.get(key) instanceof Set)) state.pluginFilters.set(key, new Set());
      element = document.createElement('span');
      element.className = 'chips';
      element.dataset.help = 'history.filter';
      if (filter.single) SingleChips(element, [...values].map(String), state.pluginFilters.get(key));
      else Chips(element, [...values].map(String), state.pluginFilters.get(key), undefined, filter.label);
    }
    if (groups[filter.group]) groups[filter.group].appendChild(element);
    else own.push(element);
  }
  ui.plugins.replaceChildren(...own);
  ui.plugins.hidden = own.length === 0;
  ui.plugins.nextElementSibling.hidden = own.length === 0;
}

function RenderFilters() {
  Chips(ui.users, [...new Set(state.tasks.map(task => task.user))].sort(), state.filters.users, undefined, 'Users');
  const types = [...new Map(state.tasks.map(task => [task.type, TypeOf(task).label]))].sort((a, b) => a[0].localeCompare(b[0]));
  const typeLabels = new Map(types);
  Chips(ui.types, types.map(([type]) => type), state.filters.types, type => typeLabels.get(type) ?? type, 'Types');
  Chips(ui.states, ['done', 'cancelled'], state.filters.states);
  // after the groups of History: a filter of a plugin may join one of them
  RenderPluginFilters();
}

// ── Drawer ───────────────────────────────────────────────────────────────────────────────────────────────────

// Configurations of a task (steps with a configuration id): the attempts of its longest step (the experiment)
function Configurations(task) {
  const byId = new Map();
  for (const step of Object.values(task.steps ?? {})) {
    if (!step.id || step.id === '.') continue;
    if (!byId.has(step.id)) byId.set(step.id, new Map());
    const byName = byId.get(step.id);
    if (!byName.has(step.name)) byName.set(step.name, []);
    byName.get(step.name).push(step);
  }
  const runtime = (step) => {
    const [start, end] = step.time_points_ms ?? [];
    return start > 0 && end > start ? end - start : 0;
  };
  return [...byId].map(([id, byName]) => {
    const [name, attempts] = [...byName].sort((a, b) =>
        b[1].reduce((s, x) => s + runtime(x), 0) - a[1].reduce((s, x) => s + runtime(x), 0))[0];
    const ok = attempts.filter(step => step.state === 'Done' && step.exit_code === 0).length;
    const failed = attempts.filter(step => step.state === 'Done' && step.exit_code !== 0).length;
    const timedOut = attempts.filter(step => step.state === 'TimedOut').length;
    const durations = attempts.map(runtime).filter(ms => ms > 0);
    return { id, name, total: attempts.length, ok, failed, timedOut,
      min: durations.length ? Math.min(...durations) : 0, max: durations.length ? Math.max(...durations) : 0 };
  });
}

function RenderDrawer(task, finalTask, error) {
  const description = state.descriptions.get(task.id);
  const summary = task.summary;
  const steps = Steps(task);
  const relaunch = finalTask?.launcher?.project
      ? Plugins.launchers.find(launcher => launcher.label === finalTask.launcher.project) : null;
  // the arguments as the project shows them: not those its title shows, a bare value for those it marks so
  const options = description?.args ?? {};
  const args = (finalTask?.args ?? []).filter(arg => arg?.key)
      .filter(arg => !(options[arg.key]?.hidden || (options[arg.key]?.inTitle && description?.commit)))
      .map(arg => options[arg.key]?.bare ? arg.value : `${arg.key}=${arg.value}`);
  const configs = finalTask ? Configurations(finalTask) : [];
  const waited = summary?.start_timestamp ? summary.start_timestamp - task.id : 0;
  ui.drawer.hidden = false;
  ui.drawer.innerHTML = `
    <div class="top"><span class="type ${esc(TypeOf(task).cls ?? '')}">${esc(TypeOf(task).label)}</span>
      <button type="button" class="close">✖ close</button></div>
    <h2>${TitleHTML(task)}</h2>
    <div class="actions">
      ${LinkButtons(task, 'btn gold')}
      ${task.publish_link && !task.cancelled ? `<a class="btn" href="${esc(ResultsLink(task))}" target="_blank" rel="noopener">📊 Results</a>` : ''}
      <a class="btn" href="task.html?id=${esc(task.id)}" target="_blank" rel="noopener">📄 Task page</a>
      <a class="btn" href="http://${esc(window.location.host)}/api/task/${esc(task.id)}/artefacts">⬇️ Artefacts</a>
      ${relaunch ? '<button type="button" class="btn relaunch" data-help="task.launchagain">↻ New task…</button>' : ''}
      <button type="button" class="btn danger delete" data-help="history.delete">💣 Delete</button>
    </div>
    <div class="kv">
      <div>State</div><div><span class="dot ${StateOf(task)}"></span> ${StateOf(task)}${steps ? `, ${esc(steps.title)}` : ''}</div>
      <div>Submitted</div><div>${esc(DateTime(task.id))}${waited > 60000 ? ` (waited ${esc(Duration(waited))})` : ''}</div>
      <div>Ended</div><div>${esc(DateTime(End(task)))} — ${esc(Duration(End(task) - Start(task)))}${summary?.core_hours ? `, ${CoreHours(summary.core_hours)} core-hours` : ''}</div>
      <div>User / type</div><div>${esc(task.user)} / ${esc(task.type)}</div>
      ${args.length ? `<div>Arguments</div><div>${args.map(esc).join(' · ')}</div>` : ''}
      <div>Task</div><div>${esc(task.id)} · <a href="#" class="copy">📋 copy link</a></div>
    </div>
    ${configs.length ? `<table class="configs"><tr><th>configuration</th><th>runs</th><th></th><th>duration</th></tr>
      ${configs.map(c => `<tr><td>${esc(c.id)}</td><td data-click-tip="${esc(`${c.name}: ${c.ok} ok, ${c.failed} failed, ${c.timedOut} timed out, of ${c.total}`)}">${c.ok}/${c.total}</td>
        <td><div class="bar"><i style="width:${100 * c.ok / c.total}%"></i><i class="failed" style="width:${100 * c.failed / c.total}%"></i><i class="timedout" style="width:${100 * c.timedOut / c.total}%"></i></div></td>
        <td>${c.max ? esc(c.min === c.max || Duration(c.min) === Duration(c.max) ? Duration(c.max) : `${Duration(c.min)}–${Duration(c.max)}`) : ''}${c.timedOut ? ' (timeouts)' : ''}</td></tr>`).join('')}</table>` : ''}
    <h3>Task card</h3>
    <div class="card"></div>`;
  const card = ui.drawer.querySelector('.card');
  if (finalTask) {
    const element = taskCard.Create(finalTask);
    element.querySelectorAll('.card-step').forEach(step => {
      step.classList.add('collapsed');
      const icon = step.querySelector('.card-step-toggle');
      if (icon) icon.innerText = '➕';
    });
    card.appendChild(element);
  } else {
    card.innerHTML = `<div class="error">${esc(error ?? 'Unable to load the task')}</div>`;
  }
  ui.drawer.querySelector('.close').onclick = () => { state.selected = null; ui.drawer.hidden = true; RenderList(); };
  ui.drawer.querySelector('.delete').onclick = () => DeleteTask(task);
  ui.drawer.querySelector('.relaunch')?.addEventListener('click', () => relaunch.open(finalTask.launcher.custom ?? null));
  ui.drawer.querySelector('.copy').onclick = (event) => {
    event.preventDefault();
    Clipboard.Set(`${window.location.origin}/files/board/task.html?id=${task.id}`);
  };
}

async function Select(task) {
  state.selected = task.id;
  ui.list.querySelectorAll('.task').forEach(row => row.classList.toggle('selected', row.dataset.id === String(task.id)));
  let finalTask = null, error = null;
  try {
    const response = await fetch(`http://${window.location.host}/api/task/${task.id}/final_state`);
    const json = await response.json();
    finalTask = json.task ?? null;
    error = json.error ?? null;
  } catch (e) {
    error = e.message;
  }
  if (state.selected === task.id) RenderDrawer(task, finalTask, error);
}

async function DeleteTask(task) {
  if (!confirm(`Delete experiment results of task ${task.id}:\n\t${task.name}`)) {
    return;
  }
  DisableUI();
  try {
    const response = await fetch(`http://${window.location.host}/api/task/${task.id}`, { method: 'DELETE' });
    const json = await response.json();
    if (json?.success) {
      state.tasks = state.tasks.filter(other => other.id !== task.id);
      state.selected = null;
      ui.drawer.hidden = true;
      RenderStats();
      RenderList();
    } else {
      alert(`Unable to delete task ${json?.error ?? 'unknown error'}`);
    }
  } catch (e) {
    console.error(`Unable to delete ${task.id}: ${e.message}`);
  }
  EnableUI();
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function Refresh() {
  DisableUI();
  try {
    state.tasks = await LoadTasks();
    // what the plugins read with the list (e.g. the buttons of the tasks)
    await Plugins.HistoryLoad(state.tasks);
    RenderStats();
    RenderFilters();
    RenderList();
  } catch (e) {
    console.error(`Unable to load the history: ${e}`);
  }
  EnableUI();
  // the descriptions of the projects come afterwards
  await DescribeTasks();
  RenderList();
}

function Main() {
  // hovers of the elements outlined by the help; the help panel and the refresh are in the top bar (frame.js)
  new Help({ ...helpTexts, ...Plugins.helpTexts });
  window.addEventListener('pb-refresh', (event) => { event.preventDefault(); Refresh(); });
  state.sort = ui.sort.value;
  ui.sort.onchange = () => { state.sort = ui.sort.value; RenderList(); };
  let timer = null;
  ui.search.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.filters.search = ui.search.value.trim().toLowerCase(); RenderList(); }, 150);
  };
  Refresh();
}

Main();
