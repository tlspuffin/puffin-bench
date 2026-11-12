// Plugins of the projects: what a project adds to the pages of the scheduler (and to the pages of the other services
// that load frame.js). The scheduler itself knows no project.
//
// Installation (not shipped by the scheduler, written by the installer of each project):
//   custom/config.js            export { config } with config = { projects: ['<name>', …] }; absent = no plugin
//   custom/<name>/plugin.js     the plugin of the project: export default { … } (below); every part is optional
//
// Contract of plugin.js:
//   launcher     a class (instantiated on first use) with
//                  open(params)               the launch form; params: the settings of a previous task
//                                             (task.launcher.custom), or the parameters of #launch=<name>&…
//                                             (board.js) without "launch", or nothing
//                  describeTask(task)         async → { title, commit, custom, search, args: { KEY: { bare, level,
//                                             label, hidden, inTitle, commitLine } } } or null: the title of the task
//                                             (HTML), its commit line (HTML), its custom name, more words for the
//                                             search; how to show each argument: bare (its value alone), level
//                                             'warning' (on its own line, with its label), hidden, inTitle (not
//                                             repeated when the title is shown), commitLine (shown as the commit line)
//                  describeMonitor(task, message) → { summary, level, highlight, badge: { text, title },
//                                             taskLink: { key, label, url, title, count, highlight, pending: { label,
//                                             title, fallback: { url, label, title } } } } or null: one line for the
//                                             last message of an attempt (HTML; level 'error' | 'warning' |
//                                             'success'); highlight 'notable' | 'error': the attempt stands out;
//                                             badge: on its chip (task page); taskLink: a button of the task, the
//                                             counts of its attempts summed by key ({count} in the labels); pending:
//                                             while the page at url does not exist, the fallback page if it exists,
//                                             else the pending label without link
//                  describeSettings(task)     → [{ label, html }] or null: the settings in readable form
//                  prefetchTasks(tasks)       async: prepares the descriptions of many tasks at once
//   helpTexts    { key: text }: hover helps of the elements with data-help="<key>" the plugin creates
//   frame        barItems({ bar, start, end })  adds its items to the top bar (start: left, end: right)
//                helpTabs: [{ label, html }]    tabs of the help panel (html: HTML text, or a function giving it)
//   history      load(tasks)                async, once per reading of the list: reads what the hooks below need
//                card(task)                 → { buttons: [{ label, url, title, cls }], cls } or null: buttons of the
//                                           card of the task, a class of the card
//                typeLabel(task)            → { label, cls } or null: the job type as shown, a class of its badge
//                filters: [{ label, values, single, group, match(task, value) }]: filters of the list (chips);
//                                           values: the choices, or a function of the tasks giving them (several may
//                                           be selected: any of them; single: one at a time, after an "all" chip);
//                                           none = one chip on or off; group 'users' | 'types' | 'states': shown
//                                           with the chips of that group of History (else at the start of the row)
//                stats(tasks)               → HTML or null: added to the counts of the last 30 days (tasks: those)
//   task         relaunch(task)             → { custom, title } or null: "Relaunch as template" of the task page for
//                                           a task without launcher record (custom: given to open)
//                links(task, steps)         → [{ label, url, title, hidden, update(element) }] or null: more links
//                                           of the task page; update (maybe async) may change the link once shown
//   taskcard     resultsLink(task, link)    → the link to the published results of the task (link: publish_link)
//
// Two kinds of hooks:
// - hooks of a page (helpTexts, frame, prefetchTasks, history.load, history.filters, history.stats): every plugin
//   contributes;
// - hooks of a task (the others): one plugin answers, that of the task's project when the task names it
//   (task.launcher.project, recorded by the launch form), otherwise the first plugin, in the order of
//   custom/config.js, whose answer is not null.
// A filter is applied to every task shown, whatever its project: match() returns false for a task its plugin does
// not know, so that a task of another project is left out while the filter is on. Active filters combine (and).

const link = document.createElement('link');
link.rel  = 'stylesheet';
link.href = new URL('./launchers.css', import.meta.url);
document.head.appendChild(link);

async function LoadProjects() {
  try {
    const { config } = await import('./custom/config.js');
    return Array.isArray(config?.projects) ? config.projects : [];
  } catch (error) {
    // no project installed
    return [];
  }
}

async function LoadPlugin(name) {
  try {
    const module = await import(`./custom/${name}/plugin.js`);
    return { ...(module.default ?? {}), name };
  } catch (error) {
    console.warn(`Plugins: the plugin of ${name} could not be loaded`, error);
    return null;
  }
}

export const plugins = (await Promise.all((await LoadProjects()).map(LoadPlugin))).filter(Boolean);

export const helpTexts = {};
for (const plugin of plugins) {
  for (const [key, text] of Object.entries(plugin.helpTexts ?? {})) {
    if (key in helpTexts) {
      console.warn(`Plugins: help key "${key}" from ${plugin.name} overrides an existing one`);
    }
    helpTexts[key] = text;
  }
}

// ── Launchers ────────────────────────────────────────────────────────────────────────────────────────────────

// the launcher of a plugin, created on first use (its form is built then)
function Instance(plugin) {
  plugin.instance ??= new plugin.launcher();
  return plugin.instance;
}

function Method(plugin, name) {
  return (typeof plugin.launcher?.prototype?.[name] === 'function')
      ? (...args) => Instance(plugin)[name](...args) : null;
}

export const launchers = plugins.filter(plugin => typeof plugin.launcher === 'function').map(plugin => ({
  label: plugin.name,
  open: (params) => Instance(plugin).open(params),
  describeTask: Method(plugin, 'describeTask'),
  describeMonitor: Method(plugin, 'describeMonitor'),
  prefetchTasks: Method(plugin, 'prefetchTasks'),
  describeSettings: Method(plugin, 'describeSettings'),
}));

// ── Routing ──────────────────────────────────────────────────────────────────────────────────────────────────

// the plugins that may answer for a task: that of its project when the task names it, else every one in order
function Candidates(task) {
  const project = task?.launcher?.project;
  return project ? plugins.filter(plugin => plugin.name === project) : plugins;
}

// the first answer that is not null of the hook (plugin => function or null) for a task
function ForTask(task, hook, name, ...args) {
  for (const plugin of Candidates(task)) {
    const fn = hook(plugin);
    if (typeof fn !== 'function') continue;
    try {
      const answer = fn(...args);
      if (answer != null) return answer;
    } catch (error) {
      console.warn(name, plugin.name, error);
    }
  }
  return null;
}

async function ForTaskAsync(task, hook, name, ...args) {
  for (const plugin of Candidates(task)) {
    const fn = hook(plugin);
    if (typeof fn !== 'function') continue;
    try {
      const answer = await fn(...args);
      if (answer != null) return answer;
    } catch (error) {
      console.warn(name, plugin.name, error);
    }
  }
  return null;
}

// every plugin's hook (plugin => function or null), called in order; the answers that are not null
function ForAll(hook, name, ...args) {
  const answers = [];
  for (const plugin of plugins) {
    const fn = hook(plugin);
    if (typeof fn !== 'function') continue;
    try {
      const answer = fn(...args);
      if (answer != null) answers.push(answer);
    } catch (error) {
      console.warn(name, plugin.name, error);
    }
  }
  return answers;
}

const Bound = (object, name) => (typeof object?.[name] === 'function') ? object[name].bind(object) : null;

// ── Hooks of a task ──────────────────────────────────────────────────────────────────────────────────────────

// { title, commit, search, args } of a task, or null (the page then shows the task name and its arguments as given)
export const DescribeTask = (task) =>
    ForTaskAsync(task, plugin => Method(plugin, 'describeTask'), 'describeTask', task);

// the settings of a task in readable form, for the task page: [{ label, html }], or null (the page then shows the
// task's arguments as they are). The arguments are always shown in full as well.
export const DescribeSettings = (task) =>
    ForTask(task, plugin => Method(plugin, 'describeSettings'), 'describeSettings', task);

// one line for the last message of an attempt (synchronous), or null (the page then shows its first line)
export const DescribeMonitor = (task, message) =>
    ForTask(task, plugin => Method(plugin, 'describeMonitor'), 'describeMonitor', task, message);

// buttons and class of the card of a task in History, or null
export const HistoryCard = (task) =>
    ForTask(task, plugin => Bound(plugin.history, 'card'), 'history.card', task);

// the job type of a task as History shows it ({ label, cls }), or null (the job type as it is)
export const HistoryTypeLabel = (task) =>
    ForTask(task, plugin => Bound(plugin.history, 'typeLabel'), 'history.typeLabel', task);

// "Relaunch as template" of a task that has no launcher record: { custom, title } and the launcher to open, or null
export function TaskRelaunch(task) {
  for (const plugin of Candidates(task)) {
    const fn = Bound(plugin.task, 'relaunch');
    if (!fn) continue;
    try {
      const answer = fn(task);
      const launcher = launchers.find(entry => entry.label === plugin.name);
      if (answer && launcher) return { ...answer, launcher };
    } catch (error) {
      console.warn('task.relaunch', plugin.name, error);
    }
  }
  return null;
}

// more links of the task page: [{ label, url, title }]
export const TaskLinks = (task, steps) =>
    ForTask(task, plugin => Bound(plugin.task, 'links'), 'task.links', task, steps) ?? [];

// the link to the published results of a task: its publish_link, or what its plugin makes of it
export const ResultsLink = (task, link) =>
    ForTask(task, plugin => Bound(plugin.taskcard, 'resultsLink'), 'taskcard.resultsLink', task, link) ?? link;

// ── Hooks of a page ──────────────────────────────────────────────────────────────────────────────────────────

// prepares the descriptions of many tasks (History): every plugin that can, at once; DescribeTask is then fast
export async function PrefetchTasks(tasks) {
  await Promise.all(launchers.filter(entry => entry.prefetchTasks).map(entry =>
      Promise.resolve().then(() => entry.prefetchTasks(tasks))
          .catch(error => console.warn('prefetchTasks', entry.label, error))));
}

// History reads the list: every plugin reads what its hooks need
export async function HistoryLoad(tasks) {
  await Promise.all(plugins.filter(plugin => Bound(plugin.history, 'load')).map(plugin =>
      Promise.resolve().then(() => plugin.history.load(tasks))
          .catch(error => console.warn('history.load', plugin.name, error))));
}

// the filters of History: [{ plugin, label, values, match }]
export function HistoryFilters() {
  return plugins.flatMap(plugin => (Array.isArray(plugin.history?.filters) ? plugin.history.filters : [])
      .filter(filter => filter?.label && typeof filter.match === 'function')
      .map(filter => ({ ...filter, plugin: plugin.name })));
}

// what the plugins add to the counts of History: [HTML]
export const HistoryStats = (tasks) => ForAll(plugin => Bound(plugin.history, 'stats'), 'history.stats', tasks);

// the items of the plugins in the top bar (frame.js)
export function FrameBarItems(slots) {
  ForAll(plugin => Bound(plugin.frame, 'barItems'), 'frame.barItems', slots);
}

// the tabs of the plugins in the help panel (frame.js)
export function FrameHelpTabs() {
  return plugins.flatMap(plugin => Array.isArray(plugin.frame?.helpTabs) ? plugin.frame.helpTabs : []);
}

// ── The + button ─────────────────────────────────────────────────────────────────────────────────────────────

const menu = document.createElement('div');
menu.className = 'launcher-menu';
for (const entry of launchers) {
  const item = document.createElement('button');
  item.className = 'launcher-menu-item';
  item.dataset.help = 'launcher.project';
  item.textContent = entry.label;
  item.addEventListener('click', () => {
    menu.remove();
    entry.open();
  });
  menu.appendChild(item);
}

const nextTaskBt = document.createElement('button');

function ShowLauncherMenu() {
  if (launchers.length === 1) {
    launchers[0].open();
    return;
  }

  if (menu.isConnected) {
    menu.remove();
    return;
  }

  const rect = nextTaskBt.getBoundingClientRect();
  menu.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
  menu.style.right  = (window.innerWidth - rect.right) + 'px';

  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', function onOutside(e) {
    if (!menu.contains(e.target) && e.target !== nextTaskBt) {
      menu.remove();
      document.removeEventListener('click', onOutside);
    }
  }), 0);
}

// the + button of the board: none without a launcher
export function BuildUI() {
  if (launchers.length === 0) return;
  nextTaskBt.id = 'new-task';
  nextTaskBt.classList.add('new-task');
  nextTaskBt.dataset.help = 'launcher.new';
  nextTaskBt.innerText = '+';
  nextTaskBt.onclick = ShowLauncherMenu;
  document.body.appendChild(nextTaskBt);
}
