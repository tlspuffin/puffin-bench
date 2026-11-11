#!/bin/bash
# custombench_test.sh <tlspuffin clone with the catalogue> [<commit>]: the launcher's custom benchmarks
# (data/html/board/launchers/tlspuffin/custombench.js) against the catalogue's own rules, with node:
#   - versions and ranges (parseVersion, compareVersions, inRange) as puffin-build/src/catalogue/version.rs: OpenSSL
#     letters, pre-releases, missing numbers, development heads, alternatives;
#   - where each bug can run (activeOn) for every preset of every vendor, against `mk_vendor list <vendor>:<preset>`
#     of the clone: a preset the launcher offers must have the bug active for mk_vendor, except a PUT capability the
#     launcher cannot know (listed, then refused by the build step); a preset where mk_vendor has it active must be
#     offered, except a non-ASan preset of a bug only detected with ASan (find.asan);
#   - patches (patchedAt) against mk_vendor's `patchable`.
# Needs the clone's mk_vendor built (target/debug/mk_vendor, or MK_VENDOR=<path> for another target folder) and
# git_restapi's tlspuffin_catalogue.sh and tlspuffin_presets.sh (the data the launcher gets).
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
bench=$( cd "${here}/../../.." && pwd )
clone="${1:?usage: custombench_test.sh <tlspuffin clone> [<commit>]}"; commit="${2:-HEAD}"
command -v node > /dev/null || { echo "SKIP: node not found"; exit 0; }
mk_vendor=$( realpath -m "${MK_VENDOR:-${clone}/target/debug/mk_vendor}" )
[ -x "${mk_vendor}" ] || { echo "FAIL: no mk_vendor at ${mk_vendor} (cargo build -p puffin-build --bin mk_vendor, or MK_VENDOR=<path>)"; exit 1; }
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
"${bench}/git_restapi/scripts/tlspuffin_catalogue.sh" "${clone}" "${commit}" > "${work}/catalogue.json"
"${bench}/git_restapi/scripts/tlspuffin_presets.sh" "${clone}" "${commit}" > "${work}/presets.json"
# what mk_vendor says of every preset: { <vendor>: { <preset>: { <ID>: [state, patchable] } } }
echo '{}' > "${work}/states.json"
for vendor in $( jq -r '.vendors | keys[]' "${work}/presets.json" ); do
  for preset in $( jq -r --arg v "${vendor}" '.vendors[$v][].name' "${work}/presets.json" ); do
    ( cd "${clone}" && "${mk_vendor}" list "${vendor}:${preset}" --json 2> /dev/null ) |
      jq -c --arg v "${vendor}" --arg p "${preset}" '{ ($v): { ($p): ([.entries[] | { (.id): [.state, .patchable] }] | add // {}) } }' > "${work}/one.json" || continue
    jq -s '.[0] * .[1]' "${work}/states.json" "${work}/one.json" > "${work}/merged.json" && mv "${work}/merged.json" "${work}/states.json"
  done
done
mkdir -p "${work}/html/board/launchers/tlspuffin" "${work}/html/common"
command cp -f "${bench}/tlspuffin/data/html/board/launchers/tlspuffin/custombench.js" "${work}/html/board/launchers/tlspuffin/"
command cp -f "${bench}/tlspuffin/data/html/common/catalogue.js" "${work}/html/common/"
echo '{ "type": "module" }' > "${work}/package.json"
cat > "${work}/run.mjs" <<'EOF'
import { readFileSync } from 'node:fs';
const [, , work] = process.argv;
const { parseVersion, compareVersions, inRange, activeOn, patchedAt } = await import(`${work}/html/board/launchers/tlspuffin/custombench.js`);
let fail = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail = 1; };
// versions, as version.rs
const order = ['0.9.8', '0.9.8z', '0.9.8za', '0.9.8zd', '1.0.0', '1.0.0p', '1.0.1', '1.0.1a', '1.0.1f', '1.0.1g', '1.0.2u',
  '1.1.1', '1.1.1j', '1.1.1k', '3.0.0-alpha1', '3.0.0', '3.4.1', '4.3.0', '5.4', '5.4.1', '5.5.0', '5.8.4', 'master'];
check(order.every((v, i) => i === 0 || compareVersions(order[i - 1], v) < 0), `versions in order: ${order.join(' < ')}`);
check(compareVersions('5.4', '5.4.0') === 0 && compareVersions('5.4.0', '5.4') === 0, '5.4 = 5.4.0');
check(compareVersions('master', 'main') === 0, 'development heads are equal');
check(compareVersions('1.1.1g+git.368d0d87d0bd', '1.1.1g') === 0 && compareVersions('1.1.1g+git.368d0d87d0bd', '1.1.1h') < 0,
  'build metadata is not compared (1.1.1g+git.368d0d87d0bd = 1.1.1g)');
check(inRange('< 0.9.8zd || >= 1.0.0, < 1.0.0p || >= 1.0.1, < 1.0.1k', '1.0.1f') && !inRange('< 0.9.8zd || >= 1.0.0, < 1.0.0p || >= 1.0.1, < 1.0.1k', '1.0.1k')
  && inRange('< 0.9.8zd || >= 1.0.0, < 1.0.0p', '0.9.8z') && !inRange('< 0.9.8zd || >= 1.0.0, < 1.0.0p', '0.9.8zd'), 'alternatives of FREAK');
check(inRange('= 5.3.0', '5.3') && !inRange('= 5.3.0', '5.3.1') && inRange('>= 5.4.0, < 5.5.0', '5.4.0') && !inRange('< 5.7.2', 'master'), 'comparisons');
// where each bug can run, against mk_vendor
const catalogue = JSON.parse(readFileSync(`${work}/catalogue.json`));
const presets = JSON.parse(readFileSync(`${work}/presets.json`));
const states = JSON.parse(readFileSync(`${work}/states.json`));
let offered = 0, capability = [], missing = [], patchErrors = [];
for (const [vendor, v] of Object.entries(catalogue.vendors)) for (const [id, entry] of Object.entries(v.entries)) {
  for (const preset of presets.vendors[vendor] ?? []) {
    const state = states[vendor]?.[preset.name]?.[id];
    if (!state) continue;
    const js = activeOn(id, entry, preset), mk = state[0] === 'active';
    if (js) offered++;
    if (js && !mk) capability.push(`${id} on ${preset.name} (${state[0]})`);
    if (!js && mk && !(entry.find?.asan && !preset.asan)) missing.push(`${id} on ${preset.name}`);
    if (mk && patchedAt(entry, preset.version) !== state[1]) patchErrors.push(`${id} on ${preset.name}: launcher ${patchedAt(entry, preset.version)}, mk_vendor ${state[1]}`);
  }
}
check(offered > 0, `${offered} (bug, preset) pairs offered`);
check(missing.length === 0, `every preset where mk_vendor has a bug is offered${missing.length ? ': missing ' + missing.join(', ') : ''}`);
check(patchErrors.length === 0, `patches as mk_vendor's patchable${patchErrors.length ? ': ' + patchErrors.join('; ') : ''}`);
// offered but not active for mk_vendor: only PUT capabilities may explain it (the build step refuses the experiment)
const notCapability = capability.filter(c => !/\(unaffected\)$/.test(c));
check(notCapability.length === 0, `offered presets without the bug are all "unaffected" (PUT capabilities): ${capability.length}${capability.length ? ' — ' + capability.join(', ') : ''}`);
process.exit(fail);
EOF
node "${work}/run.mjs" "${work}"
