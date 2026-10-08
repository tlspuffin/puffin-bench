// Bugs reference: the expected bug of each Vuln configuration and the CVEs set apart (vuln_targets.json, the file to
// edit), and the registry of the bugs found so far per library (known_bugs.json, written by tools/known_bugs.js)
import '../board/nav.js';

const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const TARGETS = '/html/jobsscripts/tlspuffin/vuln_targets.json';
const KNOWN = '/html/objectives/known_bugs.json';
// the file in the repository at the deployed commit (board/version.json, written by deploy.sh), else on main
const REPO_FILE = 'tlspuffin/data/html/jobsscripts/tlspuffin/vuln_targets.json';

const load = url => fetch(url, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
const [targets, known, version] = await Promise.all([load(TARGETS), load(KNOWN), load('/html/board/version.json')]);
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

document.getElementById('bugsref').innerHTML = `<div class="wrap">
  <h1>Bugs reference</h1>
  <p class="muted">How the pages tell a bug: <span class="badge b-exp">🎯 expected</span> <span class="badge b-apart">⦸ set apart</span>
    <span class="badge b-unexp">⚠ unexpected</span> <span class="badge b-new">🚨 NEW BUG</span>.</p>

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

  <h2>📚 The CVEs of the Vuln jobs</h2>
  <div class="card"><table><tr><th>CVE</th><th>alias</th><th>CVSS</th><th>type</th><th>1st found by puffin</th><th>version</th><th>TLS</th><th>recognised by</th></tr>
    ${cveTable.map(([cve, c]) => `<tr><td><a href="${NVD(cve)}" target="_blank" rel="noopener">${esc(cve)}</a></td><td><b>${esc(c.alias)}</b></td><td>${esc(c.cvss)}</td><td>${esc(c.type)}</td><td>${c.found_by_puffin === true ? '✓' : c.found_by_puffin === false ? '✗' : esc(c.new ?? '')}</td><td>${esc(c.version)}</td><td>${esc(c.tls)}</td><td>${signatureOf(cve) ? rule(signatureOf(cve)) : '<span class="muted">no signature: not recognised</span>'}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">none declared (_cves)</td></tr>'}
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
