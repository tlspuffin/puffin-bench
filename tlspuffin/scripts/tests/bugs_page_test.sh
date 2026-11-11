#!/bin/bash
# bugs_page_test.sh <tlspuffin clone> [<commit>]: renders the Bugs reference page (data/html/publisher/bugs.js) with node,
# with the catalogue that git_restapi's tlspuffin_catalogue.sh gives for <commit> of the clone (default HEAD), and
# checks what the page shows: every catalogue entry in the overview and in a card of its own, every value of every
# entry (all of vulnerabilities.toml, with its TOML text), fields the page does not know yet, the links to patch files
# and upstream fixes, the "no witness" and "no patch" marks, the reload button (dev only), the unavailable and empty
# catalogue cases. No browser, no service: the page's fetches are answered from files.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
bench=$( cd "${here}/../../.." && pwd )
clone="${1:?usage: bugs_page_test.sh <tlspuffin clone> [<commit>]}"
commit="${2:-HEAD}"
command -v node > /dev/null || { echo "SKIP: node not found"; exit 0; }

work=$( mktemp -d )
trap 'rm -rf "${work}"' EXIT
mkdir -p "${work}/html/board" "${work}/html/publisher"
command cp -f "${bench}/tlspuffin/data/html/publisher/"{bugs.js,summary_config.js} "${work}/html/publisher/"
mkdir -p "${work}/html/common" && command cp -f "${bench}/tlspuffin/data/html/common/"{catalogue,format,verdicts}.js "${work}/html/common/"
echo '' > "${work}/html/board/nav.js"   # the navigation bar needs a real DOM
echo '{ "type": "module" }' > "${work}/package.json"
"${bench}/git_restapi/scripts/tlspuffin_catalogue.sh" "${clone}" "${commit}" > "${work}/catalogue.json"
"${bench}/git_restapi/scripts/tlspuffin_presets.sh" "${clone}" "${commit}" > "${work}/presets.json"
command cp -f "${bench}/tlspuffin/data/html/jobsscripts/tlspuffin/vuln_targets.json" "${work}/vuln_targets.json"
# the bench's times to find (runs/bench_times.json), for the mode "times"
cat > "${work}/bench_times.json" <<'JSON'
{ "source": "Vuln group A and B (test)", "bugs": { "BUF": { "median_s": 1013, "found": 5, "runs": 5, "commit": "edbdb8e7d", "date": "2026-09-15", "task": 1, "job": "vuln-a", "cores": 4, "budget_s": 4200 } } }
JSON
# the job configurations of Vuln group A and B the page reads (run.mjs serves them from there)
export JOBS_DIR="${bench}/tlspuffin/data/html/jobsscripts/tlspuffin"
# a registry of the bugs found so far (known_bugs.json): the same crash in two configurations of wolfSSL (HEAP of the
# catalogue, by its ASan report type and top frame), a crash of OpenSSL none of the known bugs, the crash of the LibreSSL
# harness of past commits (in the catalogue since PUFFIN-LIBRESSL333-HKDF-CLAIM), a claim set apart
cat > "${work}/known_bugs.json" <<'JSON'
{ "WolfSSL|crash|AddPacketInfo": { "task": "1790851747037", "started": "2026-10-01T10:49:07Z", "what": "heap-buffer-overflow: AddPacketInfo < DoTls13HandShakeMsgType < DoTls13HandShakeMsg" },
  "wolfssl540-asan|crash|AddPacketInfo": { "task": "1791638282947", "started": "2026-10-10T08:00:00Z", "what": "heap-buffer-overflow: AddPacketInfo < DoTls13HandShakeMsgType < DoTls13HandShakeMsg" },
  "LibreSSL|crash|tls13_hkdf_expand_label_with_length": { "task": "1790851749055", "started": "2026-10-01T11:00:00Z", "what": "global-buffer-overflow: MemcmpInterceptorCommon < tls13_hkdf_expand_label_with_length" },
  "OpenSSL|crash|ossl_not_a_known_function": { "task": "1790851749056", "started": "2026-10-01T12:00:00Z", "what": "heap-use-after-free: ossl_not_a_known_function < SSL_do_handshake" },
  "BUF|claim|Negotiated cipher is not in agent's configured ciphers list": { "task": "1791237378849", "started": "2026-10-05T09:00:00Z", "what": "security-violation: Negotiated cipher is not in agent's configured ciphers list" },
  "CDOS|claim|Negotiated cipher is not in agent's configured ciphers list": { "task": "1791237386132", "started": "2026-10-06T09:00:00Z", "what": "security-violation: Negotiated cipher is not in agent's configured ciphers list" },
  "custom2_SKIP|claim|Authentication bypass": { "task": "1794327919866", "started": "2026-11-10T16:39:18Z", "what": "security-violation: Authentication bypass", "vendor": "wolfssl", "target": "CVE-2022-25640" } }
JSON

cat > "${work}/run.mjs" <<'EOF'
import { readFileSync } from 'node:fs';
const [, , work, mode] = process.argv;
const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let html = '';
globalThis.GIT_RESTAPI_PORT = 1; globalThis.SCHEDULER_PORT = 2; globalThis.VIS_COMPARATOR_PORT = 3;
globalThis.window = { location: { hostname: 'localhost', search: mode === 'commit' ? '?commit=deadbeef' : '' } };
globalThis.document = { getElementById: () => ({ set innerHTML(v) { html = v; } }) };
const json = file => ({ ok: true, json: async () => JSON.parse(readFileSync(file, 'utf8')) });
globalThis.fetch = async url => {
  url = String(url);
  // dev without catalogue: the open pull requests of git_restapi's history, the one updated last first (none-pr)
  const OPEN_NEW = '1'.repeat(40), OPEN_OLD = '2'.repeat(40), CLOSED = '3'.repeat(40);
  if (url.includes('/api/git/history/')) {
    if (mode !== 'none-pr') return { ok: false };
    return { ok: true, json: async () => ({ PR: [
      { number: 500, state: 'closed', branch: 'pr/closed', id: CLOSED, updated_at: '2026-11-11T00:00:00Z' },
      { number: 562, state: 'open', branch: 'pr/no-catalogue', id: OPEN_NEW, updated_at: '2026-11-10T13:00:00Z' },
      { number: 563, state: 'open', branch: 'pr/vuln-catalogue', id: OPEN_OLD, updated_at: '2026-11-10T12:00:00Z' } ] }) };
  }
  if (url.endsWith('bench_times.json')) return mode === 'times' ? json(`${work}/bench_times.json`) : { ok: false };
  if (mode === 'none-pr' && url.includes('/api/git/catalogue/')) {
    if (url.includes(OPEN_OLD) || url.includes(CLOSED)) return json(`${work}/catalogue.json`);
    return { ok: true, json: async () => ({ commit: 'a'.repeat(40), format: 'none', vendors: {} }) };
  }
  if (url.includes('/api/git/catalogue/')) {
    if (mode === 'unavailable') return { ok: false };
    if (mode === 'none') return { ok: true, json: async () => ({ commit: 'a'.repeat(40), format: 'none', vendors: {} }) };
    if (mode === 'extra') {
      // fields the page does not know (a later catalogue format): still shown
      const catalogue = JSON.parse(readFileSync(`${work}/catalogue.json`, 'utf8'));
      const entry = Object.values(catalogue.vendors).flatMap(v => Object.values(v.entries))[0];
      entry.future_field = 'future value'; entry.find = { ...(entry.find ?? {}), future_find: 42 };
      return { ok: true, json: async () => catalogue };
    }
    return json(`${work}/catalogue.json`);
  }
  if (url.endsWith('vuln_targets.json')) return json(`${work}/vuln_targets.json`);
  if (url.endsWith('known_bugs.json')) return json(`${work}/known_bugs.json`);
  if (url.includes('/api/git/presets/')) return json(`${work}/presets.json`);
  const job = /jobsscripts\/tlspuffin\/(PR_vulnerabilities-group[AB]_cargo\.json)$/.exec(url);
  if (job) return json(`${process.env.JOBS_DIR}/${job[1]}`);
  return { ok: false };
};
await import(`${work}/html/publisher/bugs.js`);
if (mode === 'leaves') {
  // every value of every entry (strings and numbers, and the names of build and PUT options) must be on the page
  const catalogue = JSON.parse(readFileSync(`${work}/catalogue.json`, 'utf8'));
  const leaves = [];
  const walk = (value, key) => {
    if (Array.isArray(value)) value.forEach(item => walk(item));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => { if (key === 'requires' || key === 'put_options') leaves.push(k); walk(v, k); });
    else if (typeof value === 'string' || typeof value === 'number') leaves.push(String(value));
  };
  Object.values(catalogue.vendors).forEach(v => Object.values(v.entries).forEach(e => Object.entries(e).forEach(([k, v]) => walk(v, k))));
  process.stdout.write([...new Set(leaves)].filter(leaf => !html.includes(esc(leaf))).join('\n'));
} else {
  process.stdout.write(html);
}
EOF

fail=0
check() { # check <mode> <description> <grep -E pattern> [absent]
  local out; out=$( node "${work}/run.mjs" "${work}" "$1" )
  if [ "${4:-}" == absent ]; then
    grep -qE -- "$3" <<< "${out}" && { echo "FAIL ($1): $2"; fail=1; return; }
  else
    grep -qE -- "$3" <<< "${out}" || { echo "FAIL ($1): $2"; fail=1; return; }
  fi
  echo "ok   ($1): $2"
}

# every entry of the catalogue is a row of the overview and a card
for id in $( jq -r '.vendors[].entries | keys[]' "${work}/catalogue.json" ); do
  check dev "entry ${id} shown" ">${id}</a>|>${id}<"
  check dev "entry ${id} has its card, folded" "<details class=\"entry[^\"]*\" id=\"${id}\">"
done
missing=$( node "${work}/run.mjs" "${work}" leaves )
[ -z "${missing}" ] && echo "ok   (dev): every value of every entry is on the page" || { echo "FAIL (dev): values not on the page:"; sed 's/^/       /' <<< "${missing}"; fail=1; }
check extra 'a field the page does not know is shown' '<code>future_field</code>'
check extra 'a find field the page does not know is shown' '<code>find.future_find</code>'
check dev 'every bug in full: a folded section' '<details class="every-bug" id="every-bug">'
out=$( node "${work}/run.mjs" "${work}" dev )
registry=$( grep -o '<table class="registry">.*</table>' <<< "$( tr '\n' ' ' <<< "${out}" )" | sed 's|</table>.*||' )
order() { local a b; a=$( grep -bo -- "$1" <<< "${out}" | head -1 | cut -d: -f1 ); b=$( grep -bo -- "$2" <<< "${out}" | head -1 | cut -d: -f1 ); [ -n "${a}" ] && [ -n "${b}" ] && (( a < b )); }
order 'Bugs found so far' 'id="every-bug"' && echo "ok   (dev): every bug in full at the end, after the registry" || { echo "FAIL (dev): every bug in full is not at the end"; fail=1; }
rows() { grep -o '<tr' <<< "$( grep -o "<tr[^>]*>[^<]*<td><span class=\"kind[^\"]*\">[a-z]*</span> <code>$1" <<< "${registry}" )" | wc -l; }
[ "$( rows AddPacketInfo )" == 1 ] && echo "ok   (registry): one row for AddPacketInfo, found in two configurations" || { echo "FAIL (registry): AddPacketInfo rows $( rows AddPacketInfo )"; fail=1; }
[ "$( rows 'Negotiated cipher' )" == 1 ] && echo "ok   (registry): one row for the claim of CVE-2024-5814" || { echo "FAIL (registry): claim rows $( rows 'Negotiated cipher' )"; fail=1; }
grep -q 'href="#CVE-2022-42905"' <<< "${registry}" && echo "ok   (registry): AddPacketInfo in wolfSSL is CVE-2022-42905 (catalogue), linked to its card" || { echo "FAIL (registry): AddPacketInfo not recognised"; fail=1; }
classes=$( grep -o '<tr class="[^"]*">' <<< "${registry}" | tr '\n' ' ' )
unknown=$( grep -o '<tr class="unknown-bug">.\{0,400\}' <<< "${registry}" )
[[ "${classes}" =~ ^(\<tr\ class=\"unknown-bug\"\>\ )+(\<tr\ class=\"\"\>\ )+$ ]] && grep -q 'ossl_not_a_known_function' <<< "${unknown}" &&
  echo "ok   (registry): the bugs none of the known ones first (OpenSSL)" || { echo "FAIL (registry): the unknown bugs are not first (${classes})"; fail=1; }
# the crash of the LibreSSL harness: the catalogue's entry when it has one, linked to its card as a bug of the harness
hkdf=$( jq -r '[.vendors.libressl.entries // {} | to_entries[] | select((.value.top_frames // []) | index("tls13_hkdf_expand_label_with_length")) | .key][0] // empty' "${work}/catalogue.json" )
libre=$( grep -o '<code>tls13_hkdf_expand_label_with_length</code>.\{0,900\}' <<< "${registry}" | head -1 )
if [ -n "${hkdf}" ]; then
  grep -q "href=\"#${hkdf}\"" <<< "${libre}" && grep -q "a bug of tlspuffin's harness: commits not containing" <<< "${libre}" && ! grep -q 'tls13_hkdf_expand_label_with_length' <<< "${unknown}" &&
    echo "ok   (registry): the LibreSSL crash is ${hkdf} of the catalogue, a bug of the harness of past commits" || { echo "FAIL (registry): the LibreSSL crash is not ${hkdf}"; fail=1; }
else
  grep -q 'tls13_hkdf_expand_label_with_length' <<< "${unknown}" &&
    echo "ok   (registry): the LibreSSL crash, not in this catalogue, is not a known bug" || { echo "FAIL (registry): the LibreSSL crash"; fail=1; }
fi
grep -q 'set apart' <<< "$( grep -o "<code>Negotiated cipher.\{0,600\}" <<< "${registry}" )" && echo "ok   (registry): the claim set apart" || { echo "FAIL (registry): claim not set apart"; fail=1; }
skip=$( grep -o '<code>Authentication bypass</code>.\{0,900\}' <<< "${registry}" | head -1 )
grep -q 'custom2_SKIP' <<< "${skip}" && grep -q '🎯 expected' <<< "${skip}" && grep -q 'CVE-2022-25640' <<< "${skip}" && ! grep -q 'not a known bug' <<< "${skip}" &&
  echo "ok   (registry): a custom experiment's claim is its target, expected (its library and target recorded)" || { echo "FAIL (registry): custom2_SKIP"; fail=1; }
check dev 'the TOML text of an entry is shown' 'TOML source, with its comments'
check dev 'the notes heading a file are shown' 'About this file'
check dev 'the reload button on dev' 'id="reload-dev"'
check commit 'no reload button on a commit' 'id="reload-dev"' absent
commit_sha=$( jq -r .commit "${work}/catalogue.json" )
patch_file=$( jq -r '[.vendors | to_entries[] | .key as $v | .value.entries[] | .patches[]?.files[]? | "\($v)/\(.)"][0] // empty' "${work}/catalogue.json" )
[ -z "${patch_file}" ] || check dev 'patch files link to tlspuffin at the commit' "blob/${commit_sha}/puffin-build/vendors/${patch_file}"
upstream=$( jq -r '[.vendors | to_entries[] | .value.repository as $r | .value.entries[] | .patches[]?.upstream | select(. != null and test("^[0-9a-f]{40}$")) | "\($r)/commit/\(.)"][0] // empty' "${work}/catalogue.json" )
[ -z "${upstream}" ] || check dev 'upstream fixes link to the library repository' "${upstream}"
[ "$( jq '[.vendors[].entries | keys[]] | length' "${work}/catalogue.json" )" -gt 0 ] || { echo "FAIL: the catalogue of ${commit} has no entry"; fail=1; }
if jq -e '[.vendors[].entries[] | select(.no_witness)] | length > 0' "${work}/catalogue.json" > /dev/null; then
  check dev 'entries without witness marked' 'no witness</span>'
fi
if jq -e '[.vendors[].entries[] | select(.no_patch)] | length > 0' "${work}/catalogue.json" > /dev/null; then
  check dev 'entries without patch marked' 'no patch</span>'
fi
check dev 'the catalogue commit is linked' "tree/$( jq -r .commit "${work}/catalogue.json" )/puffin-build/vendors"
check dev 'the configurations of Vuln group A and B' 'The configurations of Vuln group A and B'
check dev 'the _cves table is gone' 'The CVEs of the Vuln jobs' absent
configs=$( grep -o '<table class="configs">.*' <<< "$( tr '\n' ' ' <<< "${out}" )" )
row() { awk -v k="<td><b>$1</b></td>" '{ i = index($0, k); if (i) { r = substr($0, i); j = index(r, "</tr>"); print (j ? substr(r, 1, j - 1) : r); exit } }' <<< "${configs}"; }
grep -q "every patch but its bug" <<< "$( row BUF )" && grep -q '✓' <<< "$( row BUF )" && echo "ok   (configs): BUF's preset is every patch but its bug's" || { echo "FAIL (configs): BUF"; fail=1; }
grep -q '≠' <<< "$( row SDOS2 )" && grep -q 'not patched: HEAP' <<< "$( row SDOS2 )" && echo "ok   (configs): SDOS2's preset leaves HEAP unpatched (it has a patch at 5.4.0)" || { echo "FAIL (configs): SDOS2"; fail=1; }
grep -q 'CVE-2021-3449' <<< "$( row SDOS1 )" && grep -q 'recognised as CVE-2021-3449 during the attempt' <<< "$( row SDOS1 )" && echo "ok   (configs): VulnB's SDOS1 names CVE-2021-3449, recognised during the attempt" || { echo "FAIL (configs): SDOS1"; fail=1; }
grep -q 'recognised as CVE-2022-39173 during the attempt' <<< "$( row BUF )" && grep -q 'RefineSuites' <<< "$( row BUF )" && echo "ok   (configs): VulnA's BUF keeps its rule and is recognised during the attempt" || { echo "FAIL (configs): BUF confirmation"; fail=1; }
# a CVE of vuln_targets.json _cves that the catalogue does not have is named (CALLB before the catalogue had it)
if jq -e '.vendors.wolfssl.entries["CVE-2023-6936"]' "${work}/catalogue.json" > /dev/null; then
  check dev 'a CVE the catalogue has is not said missing' 'CVE-2023-6936</a> <span class="muted">CALLB</span>: not in the catalogue' absent
else
  check dev 'the differences of _cves with the catalogue' 'CVE-2023-6936</a> <span class="muted">CALLB</span>: not in the catalogue'
fi
check dev 'the claim set apart agrees with the catalogue' '✓ agrees'
check commit 'a commit asked with ?commit= is named' 'catalogue of tlspuffin commit deadbeef'
check unavailable 'an unavailable catalogue is said' 'is not available'
check none 'a commit without catalogue is said' 'has no vulnerability catalogue yet'
# dev without catalogue: the open pull request updated last that has one (not the closed one, not one without)
check none-pr 'dev without catalogue: the pull request with one is shown' 'this is the catalogue of pull request <a href="[^"]*/pull/563"'
check none-pr 'not a closed pull request' '/pull/500"' absent
check none-pr 'not an open pull request without catalogue' '/pull/562"' absent
for id in $( jq -r '.vendors[].entries | keys[]' "${work}/catalogue.json" ); do
  check none-pr "entry ${id} shown from the pull request" ">${id}</a>"
done
# the overview as the launcher shows the bugs: where each can run, the bench's time, how a find is confirmed
overview=$( grep -o '<table class="overview">.*' <<< "$( tr '\n' ' ' <<< "${out}" )" | sed 's|</table>.*||' )
first_preset=$( node --input-type=module -e "
  const { runOptions } = await import('${work}/html/common/catalogue.js');
  const c = JSON.parse((await import('node:fs')).readFileSync('${work}/catalogue.json', 'utf8'));
  const p = JSON.parse((await import('node:fs')).readFileSync('${work}/presets.json', 'utf8'));
  const [vendor, id, e] = Object.entries(c.vendors).flatMap(([v, x]) => Object.entries(x.entries).map(([i, e]) => [v, i, e]))
    .find(([v, i, e]) => runOptions(i, e, p.vendors[v]).length);
  console.log(id + ' ' + runOptions(id, e, p.vendors[vendor])[0].name);" )
grep -q "<span class=\"run-first\" title=\"${first_preset#* }\">" <<< "${overview}" && echo "ok   (overview): run on: ${first_preset% *} first on ${first_preset#* }, the launcher's pick" || { echo "FAIL (overview): run on ${first_preset}"; fail=1; }
check dev 'a bug with a patch: confirmed by it' 'its patch \('
if jq -e '[.vendors[].entries[] | select(.oracle and ((.patches // []) | length == 0) and .replayable != false)] | length > 0' "${work}/catalogue.json" > /dev/null; then
  check dev 'a bug without patch: its signature only, weak' 'signature only: no patch .weak: any '
fi
for filter in lib cat puffin nowitness; do check dev "the filter ${filter} of the overview" "data-filter=\"${filter}\""; done
check dev 'no time without the measurements of the bench' 'none yet; hover for the task'
check times 'the time to find a bug on the bench' '16 min 53 s · 5/5'

exit ${fail}
