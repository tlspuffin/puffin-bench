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
mkdir -p "${work}/html/common" && command cp -f "${bench}/tlspuffin/data/html/common/catalogue.js" "${work}/html/common/"
echo '' > "${work}/html/board/nav.js"   # the navigation bar needs a real DOM
echo '{ "type": "module" }' > "${work}/package.json"
"${bench}/git_restapi/scripts/tlspuffin_catalogue.sh" "${clone}" "${commit}" > "${work}/catalogue.json"
"${bench}/git_restapi/scripts/tlspuffin_presets.sh" "${clone}" "${commit}" > "${work}/presets.json"
command cp -f "${bench}/tlspuffin/data/html/jobsscripts/tlspuffin/vuln_targets.json" "${work}/vuln_targets.json"
# a registry of the bugs found so far (known_bugs.json): the same crash in two configurations of wolfSSL (HEAP of the
# catalogue, by its ASan report type and top frame), a crash of LibreSSL none of the known bugs, a claim set apart
cat > "${work}/known_bugs.json" <<'JSON'
{ "WolfSSL|crash|AddPacketInfo": { "task": "1790851747037", "started": "2026-10-01T10:49:07Z", "what": "heap-buffer-overflow: AddPacketInfo < DoTls13HandShakeMsgType < DoTls13HandShakeMsg" },
  "wolfssl540-asan|crash|AddPacketInfo": { "task": "1791638282947", "started": "2026-10-10T08:00:00Z", "what": "heap-buffer-overflow: AddPacketInfo < DoTls13HandShakeMsgType < DoTls13HandShakeMsg" },
  "LibreSSL|crash|tls13_hkdf_expand_label_with_length": { "task": "1790851749055", "started": "2026-10-01T11:00:00Z", "what": "global-buffer-overflow: MemcmpInterceptorCommon < tls13_hkdf_expand_label_with_length" },
  "BUF|claim|Negotiated cipher is not in agent's configured ciphers list": { "task": "1791237378849", "started": "2026-10-05T09:00:00Z", "what": "security-violation: Negotiated cipher is not in agent's configured ciphers list" },
  "CDOS|claim|Negotiated cipher is not in agent's configured ciphers list": { "task": "1791237386132", "started": "2026-10-06T09:00:00Z", "what": "security-violation: Negotiated cipher is not in agent's configured ciphers list" } }
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
first_row=$( grep -o '<tr class="[^"]*">' <<< "${registry}" | head -1 )
[ "${first_row}" == '<tr class="unknown-bug">' ] && grep -q 'tls13_hkdf_expand_label_with_length' <<< "$( grep -o '<tr class="unknown-bug">.\{0,400\}' <<< "${registry}" | head -1 )" &&
  echo "ok   (registry): the bug none of the known ones (LibreSSL) first" || { echo "FAIL (registry): the unknown bug is not first"; fail=1; }
grep -q 'set apart' <<< "$( grep -o "<code>Negotiated cipher.\{0,600\}" <<< "${registry}" )" && echo "ok   (registry): the claim set apart" || { echo "FAIL (registry): claim not set apart"; fail=1; }
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
row() { grep -o "<td><b>$1</b></td>.\{0,1800\}" <<< "${configs}" | head -1 | sed 's|</tr>.*||'; }
grep -q "every patch but its bug" <<< "$( row BUF )" && grep -q '✓' <<< "$( row BUF )" && echo "ok   (configs): BUF's preset is every patch but its bug's" || { echo "FAIL (configs): BUF"; fail=1; }
grep -q '≠' <<< "$( row SDOS2 )" && grep -q 'not patched: HEAP' <<< "$( row SDOS2 )" && echo "ok   (configs): SDOS2's preset leaves HEAP unpatched (it has a patch at 5.4.0)" || { echo "FAIL (configs): SDOS2"; fail=1; }
grep -q 'CVE-2021-3449' <<< "$( row SDOS1 )" && grep -q 'no target declared' <<< "$( row SDOS1 )" && echo "ok   (configs): VulnB's SDOS1, CVE-2021-3449, no target declared" || { echo "FAIL (configs): SDOS1"; fail=1; }
check dev 'the differences of _cves with the catalogue' 'CVE-2023-6936</a> <span class="muted">CALLB</span>: not in the catalogue'
check dev 'the claim set apart agrees with the catalogue' '✓ agrees'
check commit 'a commit asked with ?commit= is named' 'catalogue of tlspuffin commit deadbeef'
check unavailable 'an unavailable catalogue is said' 'is not available'
check none 'a commit without catalogue is said' 'has no vulnerability catalogue yet'

exit ${fail}
