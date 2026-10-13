import { config } from './config.js';

const link = document.createElement('link');
link.rel  = 'stylesheet';
link.href = new URL('./launchers.css', import.meta.url);
document.head.appendChild(link);

const mods = await Promise.all(config.projects.map(p => import(`./${p}/joblauncher.js`)));
export const launchers = mods.map((m, i) => {
  const instance = new m.JobLauncher();
  return {
    label: config.projects[i],
    open: (args) => instance.open(args),
    // optional: richer description of the project's tasks ({ title, commit } HTML, or null), see DescribeTask
    describeTask: typeof instance.describeTask === 'function' ? (task) => instance.describeTask(task) : null,
    // optional: one-line summary of a step's monitor message ({ summary, level }, or null), see DescribeMonitor
    describeMonitor: typeof instance.describeMonitor === 'function'
        ? (task, message) => instance.describeMonitor(task, message) : null,
    // optional: prepares the descriptions of many tasks at once (e.g. one request for all their commits)
    prefetchTasks: typeof instance.prefetchTasks === 'function' ? (tasks) => instance.prefetchTasks(tasks) : null,
    // optional: the settings of a task in readable form for the task page ([{ label, html }], or null), see
    // DescribeSettings
    describeSettings: typeof instance.describeSettings === 'function' ? (task) => instance.describeSettings(task) : null,
  };
});

// Description of a task by its project's launcher (the launcher that started it, or else the first one that knows
// it): { title, commit } HTML to show instead of the task name and of its commit argument, or null
export async function DescribeTask(task) {
  const project = task?.launcher?.project;
  const candidates = launchers.filter(entry => entry.describeTask && (!project || entry.label === project));
  for (const entry of candidates) {
    try {
      const description = await entry.describeTask(task);
      if (description) return description;
    } catch (error) {
      console.warn('describeTask', entry.label, error);
    }
  }
  return null;
}

// Settings of a task in readable form by its project's launcher, for the task page: [{ label, html }], or null (the
// page then shows the task's arguments as they are). The arguments are always shown in full as well.
export function DescribeSettings(task) {
  const project = task?.launcher?.project;
  for (const entry of launchers.filter(e => e.describeSettings && (!project || e.label === project))) {
    try {
      const settings = entry.describeSettings(task);
      if (settings) return settings;
    } catch (error) {
      console.warn('describeSettings', entry.label, error);
    }
  }
  return null;
}

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

function ShowLauncherMenu(event) {
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

export function BuildUI() {
  nextTaskBt.id = 'new-task';
  nextTaskBt.classList.add('new-task');
  nextTaskBt.dataset.help = 'launcher.new';
  nextTaskBt.innerText = '+';
  nextTaskBt.onclick = ShowLauncherMenu;
  document.body.appendChild(nextTaskBt);
}

const nextTaskBt = document.createElement('button');

// One-line summary of a monitor message by the task's project (synchronous): { summary HTML, level: 'warning' |
// 'error' | 'success' }, or null (the board then shows the first line of the message)
export function DescribeMonitor(task, message) {
  const project = task?.launcher?.project;
  for (const entry of launchers.filter(e => e.describeMonitor && (!project || e.label === project))) {
    try {
      const description = entry.describeMonitor(task, message);
      if (description) return description;
    } catch (error) {
      console.warn('describeMonitor', entry.label, error);
    }
  }
  return null;
}

// Prepares the descriptions of many tasks (history): every launcher that can, at once; DescribeTask is then fast
export async function PrefetchTasks(tasks) {
  await Promise.all(launchers.filter(entry => entry.prefetchTasks).map(entry =>
      Promise.resolve(entry.prefetchTasks(tasks)).catch(error => console.warn('prefetchTasks', entry.label, error))));
}

