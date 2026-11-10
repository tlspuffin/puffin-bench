// Commit context shared by the results dashboard and the scheduler pages: which pull request(s) a tlspuffin commit
// belongs to, and a one-line description of it, e.g. "Perf@dcf9ff #453 [TLS:Mapper] reduce # of built-in lists".
//
// A commit is described from the git_restapi data (message, date) and its list of pull requests:
//   - merge: the commit merged a PR on its branch; its subject says so, either "<title> (#453)" (squash merge) or
//     "Merge pull request #453 from <branch> <title>";
//   - tip: the commit is the head of a PR (open PRs from the git_restapi history; all PRs, newest first);
//   - member: an intermediate commit of a PR, shown "#453·3/7" (3rd of the 7 commits of the PR; from the "pulls" of
//     the git_restapi logs, which also give the tips of closed PRs);
//   - otherwise "[NO_PR]".
// sshpuffin lives in the same repository, so the GitHub links are the same for every project.

export const REPO_URL = 'https://github.com/tlspuffin/tlspuffin';
export const DEFAULT_MAX_MESSAGE = 60;

export const commitURL = (sha) => `${REPO_URL}/commit/${sha}`;
export const prURL = (number) => `${REPO_URL}/pull/${number}`;

// Short type of a scheduler task from its default name (see the job configs: "Performance - <sha>", ...)
const TASK_TYPES = [
  [/^Performance\b/i, 'Perf'],
  // the scheduler drops the parentheses of the task names: "Vulnerabilities group A search - <sha>"
  [/^Vulnerabilities \(?group A\b/i, 'VulnA'],
  [/^Vulnerabilities \(?group B\b/i, 'VulnB'],
  [/^Vulnerabilit/i, 'Vuln'],
  [/^Campaign\b/i, 'Camp'],
];

// { type, custom } of a task name: the short type of a default name ("Performance - <sha>"), or the name itself
// when it was typed by the user (custom)
export function parseTaskName(name, sha) {
  const text = String(name ?? '').trim();
  const isDefault = sha && new RegExp(`^[^-]+(\\([^)]*\\)[^-]*)?- (Commit )?${sha.slice(0, 7)}[0-9a-f]*$`, 'i').test(text);
  const type = TASK_TYPES.find(([re]) => re.test(text))?.[1] ?? '';
  return isDefault ? { type, custom: '' } : { type: '', custom: text };
}

// PR merged by a commit, from its subject: { number, title } or null
export function parseMergedPR(subject) {
  const text = String(subject ?? '').trim();
  let m = /^Merge pull request #(\d+) from (\S+)\s*(.*)$/.exec(text);
  if (m) return { number: Number(m[1]), title: m[3] || m[2] };
  m = /^(.*?)\s*\(#(\d+)\)$/.exec(text);
  if (m) return { number: Number(m[2]), title: m[1] };
  return null;
}

// Description of a commit.
//   commit: { id, comment, date } (git_restapi: dev commits, branches, logs) or a PR entry { id, comment, number }
//   prs:    open PRs of the git_restapi history ([{ number, id, comment, updated_at }])
//   prRefs: optional map sha -> [{ number, index, total }]; by default the commit's own "pulls" (git_restapi logs:
//           every PR containing the commit, with its position in it; index === total: tip)
export function describeCommit(commit, prs = [], prRefs = null) {
  const sha = String(commit?.id ?? '');
  const subject = String(commit?.comment ?? '').split('\n')[0];
  const desc = { sha, short: sha.slice(0, 6), date: commit?.date ?? '', subject, title: subject, kind: 'none', prs: [] };
  // a commit without message nor PR number was not found in the git history: no claim about its PR
  if (!subject && !Number.isInteger(commit?.number)) desc.kind = 'unknown';
  const merged = parseMergedPR(subject);
  if (merged) {
    desc.kind = 'merge';
    desc.title = merged.title;
    desc.prs = [{ number: merged.number }];
    return desc;
  }
  // PR tips: the PR entry itself, the open PRs with this head, then the PR refs; newest PR first
  const tips = new Map();
  if (Number.isInteger(commit?.number)) tips.set(commit.number, commit.comment);
  for (const pr of prs ?? []) {
    if (pr?.id === sha && Number.isInteger(pr.number)) tips.set(pr.number, pr.comment);
  }
  const refs = prRefs?.get?.(sha) ?? (Array.isArray(commit?.pulls) ? commit.pulls : []);
  for (const ref of refs) {
    if (ref.index === ref.total && !tips.has(ref.number)) tips.set(ref.number, '');
  }
  if (tips.size > 0) {
    desc.kind = 'tip';
    desc.prs = [...tips.keys()].sort((a, b) => b - a).map(number => ({ number }));
    const first = tips.get(desc.prs[0].number);
    if (first && !subject) desc.title = first;
    return desc;
  }
  const members = refs.filter(ref => ref.index < ref.total).sort((a, b) => b.number - a.number);
  if (members.length > 0) {
    desc.kind = 'member';
    desc.prs = members.map(ref => ({ number: ref.number, index: ref.index, total: ref.total }));
  }
  return desc;
}

function escapeHTML(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(text, max) {
  const chars = [...String(text)];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

const prLabel = (pr) => `#${pr.number}${pr.index ? `·${pr.index}/${pr.total}` : ''}`;

// Hover text: everything, unshortened
export function commitTooltip(desc, extra = '') {
  const kinds = {
    merge: `merge of PR ${desc.prs.map(prLabel).join(', ')}`,
    tip: `tip of PR ${desc.prs.map(prLabel).join(', ')}`,
    member: `commit ${desc.prs.map(pr => `${pr.index}/${pr.total} of PR #${pr.number}`).join(', ')}`,
    none: 'commit without pull request',
    unknown: 'commit not found in the git history',
  };
  return [desc.sha, kinds[desc.kind], desc.date && `date: ${desc.date}`, desc.subject, extra].filter(Boolean).join('\n');
}

// One-line HTML: "<prefix>@<short sha> #<PR> <message>" with links (hash -> commit, #N -> PR), the message capped to
// options.max characters and everything in the hover. options: { prefix, custom, max, message (false: no message) }
export function commitLineHTML(desc, options = {}) {
  const max = options.max ?? DEFAULT_MAX_MESSAGE;
  const parts = [];
  if (options.custom) parts.push(`<span class="ci-custom">${escapeHTML(options.custom)}</span><span class="ci-sep"> · </span>`);
  const prefix = options.prefix ? `${escapeHTML(options.prefix)}@` : '';
  parts.push(`<span class="ci-ref">${prefix}<a class="ci-sha" href="${commitURL(desc.sha)}" target="_blank" rel="noopener">${escapeHTML(desc.short || '?')}</a></span>`);
  if (desc.kind === 'unknown') {
    // nothing known about its PR
  } else if (desc.prs.length > 0) {
    parts.push(' ' + desc.prs.map(pr =>
        `<a class="ci-pr" href="${prURL(pr.number)}" target="_blank" rel="noopener">${escapeHTML(prLabel(pr))}</a>`).join(','));
  } else {
    parts.push(' <span class="ci-nopr">[NO_PR]</span>');
  }
  if (options.message !== false && desc.title) {
    parts.push(` <span class="ci-msg">${escapeHTML(truncate(desc.title, max))}</span>`);
  }
  return `<span class="commit-line" title="${escapeHTML(commitTooltip(desc, options.extra))}">${parts.join('')}</span>`;
}

// Plain text of the same line (tick labels, text-only places)
export function commitLineText(desc, options = {}) {
  const max = options.max ?? DEFAULT_MAX_MESSAGE;
  const ref = `${options.prefix ? `${options.prefix}@` : ''}${desc.short || '?'}`;
  const prs = desc.kind === 'unknown' ? '' : (desc.prs.length > 0 ? desc.prs.map(prLabel).join(',') : '[NO_PR]');
  const msg = options.message !== false && desc.title ? ` ${truncate(desc.title, max)}` : '';
  return `${options.custom ? `${options.custom} · ` : ''}${ref}${prs ? ` ${prs}` : ''}${msg}`;
}

// Commits already loaded by the page (results dashboard: history, PRs, branches, logs), for the places that only
// have a commit id (graph ticks)
const known = new Map();
export function registerCommits(commits, prs = []) {
  for (const commit of commits ?? []) {
    if (commit?.id) known.set(commit.id, describeCommit(commit, prs));
  }
}
export const knownCommit = (sha) => known.get(sha) ?? null;

// Plotly text (tick labels): "<prefix> 5c5·#540·09/26" — the harness (prefix), the first 3 characters of the hash, the
// PR ("—" without PR) and the commit month/year, with plotly links; the graphs show it vertically, the harness at
// the bottom; the full commit is in the hover (DecorateGraphXTicks)
export function commitPlotlyLabel(desc, prefix = '') {
  const link = (href, text) => `<a href="${href}" target="_blank">${escapeHTML(text)}</a>`;
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(desc.date ?? '');
  const parts = [link(commitURL(desc.sha), (desc.short || '?').slice(0, 3))];
  if (desc.kind !== 'unknown') {
    parts.push(desc.prs.length > 0 ? desc.prs.map(pr => link(prURL(pr.number), prLabel(pr))).join(',') : '—');
  }
  if (date) parts.push(`${date[2]}/${date[1].slice(2)}`);
  // the prefix is markup of the caller (e.g. a colored letter)
  return `${prefix ? `${prefix} ` : ''}${parts.join('·')}`;
}

// Commits of the git_restapi (history: PR list; logs: message and date of given commits), for pages that do not
// load the history themselves (scheduler). Resolves to a map sha -> description; unknown commits get a description
// with the short hash only, so callers can always render.
const cache = new Map();
let prsPromise = null;
async function loadPullRequests(gitRestApi, project) {
  try {
    const response = await fetch(`${gitRestApi}/api/git/history/${project}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json())?.PR ?? [];
  } catch (error) {
    prsPromise = null; // retried on the next call
    return [];
  }
}
async function loadLogs(gitRestApi, project, shas) {
  try {
    const response = await fetch(`${gitRestApi}/api/git/logs/${project}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commits: shas }) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json())?.commits ?? [];
  } catch (error) {
    return null;
  }
}
export async function resolveCommits(gitRestApi, project, shas) {
  const wanted = [...new Set(shas.filter(sha => /^[0-9a-f]{7,40}$/i.test(sha ?? '')))];
  const missing = wanted.filter(sha => !cache.has(sha));
  if (missing.length === 0) return new Map(wanted.map(sha => [sha, cache.get(sha)]));
  prsPromise ??= loadPullRequests(gitRestApi, project);
  const [logs, prs] = await Promise.all([loadLogs(gitRestApi, project, missing), prsPromise]);
  const result = new Map();
  for (const sha of wanted) {
    if (cache.has(sha)) {
      result.set(sha, cache.get(sha));
      continue;
    }
    const log = logs?.find(item => item.id === sha || item.id?.startsWith(sha));
    const desc = describeCommit(log ?? { id: sha }, prs);
    // git_restapi unreachable: not cached, retried on the next call
    if (logs !== null) cache.set(sha, desc);
    result.set(sha, desc);
  }
  return result;
}
