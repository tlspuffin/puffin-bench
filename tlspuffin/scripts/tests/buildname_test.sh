#!/bin/bash
# buildname_test.sh <tlspuffin clone with the catalogue and puffin-build's names> [<commit>]: the names of builds the
# launcher's picker composes (data/html/common/buildname.js) against the clone's mk_vendor, with node:
#   - every version of every vendor, ASan on and off, as released, fix-all and only-<bug> for each bug in its code
#     (its alias when it has one): mk_vendor builds the name (`mk_vendor list`), with the fixes and the ASan the picker
#     says (Contents), and the name reads well to the picker's check of names typed by hand (Parse);
#   - each alias of presets.toml that the picker says is an only-<bug> or fix-all build (heap: 5.4.0 · ASan · only HEAP)
#     is that build for mk_vendor (same fixes, same ASan);
#   - names typed by hand: problems said (an unknown version, modifier or bug; two catalogue parts), none for good ones;
#   - the slug of each name mk_vendor builds (Slug: a campaign's configuration is named after it) is mk_vendor's.
# Needs the clone's mk_vendor built (target/debug/mk_vendor, or MK_VENDOR=<path>) and git_restapi's scripts.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
bench=$( cd "${here}/../../.." && pwd )
clone="${1:?usage: buildname_test.sh <tlspuffin clone> [<commit>]}"; commit="${2:-HEAD}"
command -v node > /dev/null || { echo "SKIP: node not found"; exit 0; }
mk_vendor=$( realpath -m "${MK_VENDOR:-${clone}/target/debug/mk_vendor}" )
[ -x "${mk_vendor}" ] || { echo "FAIL: no mk_vendor at ${mk_vendor} (cargo build -p puffin-build --bin mk_vendor, or MK_VENDOR=<path>)"; exit 1; }
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
"${bench}/git_restapi/scripts/tlspuffin_catalogue.sh" "${clone}" "${commit}" > "${work}/catalogue.json"
"${bench}/git_restapi/scripts/tlspuffin_presets.sh" "${clone}" "${commit}" > "${work}/presets.json"
jq -e '.names' "${work}/presets.json" > /dev/null || { echo "SKIP: ${commit} has no names of builds (tlspuffin 54b07f490)"; exit 0; }
mkdir -p "${work}/html/common"
command cp -f "${bench}/tlspuffin/data/html/common/"*.js "${work}/html/common/"
echo '{ "type": "module" }' > "${work}/package.json"
cat > "${work}/run.mjs" <<'EOF'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const [, , work, clone, mkVendor] = process.argv;
const { Versions, Compose, Contents, Parse, Needs, bugName, idOf, Slug } = await import(`${work}/html/common/buildname.js`);
const { inRange } = await import(`${work}/html/common/catalogue.js`);
let fail = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail = 1; };
const catalogue = JSON.parse(readFileSync(`${work}/catalogue.json`));
const presets = JSON.parse(readFileSync(`${work}/presets.json`));
const list = (vendor, name) => {
  try { return JSON.parse(execFileSync(mkVendor, ['list', `${vendor}:${name}`, '--json'], { cwd: clone, stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (e) { return { error: String(e.stderr ?? e).split('\n').filter(Boolean).pop() }; }
};
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
let names = 0; const wrong = [], refused = [], unread = [], unslugged = [];
for (const [vendor, builds] of Object.entries(presets.vendors)) {
  const entries = catalogue.vendors?.[vendor]?.entries ?? {};
  const defaults = Object.fromEntries(Object.entries(presets.modifiers?.[vendor] ?? {}).map(([m, d]) => [m, !!d.default]));
  for (const { version } of Versions(builds)) {
    const bugs = Object.entries(entries).filter(([, e]) => e.affected && inRange(e.affected, version)).map(([id, e]) => bugName(id, e));
    for (const asan of [true, false]) {
      for (const part of [null, { kind: 'fix-all' }, ...bugs.map(bug => ({ kind: 'only', bug }))]) {
        const target = part?.kind === 'only' ? entries[idOf(part.bug, entries)] : null;
        const { asan: _drop, ...required } = target ? Needs(target) : {};
        const modifiers = { asan, ...required };
        const name = Compose({ version, modifiers, defaults, part });
        const options = { ...defaults, ...modifiers };
        const predicted = Contents({ version, options, fix: [], part }, entries);
        const mk = list(vendor, name);
        names++;
        if (mk.error) { refused.push(`${vendor}:${name} (${mk.error})`); continue; }
        if (!same(mk.fix ?? [], predicted.patched) || mk.asan !== asan)
          wrong.push(`${vendor}:${name}: picker fixes [${predicted.patched}] asan ${asan}, mk_vendor fixes [${mk.fix}] asan ${mk.asan}`);
        const parsed = Parse(name, { presets: builds, modifiers: presets.modifiers?.[vendor] ?? {}, entries });
        if (parsed.problems.length) unread.push(`${vendor}:${name}: ${parsed.problems.join('; ')}`);
        const slug = Slug(name, { presets: builds, modifiers: presets.modifiers?.[vendor] ?? {}, entries });
        if (slug !== mk.slug) unslugged.push(`${vendor}:${name}: Slug ${slug}, mk_vendor ${mk.slug}`);
      }
    }
  }
}
check(names > 100, `${names} names composed`);
check(refused.length === 0, `mk_vendor builds every one${refused.length ? ': refused ' + refused.slice(0, 5).join(', ') : ''}`);
check(wrong.length === 0, `with the fixes and ASan the picker says${wrong.length ? ': ' + wrong.slice(0, 5).join('; ') : ''}`);
check(unread.length === 0, `each reads well to the check of typed names${unread.length ? ': ' + unread.slice(0, 5).join('; ') : ''}`);
check(unslugged.length === 0, `each has mk_vendor's slug (Slug: a campaign's configuration is named after it)${unslugged.length ? ': ' + unslugged.slice(0, 5).join('; ') : ''}`);
// aliases the picker gives an equivalent: that build for mk_vendor
const claims = [];
for (const [vendor, builds] of Object.entries(presets.vendors)) {
  const entries = catalogue.vendors?.[vendor]?.entries ?? {};
  const defaults = Object.fromEntries(Object.entries(presets.modifiers?.[vendor] ?? {}).map(([m, d]) => [m, !!d.default]));
  for (const alias of builds.filter(b => b.kind === 'alias')) {
    const options = { ...defaults, asan: alias.asan, postauth: alias.postauth, sancov: alias.sancov };
    const held = Contents({ version: alias.version, options, fix: alias.fix }, entries);
    const candidates = [{ kind: 'fix-all' }, ...held.present.map(id => ({ kind: 'only', bug: bugName(id, entries[id]) }))];
    for (const part of candidates) {
      const composed = Contents({ version: alias.version, options, fix: [], part }, entries);
      if (!same(composed.patched, alias.fix)) continue;
      const modifiers = Object.fromEntries(Object.keys(defaults).map(m => [m, options[m]]));
      const name = Compose({ version: alias.version, modifiers, defaults, part });
      const a = list(vendor, alias.name), b = list(vendor, name);
      claims.push(`${alias.name} = ${name}`);
      check(!a.error && !b.error && same(a.fix, b.fix) && a.asan === b.asan, `${vendor}:${alias.name} is ${name} for mk_vendor`);
      break;
    }
  }
}
check(claims.length > 0, `aliases with an equivalent: ${claims.join(', ') || 'none'}`);
// names typed by hand
const wolf = presets.vendors.wolfssl ?? [], wolfMods = presets.modifiers?.wolfssl ?? {}, wolfEntries = catalogue.vendors?.wolfssl?.entries ?? {};
const problems = name => Parse(name, { presets: wolf, modifiers: wolfMods, entries: wolfEntries }).problems;
const good = ['584,asan', '5.8.4,asan', 'wolfssl584-asan', 'wolfssl540-asan-only-HEAP', '540-asan-only-BUF', '5.4.0,no-postauth,only-SDOS2',
  'wolfssl540-heap', '5.4.0,asan,fix-all', 'BUF', 'CVE-2022-39173', '5.4.0,only-cve-2022-39173+heap'];
check(good.every(n => problems(n).length === 0), `good names: no problem (${good.filter(n => problems(n).length).map(n => `${n}: ${problems(n)}`).join('; ') || good.length})`);
const bad = { '202403,asan': /not a version/, '5.8.4,asaan': /not a modifier/, '5.4.0,only-NOPE': /not a bug/, '5.4.0,fix-all,only-BUF': /one catalogue part/ };
check(Object.entries(bad).every(([n, re]) => problems(n).some(p => re.test(p))),
  `bad names: the problem said (${Object.keys(bad).map(n => `${n}: ${problems(n).join('; ')}`).join(' | ')})`);
// names typed by hand as mk_vendor reads them: the check says a problem exactly when mk_vendor refuses the name, and
// reads the version it builds when it does not, and its slug (Slug, a campaign's configuration name). The case of modifiers and keywords; a version written otherwise (3.4,
// master for main); a bug alone and only-<bug> alone (its reference build); a bug not in the build (its version, the
// options it requires), a required option said otherwise, a preset that fixes it; fix-<bug> without a patch at its
// version; both m and no-m; gcov with sancov; no-<modifier> and a '-' left in the dashed form. A version's build with
// ASan as git_restapi lists it (wolfssl584-asan) is no preset of presets.toml: refused before a comma, the version's
// build and asan when dashed (wolfssl584-asan-no-asan says both); an empty part, also first (,only-HEAP); an alias and
// fix-<a bug it fixes> built with a comma, refused dashed; only-<that bug> refused both ways; an alias with ASan and
// no-asan built
const asTyped = {
  openssl: ['3.4', '3.4,asan', '1.1.1u,ASAN', '111u', '1.1.1u', '340', '341,asan', '3', '1.1', '1.1.1j,postauth',
            ',only-Heartbleed', 'openssl341-asan,no-sancov'],
  boringssl: ['master', 'master,asan', 'main', 'MASTER', '0.20260508.0', '20260508', 'main-asan',
              'boringssl20260508-asan,gcov', 'boringssl20260508-asan-no-asan', 'boringssl20260508-asan-gcov'],
  wolfssl: ['5.4.0,ONLY-HEAP', '5.4.0,only-heap', 'HEAP', 'heap', 'CVE-2022-42905', 'BUF', 'SDOS2', 'only-HEAP',
            'only-SDOS2', 'only-BUF+HEAP', '5.4.0,only-CDOS', '5.3.0,only-CDOS', '5.8.4,only-CVE-2024-5814',
            '5.7.2,only-CVE-2024-5814',
            '5.4.0,postauth,only-SDOS2', '5.4.0,only-SDOS2', 'wolfssl540-only-SDOS2', 'wolfssl540,only-SDOS2',
            'wolfssl540-buf,only-HEAP', '5.4.0,fix-CDOS', '5.3.0,fix-CDOS', '5.4.0,fix-SDOS2', '5.4.0,asan,no-asan',
            '540-asan-no-asan', '5.4.0,sancov,gcov', '5.4.0,gcov', '5.4.0,no-asan,only-HEAP', '540-no-asan',
            '5.4.0-no-postauth', '540-no-asan-', '540-no-bogus', '5.8.4,asan,', 'master', 'master,asan', '54',
            'wolfssl584-asan,gcov', 'wolfsslmaster-asan,gcov', 'wolfssl584-asan,fix-all', 'wolfssl584-asan-no-asan',
            'wolfssl584-asan', 'wolfssl584-asan-gcov', 'wolfssl584-asan-fix-all', ',only-HEAP', ',asan', '5.8.4,,asan',
            'wolfssl530-cdos,fix-BUF', 'wolfssl530-cdos,gcov,fix-BUF', 'wolfssl530-cdos-fix-BUF', 'wolfssl530-cdos,only-BUF',
            'wolfssl530-cdos-only-BUF', 'wolfssl540-heap-no-asan', 'wolfssl540-heap,no-asan', 'wolfssl540-asan-perf-no-asan',
            '5.8.4,gcov', '5.4.0,asan,gcov,fix-all', 'wolfssl540-heap,gcov', 'master,asan,gcov', '5.4.0,no-asan,fix-all',
            '5.4.0,llvm_cov,only-BUF', '5.4.0,no-postauth', 'wolfssl540-sdos2,asan'],
};
const disagree = [];
for (const [vendor, typed] of Object.entries(asTyped)) {
  for (const name of typed) {
    const mk = list(vendor, name);
    const p = Parse(name, { presets: presets.vendors[vendor] ?? [], modifiers: presets.modifiers?.[vendor] ?? {},
                            entries: catalogue.vendors?.[vendor]?.entries ?? null });
    if (!!mk.error !== (p.problems.length > 0)) {
      disagree.push(`${vendor}:${name}: mk_vendor ${mk.error ? `refuses it (${mk.error})` : `builds ${mk.slug}`}, `
                  + `the check ${p.problems.length ? `says ${p.problems.join('; ')}` : 'says nothing'}`);
    } else if (!mk.error && p.version !== mk.version) {
      disagree.push(`${vendor}:${name}: version ${p.version}, mk_vendor's ${mk.version}`);
    } else if (!mk.error) {
      const slug = Slug(name, { presets: presets.vendors[vendor] ?? [], modifiers: presets.modifiers?.[vendor] ?? {},
                                entries: catalogue.vendors?.[vendor]?.entries ?? null });
      if (slug !== mk.slug) disagree.push(`${vendor}:${name}: slug ${slug}, mk_vendor's ${mk.slug}`);
    }
  }
}
check(!disagree.length, `names typed by hand, as mk_vendor reads them: ${disagree.join(' | ')
  || `${Object.values(asTyped).flat().length} names agree`}`);
// the catalogue not loaded (loading, or failed): a name that may be a bug is not checked, not refused
const without = Parse('HEAP', { presets: wolf, modifiers: wolfMods, entries: null });
check(!without.problems.length && without.unchecked.length > 0,
  `without the catalogue, a bug named alone: not checked, not refused (${
    without.unchecked.join('; ') || without.problems.join('; ')})`);
process.exit(fail);
EOF
taskset -c 0 nice -n 19 node "${work}/run.mjs" "${work}" "${clone}" "${mk_vendor}"
