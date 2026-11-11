// Bugs reference: tlspuffin's vulnerability catalogue in full, generated from the vulnerabilities.toml files of dev
// (git_restapi; "Reload from the latest dev" has it fetch GitHub first; ?commit=<sha>: another commit's; #<ID>: one
// entry), the expected bug of each Vuln configuration and the CVEs set apart (vuln_targets.json, the file to edit),
// and the registry of the bugs found so far per library (known_bugs.json, written by tools/known_bugs.js)
import '../board/nav.js';
import { urls } from './summary_config.js';

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
const [targets, known, version, firstCatalogue] = await Promise.all([load(TARGETS), load(KNOWN), load('/html/board/version.json'), load(CATALOGUE)]);
let catalogue = firstCatalogue;
// "Reload from the latest dev": when it last fetched, or why it failed
let reloaded = null, reloadError = null;
const REPO = `${version?.repository ?? 'https://github.com/tlspuffin/puffin-bench'}/blob/${/^[0-9a-f]{40}$/.test(version?.commit ?? '') ? version.commit : 'main'}/${REPO_FILE}`;

const presets = Object.entries(targets ?? {}).filter(([key]) => !key.startsWith('_'));
const apart = Object.entries(targets?._not_targeted ?? {});
const byLibrary = {};
for (const [key, value] of Object.entries(known ?? {})) {
  const [library, kind, ...rest] = key.split('|');
  (byLibrary[library] ??= []).push({ kind, sig: rest.join('|'), ...value });
}
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
// how a CVE is recognised (as objectives_page/cve_signatures.jq): its own kind/match, else the target naming it, else
// its claim set apart; null: it cannot be recognised
const signatureOf = cve => {
  const own = targets?._cves?.[cve];
  if (own?.kind && own?.match) return own;
  const target = presets.find(([, t]) => t.cve === cve)?.[1];
  if (target?.kind && target?.match) return target;
  const claim = Object.entries(targets?._not_targeted ?? {}).find(([, v]) => (v.cve ?? v) === cve)?.[0];
  return claim ? { kind: 'claim', match: claim } : null;
};

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
  return `<section class="entry${e.bug_in_harness ? ' harness' : ''}" id="${esc(id)}">
    <header>
      <a class="eid" href="#${esc(id)}" title="Link to this bug">${esc(id)}</a>${e.alias ? `<b class="alias">${esc(e.alias)}</b>` : ''}${f.by_puffin ? '<span class="star" title="first found by puffin">★</span>' : ''}
      <span class="tag">${esc(libraryName(vendor))}</span><span class="tag">${esc(e.category)}</span>
      ${e.cvss ? `<span class="sev sev-${severity}" title="CVSS ${esc(e.cvss.version)}">CVSS ${esc(e.cvss.score)} · ${severity}</span>` : '<span class="sev">no CVSS</span>'}
      ${patches.length ? `<span class="badge b-exp" title="validated by patch differential">✓ patch ${patches.map(p => esc(p.versions ?? p.commits ?? '')).join(' · ')}</span>` : '<span class="badge b-unexp">no patch</span>'}
      ${e.no_witness ? '<span class="badge b-unexp">no witness</span>' : '<span class="badge b-exp">✓ witness</span>'}${e.replayable === false ? ' <span class="badge b-apart">does not replay</span>' : ''}${e.bug_in_harness ? ' <span class="badge b-apart">🔧 harness</span>' : ''}
      <span class="spacer"></span>${id.startsWith('CVE-') ? external(NVD(id), 'NVD ↗') : ''}
    </header>
    <p class="lead">${esc(e.summary)}</p>
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
  </section>`;
}

const overviewRow = ({ vendor, id, e }) => `<tr><td>${idLink(id)}${e.alias ? ` <b>${esc(e.alias)}</b>` : ''}${e.find?.by_puffin ? ' <span class="star" title="first found by puffin">★</span>' : ''}</td>
  <td>${esc(libraryName(vendor))}</td><td class="summary">${esc(e.summary)}</td><td>${esc(e.category)}</td>
  <td>${e.cvss ? `<span class="sev sev-${SEVERITY(Number(e.cvss.score))}">${esc(e.cvss.score)}</span>` : '<span class="muted">—</span>'}</td>
  <td><code>${esc(e.affected ?? e.affected_commits ?? '')}</code></td>
  <td class="nowrap">${(e.patches ?? []).length ? e.patches.map(p => `<code>${esc(p.versions ?? p.commits ?? '')}</code>`).join('<br>') : `<span class="badge b-unexp" title="${esc(e.no_patch ?? '')}">no patch</span>`}</td>
  <td>${e.no_witness ? `<span class="badge b-unexp" title="${esc(e.no_witness)}">no witness</span>` : '<span class="badge b-exp">✓</span>'}</td>
  <td>${oracleText(e.oracle)}${e.replayable === false ? '<br><span class="muted">does not replay</span>' : ''}</td></tr>`;
const OVERVIEW_HEAD = '<tr><th>bug</th><th>library</th><th>summary</th><th>category</th><th>CVSS</th><th>affected</th><th>patch</th><th>witness</th><th>oracle</th></tr>';
const overviewTable = list => `<table class="overview">${OVERVIEW_HEAD}${list.map(overviewRow).join('') || '<tr><td colspan="9" class="muted">none</td></tr>'}</table>`;
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
  const entries = Object.entries(catalogue.vendors ?? {}).flatMap(([vendor, v]) => Object.entries(v.entries ?? {}).map(([id, e]) => ({ vendor, id, e })));
  const library = entries.filter(x => !x.e.bug_in_harness), harness = entries.filter(x => x.e.bug_in_harness);
  const vendors = Object.entries(catalogue.vendors ?? {}).filter(([, v]) => Object.values(v.entries ?? {}).some(e => !e.bug_in_harness));
  return `<div class="card">
      <div class="row"><p>The catalogue of tlspuffin ${where} at ${at}, generated from <code>puffin-build/vendors/&lt;vendor&gt;/vulnerabilities.toml</code>: the only source of what builds, tests and
        validation know about a bug. Each entry has a patch per version range and a witness trace; tlspuffin's catalogue test checks every witness with and without its patch.</p>${reload}</div>
      <p class="muted">${catalogueRef === 'dev' ? 'Another commit (e.g. a PR adding a bug): <code>?commit=&lt;sha&gt;</code>. ' : ''}One bug: <code>#&lt;ID&gt;</code>. ★ first found by puffin.</p>
      ${overviewTable(library)}
      ${harness.length ? `<h3>🔧 Bugs of the fuzzing harness</h3><p class="muted">Validated the same way, never counted as a vulnerability of the library.</p>${overviewTable(harness)}` : ''}
    </div>
    <h2>📖 Every bug in full</h2>
    ${vendors.map(([vendor, v]) => `<h3 class="library" id="library-${esc(vendor)}">${esc(libraryName(vendor))} — ${Object.values(v.entries ?? {}).filter(e => !e.bug_in_harness).length} bug(s)
        · ${external(`${TLSPUFFIN}/blob/${catalogue.commit}/puffin-build/vendors/${vendor}/vulnerabilities.toml`, `puffin-build/vendors/${vendor}/vulnerabilities.toml`)}</h3>
      ${v.preamble ? `<details class="preamble"><summary>About this file</summary><pre>${preambleText(v.preamble)}</pre></details>` : ''}
      ${library.filter(x => x.vendor === vendor).map(x => entryCard(x.vendor, x.id, x.e)).join('')}`).join('')}
    ${harness.length ? `<h3 class="library">🔧 Bugs of the fuzzing harness</h3>${harness.map(x => entryCard(x.vendor, x.id, x.e)).join('')}` : ''}`;
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
      (<a href="${REPO}" target="_blank" rel="noopener">on GitHub ↗</a>, <a href="${TARGETS}" target="_blank">as deployed ↗</a>). Both tables below come from it.</p>
    <ul>${(Array.isArray(targets?._doc) ? targets._doc : [targets?._doc ?? '']).map(line => `<li>${esc(line)}</li>`).join('')}</ul>
    <p class="muted">After an edit: <code>tlspuffin/scripts/build.sh</code>, then copy <code>vuln_targets.json</code> and the <code>*_full.sh</code> to
      <code>/srv/puffin-bench/data/html/jobsscripts/tlspuffin/</code> (the deploy does it). Running tasks keep the rules they started with.</p>
  </div>

  <h2>🎯 Expected bug of each configuration (VulnA)</h2>
  <div class="card"><table><tr><th>preset</th><th>CVE</th><th>recognised by</th><th>note</th></tr>
    ${presets.map(([key, t]) => `<tr><td class="mono">${esc(key)}</td><td>${cveLink(t.cve)}</td>
      <td>${rule(t)}</td><td class="muted">${esc(t.note ?? '')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">none declared</td></tr>'}
  </table>
  <p class="muted">The experiment of such a configuration ends on its expected bug only. A replay or the fuzzer's own log (backtrace, claim) can recognise it.
    <b>VulnB</b> and any preset not listed: no target, the experiment ends on its first objective that is not set apart.</p></div>

  <h2>📚 The CVEs of the Vuln jobs (vuln_targets.json, until the job scripts read the catalogue)</h2>
  <div class="card"><table><tr><th>CVE</th><th>alias</th><th>library</th><th>CVSS</th><th>type</th><th>1st found by puffin</th><th>version</th><th>TLS</th><th>recognised by</th></tr>
    ${cveTable.map(([cve, c]) => `<tr><td><a href="${NVD(cve)}" target="_blank" rel="noopener">${esc(cve)}</a></td><td><b>${esc(c.alias)}</b></td><td>${esc(c.library ?? '')}</td><td>${esc(c.cvss)}</td><td>${esc(c.type)}</td><td>${c.found_by_puffin === true ? '✓' : c.found_by_puffin === false ? '✗' : esc(c.new ?? '')}</td><td>${esc(c.version)}</td><td>${esc(c.tls)}</td><td>${signatureOf(cve) ? rule(signatureOf(cve)) : '<span class="muted">no signature: not recognised</span>'}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">none declared (_cves)</td></tr>'}
  </table><p class="muted">${esc(targets?._cves?._doc ?? '')}</p></div>

  <h2>⦸ Known CVEs set apart (never a target)</h2>
  <div class="card"><table><tr><th>claim of the security oracle</th><th>CVE</th><th>set apart on</th><th>note</th></tr>
    ${apart.map(([claim, v]) => `<tr><td><code>${esc(claim)}</code></td><td><a href="https://nvd.nist.gov/vuln/detail/${esc(v.cve ?? v)}" target="_blank" rel="noopener">${esc(v.cve ?? v)}</a></td><td>${v.library ? `<b>${esc(v.library)} &lt; ${esc(v.below)}</b> only` : 'everywhere'}</td><td class="muted">${esc(v.note ?? '')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">none</td></tr>'}
  </table>
  <p class="muted">Only on the library and versions of its scope (what the run built: “C harness, wolfssl540-buf” is wolfSSL 5.4.0): such an objective does not end the experiment and does not count in the 🎯; it is shown as <b>+n ⦸</b>. On any other library or version the same claim is a bug like any other (⚠ unexpected, 🚨 new).
    Any other bug of a configuration with a target is <span class="badge b-unexp">⚠ unexpected</span>: a new finding, or a rule to add here.</p></div>

  <h2>🚨 Bugs found so far, per library</h2>
  <div class="card">
    <p class="muted">Not edited by hand: rebuilt from every final objectives report (<a href="${KNOWN}" target="_blank">known_bugs.json ↗</a>, <code>tools/known_bugs.js</code>, run by <code>objectives_report.sh --all</code>).
      A bug is identified by its claim, or by the top function of its crash. A real bug (fuzzer record or replay), neither expected nor set apart, is
      <span class="badge b-new">🚨 NEW BUG</span> on its report and 🚨🚨🚨 on Results: in a configuration with a target (BUF, SKIP…), when no earlier
      task had its signature there (this table); in a plain version (e.g. Perf's wolfSSL 5.8.0), when it is none of the CVEs tlspuffin declares for
      that build (the build's vendorinfo: known minus fixed vulnerabilities) recognised as above, which are shown as 📋 known; it is then new on every
      task until it is added to the file. A crash without location cannot be told apart: it never counts as new.</p>
    <table><tr><th>library / configuration</th><th>signature</th><th>CVE</th><th>first seen</th><th>what</th></tr>
    ${Object.keys(byLibrary).sort().map(library => byLibrary[library].map((b, i) => `<tr>${i === 0 ? `<td rowspan="${byLibrary[library].length}"><b>${esc(library)}</b></td>` : ''}
      <td>${esc(b.kind)}: <code>${esc(b.sig)}</code></td>
      <td>${(c => c ? `${cveLink(c.cve)}<br><span class="badge ${c.how === 'expected' ? 'b-exp' : 'b-apart'}">${c.how === 'expected' ? '🎯 expected' : '⦸ ' + esc(c.how)}</span>` : '<span class="muted">—</span>')(CveOf(library, b))}</td>
      <td><a href="/html/objectives/${esc(b.task)}.html">task ${esc(b.task)}</a> <span class="muted">${esc((b.started ?? '').slice(0, 10))}</span></td>
      <td class="muted">${esc(b.what)}</td></tr>`).join('')).join('') || '<tr><td colspan="5" class="muted">no registry yet</td></tr>'}
    </table></div>
</div>`;
  document.getElementById('reload-dev')?.addEventListener?.('click', () => reload());
}

// "Reload from the latest dev": git_restapi fetches tlspuffin, then answers dev's catalogue again
async function reload() {
  const button = document.getElementById('reload-dev');
  if (button) { button.disabled = true; button.textContent = '⟳ Fetching the latest dev…'; }
  const fresh = await load(`${CATALOGUE}?refresh=fetch`);
  if (fresh) { catalogue = fresh; reloaded = new Date().toLocaleTimeString(); reloadError = null; } else { reloadError = 'the reload failed: dev as last fetched'; }
  render();
}

render();
// the navigation bar's refresh does the same (on dev's catalogue)
window.addEventListener?.('pb-refresh', event => { if (catalogueRef === 'dev') { event.preventDefault(); reload(); } });
// #<ID>: that bug, once the page is written
const wanted = decodeURIComponent(String(window.location?.hash ?? '').slice(1));
if (wanted) {
  const element = document.getElementById(wanted);
  element?.classList?.add('targeted');
  element?.scrollIntoView?.({ block: 'start' });
}
