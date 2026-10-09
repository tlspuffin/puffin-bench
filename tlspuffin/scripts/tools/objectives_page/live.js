// Page of the running tasks with objectives (objectives/live.html, written by objectives_live.sh every 5 minutes):
// one row per task, from live.json next to it ({ updated, tasks: [{ task, name, commit, job_type, found, replayed,
// reproduced, bugs, hit: [configurations], configurations, url, task_url }] }). Same look as the objectives pages
// (report.css). The top bar (nav.js) also shows a pill for these tasks, except VulnA/VulnB ones.
import '../board/nav.js';
import { resolveCommits, parseTaskName, commitLineHTML } from '../common/commitinfo.js';

const help = document.createElement('template');
help.id = 'help-panel';
help.innerHTML = `
  <h2>Live objectives</h2>
  <ul>
    <li>One row per running task whose fuzzers found objectives, refreshed every 5 minutes; the page reloads every
      minute.</li>
    <li>Objectives are replayed on core 0 at idle priority, outside the fuzzing cores, and grouped by bug:
      <b>bugs</b> = distinct confirmed bugs (sanitizer report, security claim, panic or crash),
      <b>reproduced</b> = replays that confirmed a bug.</li>
    <li>VulnA/VulnB tasks look for known bugs: their objectives are expected and shown plainly, without the top bar
      pill.</li>
    <li>A task's row links to its page, organized by bug. When the task ends, its final page replaces it
      (objectives/&lt;task&gt;.html, 🐞 on the History).</li>
  </ul>
  <p>Press <b>?</b> to toggle this panel.</p>`;
document.head.appendChild(help);

const EXPECTED = new Set(['vuln-a', 'vuln-b']);
const PREFIXES = { 'perf': 'Perf', 'vuln-a': 'VulnA', 'vuln-b': 'VulnB', 'campaign': 'Camp' };
const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const count = (value) => Number(value ?? 0).toLocaleString('en-US');

function Row(task) {
  const expected = EXPECTED.has(task.job_type);
  const type = PREFIXES[task.job_type] ?? task.job_type ?? '';
  const bugs = task.bugs ?? 0;
  const hit = task.hit ?? [];
  return `
    <a class="card live-row ${bugs > 0 && !expected ? 'gold' : ''}" href="${esc(task.url)}">
      <div class="live-head">
        <span class="commit-line" data-commit="${esc(task.commit)}" data-name="${esc(task.name)}" data-type="${esc(type)}">
          <span class="jobtype">${esc(type)}</span> <span class="mono">${esc(String(task.commit ?? '').slice(0, 10))}</span></span>
        ${expected ? '<span class="muted">expected (known bugs)</span>' : ''}
      </div>
      <div class="meta">${esc(task.name)} · task ${esc(task.task)}</div>
      <div class="live-counts">
        <span><b>${count(bugs)}</b> bug${bugs === 1 ? '' : 's'}</span>
        <span><b>${count(task.found)}</b> found</span>
        <span><b>${count(task.replayed)}</b> replayed · <b>${count(task.reproduced)}</b> reproduced</span>
        <span><b>${hit.length} / ${count(task.configurations)}</b> configurations hit${hit.length ? ` (${hit.map(esc).join(', ')})` : ''}</span>
      </div>
    </a>`;
}

async function Main() {
  const root = document.getElementById('report');
  let live;
  try {
    const response = await fetch('live.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    live = await response.json();
  } catch (error) {
    root.innerHTML = `<div class="wrap"><p class="unconf">Cannot read live.json: ${esc(error.message)}</p></div>`;
    return;
  }
  // the unexpected finds first, then by number of bugs and objectives
  const tasks = [...(live.tasks ?? [])].sort((a, b) =>
      (EXPECTED.has(a.job_type) - EXPECTED.has(b.job_type)) || ((b.bugs ?? 0) - (a.bugs ?? 0)) || ((b.found ?? 0) - (a.found ?? 0)));
  const unexpected = tasks.filter(task => !EXPECTED.has(task.job_type)).length;
  document.title = tasks.length ? `🐞 Live objectives (${tasks.length})` : 'Live objectives';
  root.innerHTML = `
    <div class="top">
      <h1>Live objectives</h1>
      <div class="meta"><span class="live">● updated ${esc(live.updated ?? '?')}</span> · running tasks whose fuzzers
        found objectives${tasks.length ? ` · ${tasks.length} task${tasks.length > 1 ? 's' : ''}, ${unexpected} outside VulnA/VulnB` : ''}
        · finished tasks: 🐞 on the History</div>
    </div>
    <div class="wrap">
      ${tasks.length ? tasks.map(Row).join('') : '<p class="muted">No running task with objectives.</p>'}
    </div>`;

  // commit lines: commit, PR and message (git_restapi)
  const shas = [...new Set(tasks.map(task => task.commit).filter(sha => /^[0-9a-f]{7,40}$/i.test(sha ?? '')))];
  if (shas.length) {
    const gitRestApi = `${location.protocol}//${location.hostname}:10081`;
    const descs = await resolveCommits(gitRestApi, 'tlspuffin', shas).catch(() => null);
    root.querySelectorAll('.commit-line[data-commit]').forEach(span => {
      const desc = descs?.get(span.dataset.commit);
      if (!desc || desc.kind === 'unknown') return;
      const { type } = parseTaskName(span.dataset.name ?? '', span.dataset.commit);
      span.innerHTML = commitLineHTML(desc, { prefix: type || span.dataset.type || '', max: 90 });
    });
  }
  // reloads every minute, unless the help is open
  setInterval(() => { if (!document.querySelector('.pb-help.open')) location.reload(); }, 60000);
}

Main();
