// The plugin of tlspuffin for the pages of the scheduler and of the other services (board/plugins.js: the contract;
// listed in board/custom/config.js by the installer):
// - launcher: the launch form (joblauncher.js) and its descriptions of the tasks, monitor messages and settings;
// - frame: the top bar of the bench (bar.js) and its guide (guide.js);
// - history: the buttons of the tasks (task_links.json, written by objectives_report.sh), the package and objectives
//   filters, the short job types (history.js);
// - task: "Relaunch as template" of a task started without the launch form, 🕘 N runs of its commit;
// - taskcard: the link to the published results with the commit of the task.
import { JobLauncher, helpTexts } from './joblauncher.js';
import { BarItems } from './bar.js';
import { history, PackageOf } from './history.js';

const JOB_TYPES = ['vuln-a', 'vuln-b', 'perf', 'campaign'];
const ArgOf = (task, key) => (task?.args ?? []).find(arg => arg.key === key)?.value;

// the launcher, whose descriptions of the tasks also give their package to the search of the history
class Launcher extends JobLauncher {
  async describeTask(task) {
    const description = await super.describeTask(task);
    const pkg = PackageOf(task);
    return (description && pkg) ? { ...description, search: `${description.search ?? ''} ${pkg}` } : description;
  }
}

// a task started automatically (a commit, a PR) has no launcher record: the template is rebuilt from its arguments
// (job type, commit, campaign); the other settings are the launcher's defaults
function Relaunch(task) {
  const commit = ArgOf(task, 'COMMIT_ID');
  const jobType = JOB_TYPES.includes(task?.job_type) ? task.job_type : null;
  if (!commit && !jobType) return null;
  return {
    custom: { jobType, commit: commit ?? null, campaignId: ArgOf(task, 'CAMPAIGN_ID') ?? '' },
    title: 'This task was started automatically (no launcher record): the launcher with its job type and commit, the other settings at their defaults; check them, then launch',
  };
}

// 🕘 N runs: the other tasks of the same commit and type kept by the publisher (its /html/runs/ page, written by
// runs_report.py): shown when there are several, the index read from the publisher of the results link
function Links(task) {
  const commitId = ArgOf(task, 'COMMIT_ID');
  if (!task?.publish_link || !commitId) return null;
  const type = /^vuln/i.test(task.job_type ?? '') ? 'Vuln' : /^perf/i.test(task.job_type ?? '') ? 'Perf' : null;
  let origin = null;
  try { origin = new URL(task.publish_link, window.location.href).origin; } catch (error) {}
  if (!type || !origin) return null;
  return [{
    label: '🕘 runs', hidden: true,
    url: `${origin}/html/runs/runs.html#commit=${encodeURIComponent(commitId)}&tab=PR/${type}`,
    title: 'Every task of this commit and type kept by the publisher, with the puffin-bench version of each (new tab)',
    update: async (element) => {
      const index = await fetch(`${origin}/html/runs/index.json`, { cache: 'no-store' })
          .then(response => response.ok ? response.json() : null).catch(() => null);
      const entry = index?.[commitId] ?? Object.entries(index ?? {}).find(([c]) => c.startsWith(commitId))?.[1];
      const count = entry?.[`PR/${type}`];
      if (count > 1) { element.textContent = `🕘 ${count} runs`; element.hidden = false; }
    },
  }];
}

// The published results of a task (publish_link: the Results page at #<task id>), with its commit (&commit=<sha>):
// Results shows the card of the commit when the publisher keeps a newer task of the same libraries instead
function ResultsLink(task, link) {
  const commit = ArgOf(task, 'COMMIT_ID');
  if (!link || !/^[0-9a-f]{7,40}$/i.test(commit ?? '') || !/#[^#&=]+$/.test(link)) return null;
  return `${link}&commit=${commit}`;
}

export default {
  launcher: Launcher,
  helpTexts,
  frame: {
    barItems: BarItems,
    helpTabs: [{ label: 'puffin-bench guide', html: async () => (await import('./guide.js')).benchGuide }],
  },
  history,
  task: { relaunch: Relaunch, links: Links },
  taskcard: { resultsLink: ResultsLink },
};
