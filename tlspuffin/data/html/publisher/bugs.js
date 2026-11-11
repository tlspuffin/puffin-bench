// Bugs reference: tlspuffin's vulnerability catalogue in full, generated from the vulnerabilities.toml files of dev
// (git_restapi; "Reload from the latest dev" has it fetch GitHub first; ?commit=<sha>: another commit's; #<ID>: one
// entry; while dev has none, that of the open pull request updated last that has one), the expected bug of each Vuln
// configuration and the CVEs set apart (vuln_targets.json, the file to edit), and the registry of the bugs found so
// far per library (known_bugs.json, written by tools/known_bugs.js). The overview shows each bug as the launcher's
// custom benchmarks do: where it can run (the presets of the catalogue's commit), the bench's time to find it
// (runs/bench_times.json, written by runs_report.py), how a find is confirmed; with filters.
import '../board/nav.js';
import { urls } from './summary_config.js';
import { presentOn, patchedAt, runOptions, confirmation, needsAsan } from '../common/catalogue.js';

const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const TARGETS = '/html/jobsscripts/tlspuffin/vuln_targets.json';
const KNOWN = '/html/objectives/known_bugs.json';
// the file in the repository at the deployed commit (board/version.json, written by deploy.sh), else on main
const REPO_FILE = 'tlspuffin/data/html/jobsscripts/tlspuffin/vuln_targets.json';

const load = url => fetch(url, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
// the catalogue shown: dev's (what validation trusts) or a commit's (?commit=<sha>, e.g. a PR adding a bug)
const askedCommit = new URLSearchParams(window.location.search).get('commit') ?? '';
const catalogueRef = /^[0-9a-f]{7,40}$/i.test(askedCommit) ? askedCommit : 'dev';
const CATALOGUE = `${urls.git_restapi}/api/git/catalogue/tlspuffin/${catalogueRef}`;
// the configurations of Vuln group A and B, as deployed with the bench
const JOBS = [['Vuln group A', 'vuln-a', '/html/jobsscripts/tlspuffin/PR_vulnerabilities-groupA_cargo.json'],
              ['Vuln group B', 'vuln-b', '/html/jobsscripts/tlspuffin/PR_vulnerabilities-groupB_cargo.json']];
const [targets, known, version, firstCatalogue, ...jobConfigs] = await Promise.all([load(TARGETS), load(KNOWN), load('/html/board/version.json'),
  load(CATALOGUE), ...JOBS.map(([, , url]) => load(url))]);
let catalogue = firstCatalogue;
// dev without catalogue (before tlspuffin pr/vuln-catalogue is merged): the catalogue of the open pull request updated
// last that has one (git_restapi's history of tlspuffin), said so on the page
let shownPR = null, devCatalogue = null;
async function fallbackCatalogue(refresh = false) {
  if (catalogueRef !== 'dev' || catalogue?.format !== 'none') return;
  // refresh: git_restapi asks GitHub for the pull requests first (their heads move: a push to the PR)
  const history = await load(`${urls.git_restapi}/api/git/history/tlspuffin${refresh ? '?refresh=all' : ''}`);
  const open = (history?.PR ?? []).filter(pr => pr.state === 'open' && /^[0-9a-f]{40}$/.test(pr.id ?? ''))
    .sort((a, b) => String(b.updated_at ?? b.date ?? '').localeCompare(String(a.updated_at ?? a.date ?? ''))).slice(0, 10);
  for (const pr of open) {
    const c = await load(`${urls.git_restapi}/api/git/catalogue/tlspuffin/${pr.id}`);
    if (c?.format === 'vulnerabilities.toml') { devCatalogue = catalogue; catalogue = c; shownPR = pr; return; }
  }
}
await fallbackCatalogue();
// the bench's time to find each bug (Vuln group A and B), as the launcher shows it
const benchTimes = await load(new URL('../runs/bench_times.json', import.meta.url).href);
// the overview's filters
const filters = { lib: '', cat: '', puffin: false, nowitness: true };
// the presets of the catalogue's commit (git_restapi), to check the builds of the configurations against the catalogue
const loadPresets = c => (c?.format === 'vulnerabilities.toml' && /^[0-9a-f]{40}$/.test(c.commit ?? '')) ? load(`${urls.git_restapi}/api/git/presets/tlspuffin/${c.commit}`) : Promise.resolve(null);
let presetsAt = await loadPresets(catalogue);
// "Reload from the latest dev": when it last fetched, or why it failed
let reloaded = null, reloadError = null;
const REPO = `${version?.repository ?? 'https://github.com/tlspuffin/puffin-bench'}/blob/${/^[0-9a-f]{40}$/.test(version?.commit ?? '') ? version.commit : 'main'}/${REPO_FILE}`;

const presets = Object.entries(targets ?? {}).filter(([key]) => !key.startsWith('_'));
const apart = Object.entries(targets?._not_targeted ?? {});
const cveTable = Object.entries(targets?._cves ?? {}).filter(([key]) => !key.startsWith('_'));
const NVD = cve => `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cve)}`;
const cveLink = cve => `<a href="${NVD(cve)}" target="_blank" rel="noopener">${esc(cve)}</a>${targets?._cves?.[cve]?.alias ? ` <span class="muted">${esc(targets._cves[cve].alias)}</span>` : ''}`;
// the CVE of a registry entry: the target of its configuration (the preset whose CVE has that alias) when its
// rule matches, or a claim set apart; null otherwise
function CveOf(library, b) {
  const text = `${b.sig} ${b.what ?? ''}`;
  for (const [, t] of presets) {
    if (targets?._cves?.[t.cve]?.alias !== library) continue;
    if (t.kind === 'claim' ? b.kind === 'claim' && b.sig === t.match : b.kind !== 'claim' && text.includes(t.match)) return { cve: t.cve, how: 'expected' };
  }
  const nt = targets?._not_targeted?.[b.sig];
  if (b.kind === 'claim' && nt) return { cve: nt.cve ?? nt, how: nt.library ? `set apart on ${nt.library} < ${nt.below}` : 'set apart' };
  return null;
}
const rule = t => t.kind === 'claim' ? `claim <code>${esc(t.match)}</code>` : `crash with <code>${esc(t.match)}</code> among the top 3 frames`;

// ---- tlspuffin's catalogue: an overview, then every entry in full (its fields: puffin-build/README.md of tlspuffin)
const TLSPUFFIN = 'https://github.com/tlspuffin/tlspuffin';
const LIBRARY = { wolfssl: 'wolfSSL', openssl: 'OpenSSL', libressl: 'LibreSSL', boringssl: 'BoringSSL', libssh: 'libssh', wolfssh: 'wolfSSH' };
const libraryName = vendor => LIBRARY[vendor] ?? vendor;
const SEVERITY = score => score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : score > 0 ? 'low' : 'none';
const CVSS_METRICS = {
  AV: ['attack vector', { N: 'network', A: 'adjacent', L: 'local', P: 'physical' }],
  AC: ['attack complexity', { L: 'low', H: 'high' }],
  PR: ['privileges required', { N: 'none', L: 'low', H: 'high' }],
  UI: ['user interaction', { N: 'none', R: 'required' }],
  S: ['scope', { U: 'unchanged', C: 'changed' }],
  C: ['confidentiality', { H: 'high', L: 'low', N: 'none' }],
  I: ['integrity', { H: 'high', L: 'low', N: 'none' }],
  A: ['availability', { H: 'high', L: 'low', N: 'none' }],
};
const cvssMetrics = vector => String(vector ?? '').split('/').slice(1).map(part => {
  const [key, value] = part.split(':');
  const metric = CVSS_METRICS[key];
  return metric ? `<span class="metric" title="${esc(part)}">${esc(metric[0])} <b>${esc(metric[1][value] ?? value)}</b></span>` : `<code>${esc(part)}</code>`;
}).join(' ');
const idLink = id => `<a class="mono" href="#${esc(id)}"><b>${esc(id)}</b></a>`;
const external = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text ?? url)}</a>`;
const shortUrl = url => String(url).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
const codes = list => (list ?? []).map(x => `<code>${esc(x)}</code>`).join(' ');
const assignments = map => Object.entries(map ?? {}).map(([k, v]) => `<code>${esc(k)} = ${esc(v)}</code>`).join(' ');
const duration = s => {
  if (!Number.isFinite(Number(s))) return '—';
  const t = Math.round(Number(s));
  return t < 60 ? `${t} s` : t < 3600 ? `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, '0')} s`
    : `${Math.floor(t / 3600)} h ${String(Math.floor(t % 3600 / 60)).padStart(2, '0')}`;
};
// a definition list; rows without value are left out
const dl = rows => {
  const kept = rows.filter(([, value]) => value !== '' && value !== null && value !== undefined);
  return kept.length ? `<dl>${kept.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('')}</dl>` : '<p class="muted">—</p>';
};
const box = (title, body, cls = '') => `<div class="box ${cls}"><h4>${title}</h4>${body}</div>`;
const oracleText = o => !o ? '<span class="muted">none (no witness)</span>'
  : `${esc(o.kind)}${['signal', 'asan', 'violation', 'panic'].filter(k => o[k]).map(k => ` <span class="muted">${k}</span> <code>${esc(o[k])}</code>`).join('')}`;
// an upstream fix: a URL, or a commit of the library's repository (presets.toml)
const upstreamLink = (repository, upstream) => {
  if (!upstream) return '<span class="muted">—</span>';
  if (/^https?:\/\//.test(upstream)) return external(upstream, shortUrl(upstream));
  if (/^[0-9a-f]{7,40}$/i.test(upstream) && /^https:\/\/(github\.com|gitlab\.com)\//.test(repository ?? '')) {
    const commitUrl = repository.includes('gitlab.com') ? `${repository}/-/commit/${upstream}` : `${repository}/commit/${upstream}`;
    return `${external(commitUrl, upstream)} <span class="muted">(${esc(shortUrl(repository))})</span>`;
  }
  return `<code>${esc(upstream)}</code>`;
};
// the fields each part of a card shows; any other field is listed under "Other fields"
const SHOWN = new Set(['alias', 'summary', 'category', 'cwe', 'cvss', 'no_cvss', 'affected', 'affected_commits', 'requires',
  'capabilities', 'put_options', 'bug_in_harness', 'replayable', 'oracle', 'top_frames', 'reference', 'check', 'references',
  'also_triggers', 'witness_versions', 'no_witness', 'no_patch', 'find', 'patches', 'fingerprint', 'patch_hashes', 'toml']);
const SHOWN_IN = { find: ['by_puffin', 'since', 'features', 'flags', 'asan', 'time', 'notes'], cvss: ['version', 'score', 'vector', 'source'],
  oracle: ['kind', 'signal', 'asan', 'violation', 'panic'] };
const PATCH_SHOWN = ['target', 'versions', 'commits', 'files', 'upstream'];
const TIME_SHOWN = ['mean_s', 'median_s', 'runs', 'found', 'budget_s', 'cores', 'commit', 'preset', 'source'];
const raw = v => `<code>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</code>`;

function entryCard(vendor, id, e) {
  const repository = catalogue?.vendors?.[vendor]?.repository;
  const f = e.find ?? {};
  const severity = e.cvss ? SEVERITY(Number(e.cvss.score)) : null;
  const patches = e.patches ?? [];
  const others = [
    ...Object.entries(e).filter(([k]) => !SHOWN.has(k)),
    ...Object.entries(SHOWN_IN).flatMap(([field, shown]) =>
      Object.entries(e[field] ?? {}).filter(([k]) => !shown.includes(k)).map(([k, v]) => [`${field}.${k}`, v])),
    ...Object.entries(f.time ?? {}).filter(([k]) => !TIME_SHOWN.includes(k)).map(([k, v]) => [`find.time.${k}`, v]),
  ];
  const t = f.time;
  const timeText = t ? `${t.median_s != null ? `median <span title="${esc(t.median_s)} s">${duration(t.median_s)}</span>` : ''}${t.mean_s != null ? `${t.median_s != null ? ', ' : ''}mean <span title="${esc(t.mean_s)} s">${duration(t.mean_s)}</span>` : ''}`
    + `, found ${esc(t.found)}/${esc(t.runs)} · ${esc(t.cores)} cores, budget <span title="${esc(t.budget_s)} s">${duration(t.budget_s)}</span>`
    + ` · ${esc(t.preset)} at ${external(`${TLSPUFFIN}/commit/${t.commit}`, String(t.commit ?? '').slice(0, 10))}<br><span class="muted">${esc(t.source)}</span>` : '';
  const cwe = !e.cwe ? '' : /^CWE-\d+$/.test(e.cwe) ? external(`https://cwe.mitre.org/data/definitions/${e.cwe.slice(4)}.html`, e.cwe) : esc(e.cwe);
  const where = dl([
    ['library versions', e.affected ? `<code>${esc(e.affected)}</code>` : ''],
    ['tlspuffin commits', e.affected_commits ? `<code>${esc(e.affected_commits)}</code> <span class="muted">(a bug of the harness code)</span>` : ''],
    ['witness reaches it on', e.witness_versions ? `<code>${esc(e.witness_versions)}</code> <span class="muted">(elsewhere its witness is not expected to trigger it)</span>` : ''],
    [`<code>${esc(vendor)}:${esc(id)}</code> builds`, e.reference ? `<code>${esc(e.reference)}</code>` : '<span class="muted">the newest preset with the bug, ASan presets first</span>'],
    ['CI also checks it on', codes(e.check)],
  ]);
  const needs = dl([
    ['build options', assignments(e.requires)],
    ['PUT capabilities', codes(e.capabilities)],
    ['PUT options', assignments(e.put_options)],
    ['cargo features', codes(f.features)],
    ['fuzzer flags', codes(f.flags)],
    ['ASan', f.asan ? 'needed: only detected with ASan' : ''],
  ]);
  const o = e.oracle;
  const shows = dl([
    ['oracle', o ? `<b>${esc(o.kind)}</b> <span class="muted">${o.kind === 'claim' ? '(the security oracle reports a violation)' : '(the execution crashes: signal, sanitizer report or panic)'}</span>`
      : '<span class="muted">none: its objectives cannot be recognised</span>'],
    ['signal', o?.signal ? `<code>${esc(o.signal)}</code>` : ''],
    ['ASan report', o?.asan ? `<code>${esc(o.asan)}</code>` : ''],
    ['violation', o?.violation ? `<code>${esc(o.violation)}</code>` : ''],
    ['panic', o?.panic ? `<code>${esc(o.panic)}</code>` : ''],
    ['top frames', (e.top_frames ?? []).length ? `${codes(e.top_frames)} <span class="muted">(shown to people, never used to decide)</span>` : ''],
    ['objectives replay', e.replayable === false ? '<b>no</b>: objectives found by fuzzing do not reproduce on replay' : 'yes'],
    ['its witness also triggers', codes(e.also_triggers)],
    ['a bug of', e.bug_in_harness ? '<b>the fuzzing harness</b>, not of the library' : 'the library'],
  ]);
  const patchesHtml = patches.length
    ? `<table class="patches"><tr><th>for</th><th>files</th><th>upstream fix</th></tr>${patches.map(p => {
        const extra = Object.entries(p).filter(([k]) => !PATCH_SHOWN.includes(k));
        const scope = p.commits && !p.versions ? `tlspuffin commits <code>${esc(p.commits)}</code>` : `versions <code>${esc(p.versions ?? '')}</code>`;
        return `<tr><td>${scope}${p.target ? ` <span class="muted">(target ${esc(p.target)})</span>` : ''}</td>
          <td>${(p.files ?? []).map(file => `${external(`${TLSPUFFIN}/blob/${catalogue.commit}/puffin-build/vendors/${vendor}/${file}`, file)}`
            + ` <span class="muted mono" title="sha256 ${esc(e.patch_hashes?.[file] ?? '')}">${esc(String(e.patch_hashes?.[file] ?? '').slice(0, 12))}</span>`).join('<br>')}</td>
          <td>${upstreamLink(repository, p.upstream)}${extra.map(([k, v]) => `<br><span class="muted">${esc(k)}</span> ${raw(v)}`).join('')}</td></tr>`;
      }).join('')}</table>
      <p class="muted">A find on these versions is validated by patch differential; an affected version outside them has no patch: its finds are confirmed by their signature only.${e.no_patch ? ` ${esc(e.no_patch)}` : ''}</p>`
    : `<p><span class="badge b-unexp">no patch</span> ${esc(e.no_patch ?? '')}</p><p class="muted">Its finds cannot be validated by patch differential, only recognised by their signature.</p>`;
  const witness = e.no_witness
    ? `<p><span class="badge b-unexp">no witness</span> ${esc(e.no_witness)}</p><p class="muted">The entry cannot be checked on executions.</p>`
    : `<p><span class="badge b-exp">✓ witness</span> a trace in tlspuffin, registered with <code class="nowrap">#[puffin::witness("${esc(id)}")]</code>.</p>
       <p class="muted">tlspuffin's catalogue test runs it with and without the patch (<code class="nowrap">cargo test -p tlspuffin --features cputs --test catalogue</code>); the bench's validation step runs it as a control.</p>`;
  const found = e.find ? dl([
    ['first found by puffin', f.by_puffin ? '<b>yes</b> <span class="star">★</span> (new when puffin found it)' : 'no (known before)'],
    ['since', f.since ? external(`${TLSPUFFIN}/commit/${f.since}`, String(f.since)) : ''],
    ['time to find', timeText],
    ['notes', f.notes ? esc(f.notes) : ''],
  ]) : '<p class="muted">—</p>';
  const severityHtml = dl([
    ['CVSS', e.cvss ? `<span class="sev sev-${severity}">${esc(e.cvss.score)} ${severity}</span> <span class="muted">v${esc(e.cvss.version)}, source ${esc(e.cvss.source)}</span>`
      : `<span class="muted">none${e.no_cvss ? `: ${esc(e.no_cvss)}` : ''}</span>`],
    ['vector', e.cvss?.vector ? `<code>${esc(e.cvss.vector).replace(/\//g, '/<wbr>')}</code><div class="metrics">${cvssMetrics(e.cvss.vector)}</div>` : ''],
    ['weakness', cwe],
    ['category', esc(e.category)],
  ]);
  const references = (e.references ?? []).length ? `<ul class="refs">${e.references.map(url => `<li>${external(url, shortUrl(url))}</li>`).join('')}</ul>` : '<p class="muted">—</p>';
  return `<details class="entry${e.bug_in_harness ? ' harness' : ''}" id="${esc(id)}">
    <summary class="entry-head"><div class="head-line">
      <a class="eid" href="#${esc(id)}" title="Link to this bug">${esc(id)}</a>${e.alias ? `<b class="alias">${esc(e.alias)}</b>` : ''}${f.by_puffin ? '<span class="star" title="first found by puffin">★</span>' : ''}
      <span class="tag">${esc(libraryName(vendor))}</span><span class="tag">${esc(e.category)}</span>
      ${e.cvss ? `<span class="sev sev-${severity}" title="CVSS ${esc(e.cvss.version)}">CVSS ${esc(e.cvss.score)} · ${severity}</span>` : '<span class="sev">no CVSS</span>'}
      ${patches.length ? `<span class="badge b-exp" title="validated by patch differential">✓ patch ${patches.map(p => esc(p.versions ?? p.commits ?? '')).join(' · ')}</span>` : '<span class="badge b-unexp">no patch</span>'}
      ${e.no_witness ? '<span class="badge b-unexp">no witness</span>' : '<span class="badge b-exp">✓ witness</span>'}${e.replayable === false ? ' <span class="badge b-apart">does not replay</span>' : ''}${e.bug_in_harness ? ' <span class="badge b-apart">🔧 harness</span>' : ''}
      <span class="spacer"></span>${id.startsWith('CVE-') ? external(NVD(id), 'NVD ↗') : ''}
    </div><p class="lead">${esc(e.summary)}</p></summary>
    <div class="grid">
      ${box('Where it is', where)}
      ${box('What it needs', needs)}
      ${box('How it shows', shows)}
      ${box('Witness', witness)}
      ${box('Patches', patchesHtml, 'wide')}
      ${box('Severity', severityHtml)}
      ${box('Found by fuzzing', found)}
      ${box('References', references)}
      ${others.length ? box('Other fields', dl(others.map(([k, v]) => [`<code>${esc(k)}</code>`, raw(v)]))) : ''}
    </div>
    <div class="foot muted">fingerprint <code title="${esc(e.fingerprint ?? '')}">${esc(String(e.fingerprint ?? '').slice(0, 16))}</code> (its fields and patch files: the bench compares an entry between commits with it)
      · ${external(`${TLSPUFFIN}/blob/${catalogue.commit}/puffin-build/vendors/${vendor}/vulnerabilities.toml`, `puffin-build/vendors/${vendor}/vulnerabilities.toml`)}</div>
    ${e.toml ? `<details class="toml"><summary>TOML source, with its comments</summary><pre>${esc(e.toml)}</pre></details>` : ''}
  </details>`;
}

// the presets of the catalogue's commit a bug can run on, as the launcher offers them (the first: the one it picks)
const runOn = (vendor, id, e) => {
  if (!presetsAt) return '<span class="muted">—</span>';
  const options = runOptions(id, e, presetsAt.vendors?.[vendor]);
  if (!options.length) return '<span class="muted">no preset of this commit has it</span>';
  const one = (p, i) => `<span class="${i === 0 ? 'run-first' : ''}" title="${esc(p.name)}">${esc(p.version)}${p.asan ? ' · ASan' : needsAsan(e) ? ' · + ASan' : ''} · <code>${esc(p.name)}</code>`
    + `${p.patched ? '' : ' <span class="muted">(no patch)</span>'}${p.witness ? '' : ' <span class="muted">(witness does not reach it)</span>'}</span>`;
  const shown = options.slice(0, 3).map(one).join('<br>');
  return options.length > 3 ? `${shown}<details class="more"><summary>${options.length - 3} more</summary>${options.slice(3).map((p, i) => one(p, i + 3)).join('<br>')}</details>` : shown;
};
const timeToFind = (id, e) => {
  const t = benchTimes?.bugs?.[e.alias ?? id] ?? benchTimes?.bugs?.[id];
  if (!t) return '<span class="muted" title="Vuln group A and B have no run of it">—</span>';
  return `<span title="${esc(`task ${t.task} (${t.job}) at tlspuffin ${String(t.commit ?? '').slice(0, 9)} of ${String(t.date ?? '').slice(0, 10)}: ${t.cores} cores per attempt, ${duration(t.budget_s)} budget`)}">`
    + `${t.found ? duration(t.median_s) : 'not found'} · ${esc(t.found)}/${esc(t.runs)}</span>`;
};
// the other bugs of the same library with the same oracle: a stop on one of them may be taken for this one
const sameOracle = (vendor, id, e) => e.oracle ? Object.entries(catalogue?.vendors?.[vendor]?.entries ?? {})
  .filter(([other, o]) => other !== id && o.oracle && JSON.stringify(o.oracle) === JSON.stringify(e.oracle)).map(([other, o]) => o.alias ?? other) : [];
const confirmedBy = (vendor, id, e) => {
  const how = confirmation(e);
  const twins = sameOracle(vendor, id, e);
  return `<span class="badge ${how.kind === 'patch' ? 'b-exp' : 'b-unexp'}"${how.kind === 'signature' && e.no_patch ? ` title="${esc(e.no_patch)}"` : ''}>${esc(how.text)}</span>`
    + (twins.length ? `<br><span class="muted">same oracle as ${esc(twins.join(', '))}</span>` : '');
};
const overviewRow = ({ vendor, id, e }) => `<tr><td>${idLink(id)}${e.alias ? ` <b>${esc(e.alias)}</b>` : ''}${e.find?.by_puffin ? ' <span class="star" title="first found by puffin">★</span>' : ''}
    <span class="tag">${esc(e.category)}</span><div class="summary">${esc(e.summary)}</div></td>
  <td>${esc(libraryName(vendor))}</td>
  <td>${e.cvss ? `<span class="sev sev-${SEVERITY(Number(e.cvss.score))}">${esc(e.cvss.score)}</span>` : '<span class="muted">—</span>'}</td>
  <td class="runon">${runOn(vendor, id, e)}<div class="muted">affected <code>${esc(e.affected ?? e.affected_commits ?? '')}</code></div></td>
  <td class="nowrap">${timeToFind(id, e)}</td>
  <td>${confirmedBy(vendor, id, e)}</td>
  <td>${e.no_witness ? `<span class="badge b-unexp" title="${esc(e.no_witness)}">no witness</span>` : '<span class="badge b-exp">✓</span>'}</td>
  <td>${oracleText(e.oracle)}${e.replayable === false ? '<br><span class="muted">does not replay</span>' : ''}</td></tr>`;
const OVERVIEW_HEAD = '<tr><th>bug</th><th>library</th><th>CVSS</th><th>run on <span class="muted">(presets of the commit)</span></th>'
  + '<th>time to find on the bench ⁽ᵗ⁾</th><th>a find is confirmed by</th><th>witness</th><th>oracle</th></tr>';
const overviewTable = list => `<table class="overview">${OVERVIEW_HEAD}${list.map(overviewRow).join('') || '<tr><td colspan="8" class="muted">none</td></tr>'}</table>`;
// the filters of the overview: library, category, first found by puffin, bugs without witness
const kept = list => list.filter(x => (!filters.lib || x.vendor === filters.lib) && (!filters.cat || x.e.category === filters.cat)
  && (!filters.puffin || x.e.find?.by_puffin) && (filters.nowitness || !x.e.no_witness));
const filterRow = entries => {
  const libs = [...new Set(entries.map(x => x.vendor))], cats = [...new Set(entries.map(x => x.e.category).filter(Boolean))].sort();
  const select = (name, values, label, show = v => v) => `<select data-filter="${name}"><option value="">${label}</option>`
    + values.map(v => `<option value="${esc(v)}"${filters[name] === v ? ' selected' : ''}>${esc(show(v))}</option>`).join('') + '</select>';
  return `<div class="filters">Show ${select('lib', libs, 'all libraries', libraryName)} ${select('cat', cats, 'all categories')}
    <label><input type="checkbox" data-filter="puffin"${filters.puffin ? ' checked' : ''}> ★ first found by puffin only</label>
    <label><input type="checkbox" data-filter="nowitness"${filters.nowitness ? ' checked' : ''}> bugs without witness</label></div>`;
};
// the comments heading a vulnerabilities.toml, without their '#'
const preambleText = text => esc(String(text ?? '').split('\n').map(line => line.replace(/^\s*# ?/, '')).join('\n').trim());

function catalogueSection() {
  const where = catalogueRef === 'dev' ? 'dev' : `commit ${esc(catalogueRef)}`;
  const reload = catalogueRef === 'dev'
    ? `<div class="reload"><button type="button" id="reload-dev" title="git_restapi fetches tlspuffin from GitHub, then reads dev's catalogue again">⟳ Reload from the latest dev</button>`
      + `${reloaded ? ` <span class="muted">fetched at ${esc(reloaded)}</span>` : ''}${reloadError ? ` <span class="badge b-unexp">${esc(reloadError)}</span>` : ''}</div>`
    : `<div class="reload"><a href="?">dev's catalogue</a></div>`;
  if (!catalogue) return `<div class="card"><div class="row"><p class="muted">The catalogue of ${where} is not available (git_restapi <a href="${esc(CATALOGUE)}" target="_blank">${esc(CATALOGUE)}</a>).</p>${reload}</div></div>`;
  const at = `<a href="${TLSPUFFIN}/tree/${esc(catalogue.commit)}/puffin-build/vendors" target="_blank" rel="noopener">${esc(catalogue.commit.slice(0, 10))}</a>`
    + (catalogue.date ? ` <span class="muted">(${esc(catalogue.date.slice(0, 10))}${catalogue.subject ? `: ${esc(catalogue.subject)}` : ''})</span>` : '');
  if (catalogue.format === 'none') return `<div class="card"><div class="row"><p class="muted">tlspuffin ${where} (${at}) has no vulnerability catalogue yet (puffin-build/vendors/*/vulnerabilities.toml).</p>${reload}</div></div>`;
  const fallback = shownPR ? `<p class="fallback">dev (<a href="${TLSPUFFIN}/commit/${esc(devCatalogue?.commit ?? '')}" target="_blank" rel="noopener">${esc(String(devCatalogue?.commit ?? '').slice(0, 10))}</a>) has no vulnerability catalogue yet:
      this is the catalogue of pull request <a href="${TLSPUFFIN}/pull/${esc(shownPR.number)}" target="_blank" rel="noopener">#${esc(shownPR.number)}</a> <code>${esc(shownPR.branch)}</code>
      at its head (the open pull request updated last that has one), what validation will trust once it is merged. Another commit: <code>?commit=&lt;sha&gt;</code>.</p>` : '';
  const entries = Object.entries(catalogue.vendors ?? {}).flatMap(([vendor, v]) => Object.entries(v.entries ?? {}).map(([id, e]) => ({ vendor, id, e })));
  const library = entries.filter(x => !x.e.bug_in_harness), harness = entries.filter(x => x.e.bug_in_harness);
  const vendors = Object.entries(catalogue.vendors ?? {}).filter(([, v]) => Object.values(v.entries ?? {}).some(e => !e.bug_in_harness));
  const shownWhere = shownPR ? `PR #${esc(shownPR.number)}` : where;
  return `<div class="card">
      ${fallback}
      <div class="row"><p>The catalogue of tlspuffin ${shownWhere} at ${at}, generated from <code>puffin-build/vendors/&lt;vendor&gt;/vulnerabilities.toml</code>: the only source of what builds, tests and
        validation know about a bug. Each entry has a patch per version range and a witness trace; tlspuffin's catalogue test checks every witness with and without its patch.</p>${reload}</div>
      <p class="muted">${catalogueRef === 'dev' ? 'Another commit (e.g. a PR adding a bug): <code>?commit=&lt;sha&gt;</code>. ' : ''}One bug: <code>#&lt;ID&gt;</code>. ★ first found by puffin.</p>
      ${filterRow(entries)}
      ${overviewTable(kept(library))}
      ${harness.length ? `<h3>🔧 Bugs of the fuzzing harness</h3><p class="muted">Validated the same way, never counted as a vulnerability of the library.</p>${overviewTable(kept(harness))}` : ''}
      <p class="muted">⁽ᵗ⁾ ${esc(benchTimes?.source ?? 'the bench\'s own measurements (Vuln group A and B), when there are')}${benchTimes ? '' : ': none yet'}; hover for the task.
        Run on: the presets of the catalogue's commit the launcher's custom benchmarks offer for the bug, the first the one it picks (a version with its patch first, then the newest, ASan).
        Every field of a bug: click it (its card at the end of the page, <a href="#every-bug">📖 Every bug in full</a>).</p>
    </div>`;
}

// every bug in full, one folded card each, in a section folded too (the end of the page): a link to a bug (#<ID>, the
// tables above, the URL) opens its card
function everyBugSection() {
  if (!catalogue || catalogue.format === 'none') return '';
  const entries = Object.entries(catalogue.vendors ?? {}).flatMap(([vendor, v]) => Object.entries(v.entries ?? {}).map(([id, e]) => ({ vendor, id, e })));
  const library = entries.filter(x => !x.e.bug_in_harness), harness = entries.filter(x => x.e.bug_in_harness);
  const vendors = Object.entries(catalogue.vendors ?? {}).filter(([, v]) => Object.values(v.entries ?? {}).some(e => !e.bug_in_harness));
  return `<details class="every-bug" id="every-bug">
    <summary><h2>📖 Every bug in full <span class="muted">— ${entries.length} bugs, every field of vulnerabilities.toml: open one here, or click a bug above</span></h2></summary>
    ${vendors.map(([vendor, v]) => `<h3 class="library" id="library-${esc(vendor)}">${esc(libraryName(vendor))} — ${Object.values(v.entries ?? {}).filter(e => !e.bug_in_harness).length} bug(s)
        · ${external(`${TLSPUFFIN}/blob/${catalogue.commit}/puffin-build/vendors/${vendor}/vulnerabilities.toml`, `puffin-build/vendors/${vendor}/vulnerabilities.toml`)}</h3>
      ${v.preamble ? `<details class="preamble"><summary>About this file</summary><pre>${preambleText(v.preamble)}</pre></details>` : ''}
      ${library.filter(x => x.vendor === vendor).map(x => entryCard(x.vendor, x.id, x.e)).join('')}`).join('')}
    ${harness.length ? `<h3 class="library">🔧 Bugs of the fuzzing harness</h3>${harness.map(x => entryCard(x.vendor, x.id, x.e)).join('')}` : ''}
  </details>`;
}

// ---- the configurations of Vuln group A and B: each experiment, its expected bug, how it stops, and its build checked
// against the catalogue (dev's, or the commit's shown): every patch of its version but its bug's
const catalogueEntryOf = (lib, alias) => Object.entries(catalogue?.vendors?.[lib]?.entries ?? {}).find(([, e]) => e.alias === alias)?.[0] ?? null;
function expectedBugOf(name, vendorName, declared) {
  const target = targets?.[vendorName];
  // the bug the configuration names (target_bug), with the rule of its preset when there is one
  if (declared) return { id: declared, rule: target?.cve === declared ? target : null };
  if (target?.cve) return { id: target.cve, rule: target };
  const lib = vendorName.split(':')[0];
  const id = catalogueEntryOf(lib, name) ?? Object.entries(targets?._cves ?? {}).find(([cve, c]) => !cve.startsWith('_') && c?.alias === name)?.[0] ?? null;
  return { id, rule: null };
}
function buildCheck(vendorName, id) {
  const [lib, presetName] = vendorName.split(':');
  const preset = (presetsAt?.vendors?.[lib] ?? []).find(p => p.name === presetName);
  const entries = catalogue?.vendors?.[lib]?.entries;
  if (!preset || !entries) return { preset, html: '<span class="muted">— (no catalogue or presets to check against)</span>' };
  const bare = { ...preset, fix: [] };
  const present = Object.entries(entries).filter(([eid, e]) => presentOn(eid, e, bare)).map(([eid]) => eid);
  const should = present.filter(eid => eid !== id && patchedAt(entries[eid], preset.version));
  const actual = preset.fix ?? [];
  const missing = should.filter(eid => !actual.includes(eid)), extra = actual.filter(eid => !should.includes(eid));
  const left = present.filter(eid => eid !== id && !patchedAt(entries[eid], preset.version)).map(eid => entries[eid].alias ?? eid);
  const alias = eid => esc(entries[eid]?.alias ?? eid);
  const ok = missing.length === 0 && extra.length === 0;
  const html = (ok ? `<span class="badge b-exp">✓ every patch but its bug's</span>`
      : `<span class="badge b-unexp">≠ every patch but its bug's</span>`
        + (missing.length ? `<br>not patched: ${missing.map(alias).join(', ')} <span class="muted">(${missing.length > 1 ? 'they have' : 'it has'} a patch at ${esc(preset.version)})</span>` : '')
        + (extra.length ? `<br>patched although ${extra.includes(id) ? 'it is its own bug' : 'not expected'}: ${extra.map(alias).join(', ')}` : ''))
    + (left.length ? `<br><span class="muted">left, no patch at ${esc(preset.version)}: ${esc(left.join(', '))}</span>` : '');
  return { preset, html, ok };
}
function vulnConfigsSection() {
  const where = catalogueRef === 'dev' ? "dev's catalogue" : `the catalogue of ${esc(catalogueRef)}`;
  return JOBS.map(([label, jobType, url], i) => {
    const configs = Object.entries(jobConfigs[i]?.configurations ?? {});
    return `<h3>${esc(label)} <span class="muted">(job type <code>${esc(jobType)}</code>, <a href="${esc(url)}" target="_blank">its configuration ↗</a>)</span></h3>
      <table class="configs"><tr><th>experiment</th><th>vendor</th><th>expected bug</th><th>stops on</th><th>build</th><th>vs ${where}</th><th>run with</th></tr>
      ${configs.map(([name, c]) => {
        const vendorName = c.args?.vendor ?? '';
        const bug = expectedBugOf(name, vendorName, c.args?.target_bug);
        const check = buildCheck(vendorName, bug.id);
        const p = check.preset;
        return `<tr><td><b>${esc(name)}</b></td><td class="mono">${esc(vendorName)}</td>
          <td>${bug.id ? (Object.values(catalogue?.vendors ?? {}).some(v => v.entries?.[bug.id]) ? bugLink(bug.id) : cveLink(bug.id)) : '<span class="muted">—</span>'}</td>
          <td>${bug.rule ? rule(bug.rule) : c.args?.target_bug ? '<span class="muted">its first objective that is not set apart</span>' : '<span class="muted">no target declared: its first objective that is not set apart</span>'}${c.args?.target_bug ? `<br><span class="muted">confirmed as ${esc(bug.id)} during the attempt (patch differential, else its signature on the build with every patch), on commits with the catalogue; otherwise as before</span>` : ''}</td>
          <td>${p ? `${esc(p.version)}${p.asan ? ', ASan' : ''}${p.postauth === false ? ', postauth off' : ''}<br><span class="muted">fix: ${esc((p.fix ?? []).map(eid => catalogue?.vendors?.[vendorName.split(':')[0]]?.entries?.[eid]?.alias ?? eid).join(', ') || 'none')}</span>` : '<span class="muted">—</span>'}</td>
          <td>${check.html}</td>
          <td>${c.args?.extra_flags ? `<code>${esc(c.args.extra_flags)}</code>` : '<span class="muted">—</span>'}</td></tr>`;
      }).join('') || `<tr><td colspan="7" class="muted">its configuration is not available (${esc(url)})</td></tr>`}</table>`;
  }).join('') + `<p class="muted">The configurations are the bench's (its job configurations, deployed with it): they change with puffin-bench, not
    with tlspuffin. Their builds are tlspuffin's presets at the commit run, with the fixes of each preset; the check above uses ${where}: a bug added to
    the catalogue with a patch at a configuration's version shows here as not patched, until the preset is changed. A build derived from the catalogue
    (<code>&lt;preset&gt;-only-&lt;ID&gt;</code>, custom benchmarks) follows the catalogue by itself.</p>`;
}

// a claim set apart (vuln_targets.json _not_targeted) against the catalogue: the entry of that CVE has that claim as
// oracle, and its affected versions are those the rule sets the claim apart on
function apartAgainstCatalogue(claim, v) {
  const cve = v.cve ?? v;
  const vendor = v.library ?? null;
  const e = vendor ? catalogue?.vendors?.[vendor]?.entries?.[cve] : Object.values(catalogue?.vendors ?? {}).map(x => x.entries?.[cve]).find(Boolean);
  if (!e) return '<span class="muted">not in the catalogue</span>';
  const sameClaim = e.oracle?.kind === 'claim' && e.oracle.violation === claim;
  const sameRange = !v.below || (e.affected ?? '').replace(/\s+/g, '') === `<${v.below}`;
  return `affected <code>${esc(e.affected ?? '')}</code>, oracle ${sameClaim ? 'this claim' : `<b>another</b> (${esc(e.oracle?.violation ?? e.oracle?.kind ?? 'none')})`}`
    + `<br>${sameClaim && sameRange ? '<span class="badge b-exp">✓ agrees</span>' : '<span class="badge b-unexp">≠ differs from the rule</span>'}`;
}

// the differences between vuln_targets.json's _cves (the CVEs of the Vuln jobs from before the catalogue, still read to
// recognise the bugs of runs built before puffin-build) and the catalogue
function cvesDifferences() {
  const all = Object.fromEntries(Object.values(catalogue?.vendors ?? {}).flatMap(v => Object.entries(v.entries ?? {})));
  if (!Object.keys(all).length) return '';
  const lines = cveTable.flatMap(([cve, c]) => {
    const e = all[cve];
    if (!e) return [`${cveLink(cve)}: not in the catalogue`];
    const out = [];
    if ((c.alias ?? null) !== (e.alias ?? null)) out.push(`${bugLink(cve)}: alias ${esc(c.alias ?? 'none')} here, ${esc(e.alias ?? 'none')} in the catalogue`);
    if (c.cvss !== undefined && e.cvss && Number(c.cvss) !== Number(e.cvss.score)) out.push(`${bugLink(cve)}: CVSS ${esc(c.cvss)} here, ${esc(e.cvss.score)} in the catalogue`);
    return out;
  });
  return lines.length ? `<p>Its <code>_cves</code> table (the CVEs of the Vuln jobs, from before the catalogue: still read to recognise the bugs of runs
    built before puffin-build) differs from the catalogue:</p><ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>`
    : '<p class="muted">Its <code>_cves</code> table (from before the catalogue, still read for runs built before puffin-build) agrees with the catalogue.</p>';
}

// ---- the registry of the bugs found so far (known_bugs.json, written by tools/known_bugs.js from every final objectives
// report: "<configuration or library>|<kind>|<signature>" -> { task, started, what }), one row per bug (its signature in
// a library), with what it is and every configuration that found it
const VENDORS = ['wolfssl', 'openssl', 'libressl', 'boringssl', 'libssh', 'wolfssh'];
// the library of a configuration or library of the registry: WolfSSL, wolfssl540-asan: its name; BUF, SDOS1: the
// library of the CVE with that alias (vuln_targets.json _cves)
const vendorOf = name => {
  const lower = String(name ?? '').toLowerCase();
  return VENDORS.find(v => lower.startsWith(v)) ?? Object.values(targets?._cves ?? {}).find(c => c?.alias === name)?.library ?? null;
};
// a crash's report type, from its description ("heap-buffer-overflow: AddPacketInfo < ..."; "crash: ..." without ASan)
const reportType = b => b.kind === 'claim' ? null : (/^([a-z][a-z-]*):/.exec(b.what ?? '')?.[1] ?? null);
// the bugs of the catalogue a bug of the registry is, for people: those of its library with its claim, or with its top
// function among their top frames and the same ASan report type (when it has one)
function catalogueMatch(vendor, b) {
  const entries = Object.entries(catalogue?.vendors?.[vendor]?.entries ?? {});
  if (b.kind === 'claim') return entries.filter(([, e]) => e.oracle?.kind === 'claim' && e.oracle.violation === b.sig).map(([id]) => id);
  const type = reportType(b);
  return entries.filter(([, e]) => e.oracle?.kind === 'crash' && (e.top_frames ?? []).includes(b.sig)
    && (!type || type === 'crash' || !e.oracle.asan || e.oracle.asan === type)).map(([id]) => id);
}
const entryOf = id => Object.values(catalogue?.vendors ?? {}).map(v => v.entries?.[id]).find(Boolean);
const bugLink = id => {
  const e = entryOf(id);
  return `<a class="mono" href="#${esc(id)}" title="its card: every field">${esc(id)}</a>${e?.alias ? ` <b>${esc(e.alias)}</b>` : ''}`;
};
// a bug of tlspuffin's harness, not of the library: which commits have it (its card says more)
const harnessNote = id => {
  const e = entryOf(id);
  if (!e?.bug_in_harness) return '';
  return ` <span class="muted">(a bug of tlspuffin's harness${e.affected_commits ? `: commits ${esc(e.affected_commits)}` : ''})</span>`;
};
function registrySection() {
  const groups = new Map();
  for (const [key, value] of Object.entries(known ?? {})) {
    const [config, kind, ...rest] = key.split('|');
    const b = { config, kind, sig: rest.join('|'), ...value };
    // the library its configuration built (recorded since custom benchmarks: custom2_SKIP), else from its name
    const vendor = value?.vendor ?? vendorOf(config);
    const id = `${vendor ?? config}|${kind}|${b.sig}`;
    if (!groups.has(id)) groups.set(id, { vendor, kind, sig: b.sig, seen: [] });
    groups.get(id).seen.push(b);
  }
  const bugs = [...groups.values()].map(g => {
    g.seen.sort((x, y) => String(x.started ?? '').localeCompare(String(y.started ?? '')));
    const first = g.seen[0];
    const ids = g.vendor ? catalogueMatch(g.vendor, first) : [];
    // the expected bug of its configuration: a rule of vuln_targets.json (VulnA/VulnB), or a custom experiment's target
    // when the catalogue has the bug with that signature
    const rules = g.seen.map(b => ({ config: b.config, ...(CveOf(b.config, b) ?? (b.target && ids.includes(b.target) ? { cve: b.target, how: 'expected' } : {})) }))
      .filter(r => r.cve);
    return { ...g, first, rules, ids, known: rules.length > 0 || ids.length > 0 };
  }).sort((x, y) => (x.known - y.known) || String(x.vendor ?? '').localeCompare(String(y.vendor ?? ''))
    || String(x.first.started ?? '').localeCompare(String(y.first.started ?? '')));
  // a CVE of the catalogue: its card (every field); else NVD
  const inCatalogue = id => Object.values(catalogue?.vendors ?? {}).some(v => v.entries?.[id]);
  const cve = id => inCatalogue(id) ? bugLink(id) : cveLink(id);
  const whatItIs = bug => {
    const parts = [];
    const expected = bug.rules.filter(r => r.how === 'expected'), apart = bug.rules.filter(r => r.how !== 'expected');
    if (expected.length) parts.push(`<span class="badge b-exp">🎯 expected</span> ${cve(expected[0].cve)} <span class="muted">in ${esc([...new Set(expected.map(r => r.config))].join(', '))}</span>`);
    if (apart.length) parts.push(`<span class="badge b-apart">⦸ ${esc(apart[0].how)}</span> ${cve(apart[0].cve)}`);
    // the catalogue, when no rule of vuln_targets.json tells (a configuration without target, another library)
    const more = bug.rules.length ? [] : bug.ids;
    if (more.length) parts.push(`📚 ${more.map(id => bugLink(id) + harnessNote(id)).join(', ')} <span class="muted">(${bug.kind === 'claim' ? (more.length > 1 ? 'the same claim: one of them' : 'its claim')
      : 'its top function among the bug\'s top frames, same report type'})</span>`);
    return parts.join('<br>') || '<span class="badge b-new">🚨 not a known bug</span>';
  };
  const task = b => `<a href="/html/objectives/${esc(b.task)}.html">task ${esc(b.task)}</a>`;
  const date = b => esc(String(b.started ?? '').slice(0, 10));
  return `<div class="card">
    <p>One row per bug (its signature in a library), rebuilt from every final objectives report (<a href="${KNOWN}" target="_blank">known_bugs.json ↗</a>,
      <code>tools/known_bugs.js</code>, run by <code>objectives_report.sh --all</code>): what it is, and every configuration that found it.
      The bugs that are none of the known ones come first.</p>
    <details class="howto"><summary>When a bug is 🚨 new on a report</summary><p class="muted">A bug is identified by its claim, or by the top function of its
      crash. A real bug (fuzzer record or replay), neither expected nor set apart, is <span class="badge b-new">🚨 NEW BUG</span> on its report and 🚨🚨🚨 on Results:
      in a configuration with a target (BUF, SKIP…), when no earlier task had its signature there; in a plain version (e.g. Perf's wolfSSL 5.8.0), when it
      is none of the CVEs tlspuffin declares for that build (its vendorinfo: known minus fixed vulnerabilities) recognised by vuln_targets.json, which are shown
      as 📋 known; it is then new on every task until it is added there. A crash without location cannot be told apart: it never counts as new.
      📚 here: the catalogue's bug with that claim, or with that function among its top frames (shown to people; validation decides by patch differential).</p></details>
    <table class="registry"><tr><th>bug</th><th>what it is</th><th>found in</th><th>first seen</th><th>first report</th></tr>
    ${bugs.map(bug => `<tr class="${bug.known ? '' : 'unknown-bug'}">
      <td><span class="kind kind-${esc(bug.kind)}">${esc(bug.kind)}</span> <code>${esc(bug.sig)}</code>${reportType(bug.first) && reportType(bug.first) !== 'crash' ? ` <span class="muted">${esc(reportType(bug.first))}</span>` : ''}
        <div class="muted">${esc(bug.vendor ? libraryName(bug.vendor) : '?')}</div></td>
      <td>${whatItIs(bug)}</td>
      <td>${bug.seen.map(b => `<span class="seen" title="first seen there: task ${esc(b.task)}, ${date(b)}">${esc(b.config)}</span>`).join(' ')}</td>
      <td class="nowrap">${date(bug.first)}<br>${task(bug.first)}</td>
      <td class="muted">${esc(bug.first.what)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">no registry yet</td></tr>'}
    </table></div>`;
}

function render() {
document.getElementById('bugsref').innerHTML = `<div class="wrap">
  <h1>Bugs reference</h1>
  <p class="muted">How the pages tell a bug: <span class="badge b-exp">🎯 expected</span> <span class="badge b-apart">⦸ set apart</span>
    <span class="badge b-unexp">⚠ unexpected</span> <span class="badge b-new">🚨 NEW BUG</span>.</p>

  <h2>📚 Known vulnerabilities (tlspuffin's catalogue)</h2>
  ${catalogueSection()}

  <h2>The file to edit</h2>
  <div class="card edit">
    <p><code>tlspuffin/data/html/jobsscripts/tlspuffin/vuln_targets.json</code> in puffin-bench
      (<a href="${REPO}" target="_blank" rel="noopener">on GitHub ↗</a>, <a href="${TARGETS}" target="_blank">as deployed ↗</a>): the expected bug of each
      Vuln group A configuration and the claims set apart, below.</p>
    <ul>${(Array.isArray(targets?._doc) ? targets._doc : [targets?._doc ?? '']).map(line => `<li>${esc(line)}</li>`).join('')}</ul>
    ${cvesDifferences()}
    <p class="muted">After an edit: <code>tlspuffin/scripts/build.sh</code>, then copy <code>vuln_targets.json</code> and the <code>*_full.sh</code> to
      <code>/srv/puffin-bench/data/html/jobsscripts/tlspuffin/</code> (the deploy does it). Running tasks keep the rules they started with.</p>
  </div>

  <h2>🎯 The configurations of Vuln group A and B</h2>
  <div class="card">${vulnConfigsSection()}
  <p class="muted">An experiment with an expected bug ends on it only; a replay or the fuzzer's own log (backtrace, claim) can recognise it.</p></div>

  <h2>⦸ Known CVEs set apart (never a target)</h2>
  <div class="card"><table><tr><th>claim of the security oracle</th><th>CVE</th><th>set apart on</th><th>in the catalogue</th><th>note</th></tr>
    ${apart.map(([claim, v]) => `<tr><td><code>${esc(claim)}</code></td><td>${(c => Object.values(catalogue?.vendors ?? {}).some(x => x.entries?.[c]) ? bugLink(c) : cveLink(c))(v.cve ?? v)}</td><td>${v.library ? `<b>${esc(v.library)} &lt; ${esc(v.below)}</b> only` : 'everywhere'}</td>
      <td>${apartAgainstCatalogue(claim, v)}</td><td class="muted">${esc(v.note ?? '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">none</td></tr>'}
  </table>
  <p class="muted">Only on the library and versions of its scope (what the run built: “C harness, wolfssl540-buf” is wolfSSL 5.4.0): such an objective does not end the experiment and does not count in the 🎯; it is shown as <b>+n ⦸</b>. On any other library or version the same claim is a bug like any other (⚠ unexpected, 🚨 new).
    Any other bug of a configuration with a target is <span class="badge b-unexp">⚠ unexpected</span>: a new finding, or a rule to add here.</p></div>

  <h2>🚨 Bugs found so far</h2>
  ${registrySection()}

  ${everyBugSection()}
</div>`;
  document.getElementById('reload-dev')?.addEventListener?.('click', () => reload());
}

// openBug <ID>: its card, unfolded with its section, scrolled to (false: no such card)
function openBug(id) {
  const card = document.getElementById(id);
  if (!card?.matches?.('details.entry')) return false;
  const section = card.closest?.('details.every-bug');
  if (section) section.open = true;
  card.open = true;
  document.querySelectorAll?.('.entry.targeted').forEach(e => e.classList.remove('targeted'));
  card.classList?.add('targeted');
  card.scrollIntoView?.({ block: 'start' });
  return true;
}

// "Reload from the latest dev": git_restapi fetches tlspuffin, then answers dev's catalogue again
async function reload() {
  const button = document.getElementById('reload-dev');
  if (button) { button.disabled = true; button.textContent = '⟳ Fetching the latest dev…'; }
  const fresh = await load(`${CATALOGUE}?refresh=fetch`);
  if (fresh) {
    catalogue = fresh; shownPR = null; devCatalogue = null;
    await fallbackCatalogue(true);
    presetsAt = await loadPresets(catalogue); reloaded = new Date().toLocaleTimeString(); reloadError = null;
  } else { reloadError = 'the reload failed: dev as last fetched'; }
  render();
}

render();
// the navigation bar's refresh does the same (on dev's catalogue)
window.addEventListener?.('pb-refresh', event => { if (catalogueRef === 'dev') { event.preventDefault(); reload(); } });
// #<ID>: that bug's card, unfolded: the URL, a link of the page (its tables, a card's own id)
const hashBug = () => decodeURIComponent(String(window.location?.hash ?? '').slice(1));
if (hashBug()) openBug(hashBug());
window.addEventListener?.('hashchange', () => openBug(hashBug()));
document.getElementById('bugsref')?.addEventListener?.('change', event => {
  const name = event.target?.dataset?.filter;
  if (!name) return;
  filters[name] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
  render();
});
document.getElementById('bugsref')?.addEventListener?.('click', event => {
  const link = event.target?.closest?.('a[href^="#"]');
  if (!link) return;
  const id = decodeURIComponent(link.getAttribute('href').slice(1));
  if (id === 'every-bug') { document.getElementById('every-bug').open = true; return; }
  if (openBug(id)) { event.preventDefault(); history.replaceState(null, '', `#${encodeURIComponent(id)}`); }
});
