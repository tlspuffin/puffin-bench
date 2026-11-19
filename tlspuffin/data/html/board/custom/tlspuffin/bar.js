// What tlspuffin adds to the top bar of every page (board/frame.js, see plugin.js): the bench and its deployed
// version, the services each one click away (Scheduler, Results, Analyzer, History), the live objectives, the package
// shown by Results and Analyzer; on a page of another service, the status light of the scheduler. Keys: g then
// s / r / a / h = Scheduler, Results, Analyzer, History.
// The links use the host of the page and the default ports of the services; the links to this machine follow the
// address typed in the browser (hostlinks.js).
import './hostlinks.js';
import { ShowSchedulerHealth } from '../../frame.js';

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
.pb-nav .pb-brand { font-weight: 700; margin-right: 14px; }
.pb-nav .pb-version { font: 400 11px ui-monospace, Menlo, monospace; color: #8b8b8b; text-decoration: none; }
.pb-nav .pb-version:hover { color: #58a6ff; text-decoration: underline; }
.pb-nav a.pb-item { color: #c9c9c9; padding: 6px 12px; border-radius: 6px; text-decoration: none; line-height: 1.2; }
.pb-nav a.pb-item:hover { background: #1c1c1c; text-decoration: none; }
.pb-nav a.pb-item.on { color: #fff; background: #1f2937; box-shadow: inset 0 -2px 0 #58a6ff; }
.pb-nav .pb-package { display: flex; gap: 6px; align-items: center; color: #8b8b8b; }
.pb-nav select { background: #161616; color: #e8e8e8; border: 1px solid #333; border-radius: 5px; padding: 2px 6px; font: inherit; }
.pb-nav a.pb-live { margin-left: 12px; padding: 3px 11px; border-radius: 999px; background: #ffc400; color: #1a1a1a;
  font-weight: 700; text-decoration: none; line-height: 1.2; }
.pb-nav a.pb-live:hover { background: #ffd54d; text-decoration: none; }
.pb-nav a.pb-live.unconfirmed { background: transparent; color: #ffb74d; border: 1px solid #f08c00; }
`;

// Objectives found by running tasks (objectives/live.json, written every 5 minutes by objectives_live.sh): a yellow
// pill next to the services, to the live objectives page. VulnA/VulnB tasks look for known bugs: their objectives
// are expected and not announced. Outlined while no replay confirmed a bug.
const objectivesExpected = new Set(['vuln-a', 'vuln-b']);

function LiveObjectives(container) {
  const pill = document.createElement('a');
  pill.className = 'pb-live';
  pill.hidden = true;
  pill.href = `${Base(ports.publisher)}/html/objectives/live.html`;
  pill.target = '_blank';
  pill.rel = 'noopener';
  container.appendChild(pill);

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

// frame.barItems: start (left) and end (right, before the status light and the buttons) of the bar
export function BarItems({ start, end }) {
  const service = CurrentService();
  let pkg = CurrentPackage();

  const css = document.createElement('style');
  css.textContent = style;
  document.head.appendChild(css);

  // the scheduler's own pages show its light at their address (alias, SSH tunnel); the other services name it
  if (!['scheduler', 'history'].includes(service)) ShowSchedulerHealth(Base(ports.scheduler));

  const brand = document.createElement('span');
  brand.className = 'pb-brand';
  brand.textContent = '🐡 puffin-bench';
  start.appendChild(brand);
  Version(brand);

  const links = services.map(s => {
    const link = document.createElement('a');
    link.className = `pb-item ${s.id === service ? 'on' : ''}`;
    link.textContent = s.label;
    link.title = `${s.label.replace(/^\S+\s/, '')} (keys: g then ${s.key})`;
    link.href = s.url(pkg);
    start.appendChild(link);
    return link;
  });

  LiveObjectives(start);

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
  end.appendChild(label);

  // g then s / r / a / h; on window, after the page's own handlers (document): a key they handled is left alone
  let goPending = 0;
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (event.key === 'g') {
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
}
