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
echo '' > "${work}/html/board/nav.js"   # the navigation bar needs a real DOM
echo '{ "type": "module" }' > "${work}/package.json"
"${bench}/git_restapi/scripts/tlspuffin_catalogue.sh" "${clone}" "${commit}" > "${work}/catalogue.json"
command cp -f "${bench}/tlspuffin/data/html/jobsscripts/tlspuffin/vuln_targets.json" "${work}/vuln_targets.json"

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
  check dev "entry ${id} has its card" "<section class=\"entry[^\"]*\" id=\"${id}\""
done
missing=$( node "${work}/run.mjs" "${work}" leaves )
[ -z "${missing}" ] && echo "ok   (dev): every value of every entry is on the page" || { echo "FAIL (dev): values not on the page:"; sed 's/^/       /' <<< "${missing}"; fail=1; }
check extra 'a field the page does not know is shown' '<code>future_field</code>'
check extra 'a find field the page does not know is shown' '<code>find.future_find</code>'
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
check dev 'the legacy tables are still there' 'Expected bug of each configuration'
check commit 'a commit asked with ?commit= is named' 'catalogue of tlspuffin commit deadbeef'
check unavailable 'an unavailable catalogue is said' 'is not available'
check none 'a commit without catalogue is said' 'has no vulnerability catalogue yet'

exit ${fail}
