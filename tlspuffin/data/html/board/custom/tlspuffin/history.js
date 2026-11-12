// What tlspuffin adds to the History page of the scheduler (see plugin.js, and the contract in board/plugins.js):
// - the buttons of a task from task_links.json, next to this file, written by objectives_report.sh: per task id,
//   [{ label, url (relative to the History page), title, level, count, bugs, new, headline, source }]: the 🐞 of its
//   objectives report (gold; plain for VulnA/VulnB, whose objectives are expected), the 🎯 of a Vuln task
//   (level expected-all / expected-partial / expected-none / provisional), "warning" outlined; a report with new bugs
//   highlights the task, its title before the button;
// - the package of each task (its PACKAGE argument; tasks without one: tlspuffin), read from their final state and
//   kept by the browser (a finished task does not change);
// - the filters "package" and "🐞 with objectives", the short job types, the number of tasks with objectives.

const PACKAGES = ['tlspuffin', 'sshpuffin'];
const TYPES = { 'perf': 'Perf', 'vuln-a': 'VulnA', 'vuln-b': 'VulnB', 'campaign': 'Camp' };

let links = {};
const packages = new Map();  // task id -> package (null: not a task of tlspuffin)

function LoadStyle() {
  if (document.querySelector('link[data-tlspuffin-history]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./history.css', import.meta.url);
  link.dataset.tlspuffinHistory = '';
  document.head.appendChild(link);
}

async function LoadLinks() {
  try {
    const response = await fetch(new URL('./task_links.json', import.meta.url), { cache: 'no-store' });
    return response.ok ? await response.json() : {};
  } catch (error) {
    return {};
  }
}

// in batches of 10 requests
async function InBatches(items, fn) {
  for (let i = 0; i < items.length; i += 10) await Promise.all(items.slice(i, i + 10).map(fn));
}

async function LoadPackages(tasks) {
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem('pb-history-packages') ?? '{}') ?? {}; } catch (error) {}
  for (const [id, pkg] of Object.entries(cache)) packages.set(id, pkg);
  const missing = tasks.filter(task => !packages.has(String(task.id)));
  await InBatches(missing, async task => {
    try {
      const response = await fetch(`http://${window.location.host}/api/task/${task.id}/final_state`);
      if (!response.ok) return;
      const json = await response.json();
      const pkg = (json?.task?.args ?? json?.data?.task?.args ?? []).find(arg => arg.key === 'PACKAGE')?.value || 'tlspuffin';
      packages.set(String(task.id), pkg);
    } catch (error) { /* left unknown: shown when no package is selected */ }
  });
  try { localStorage.setItem('pb-history-packages', JSON.stringify(Object.fromEntries(packages))); } catch (error) {}
}

// the package of a task, null while not read (or not a task of tlspuffin)
export const PackageOf = (task) => packages.get(String(task?.id)) ?? null;

const LinksOf = (task) => links[task?.id] ?? [];

// objectives of VulnA/VulnB tasks are their expected outcome: their button is plain, not gold
const ObjectivesExpected = (task, link) => (link.source === 'objectives_report') && ['vuln-a', 'vuln-b'].includes(task.type);

export const history = {
  async load(tasks) {
    LoadStyle();
    [links] = await Promise.all([LoadLinks(), LoadPackages(tasks)]);
  },

  card(task) {
    const own = LinksOf(task);
    if (own.length === 0) return null;
    const buttons = own.map(link => {
      const count = link.count != null ? `${link.label} ${Number(link.count).toLocaleString('en-US')}` : link.label;
      // level: warning, or expected-all / expected-partial / expected-none / provisional (🎯: never plain)
      const level = link.level === 'warning' ? 'warning'
          : /^expected-(all|partial|none|provisional)$/.test(link.level ?? '') ? link.level : '';
      const plain = (ObjectivesExpected(task, link) && !level.startsWith('expected-')) ? 'plain' : '';
      return {
        label: link.new > 0 && link.headline ? `${link.headline} · ${count}` : count,
        url: link.url, title: link.title ?? '',
        cls: [plain, level, link.new > 0 ? 'new-bugs' : ''].filter(Boolean).join(' '),
      };
    });
    // a task whose objectives report found new bugs: highlighted
    return { buttons, cls: own.some(link => link.new > 0) ? 'new-bugs' : '' };
  },

  typeLabel(task) {
    return TYPES[task?.type] ? { label: TYPES[task.type], cls: task.type } : null;
  },

  filters: [
    {
      // all | tlspuffin | sshpuffin (and any other package found): a task has one package
      label: 'package', single: true,
      values: (tasks) => [...new Set([...PACKAGES, ...tasks.map(PackageOf).filter(Boolean)])],
      match: (task, value) => PackageOf(task) === value,
    },
    {
      // the tasks with an objectives page, next to the states
      label: '🐞 with objectives', group: 'states',
      match: (task) => LinksOf(task).length > 0,
    },
  ],

  // the tasks with an objectives page
  stats(tasks) {
    return `<b>${tasks.filter(task => LinksOf(task).length > 0).length}</b> 🐞`;
  },
};
