// The rules of tlspuffin's vulnerability catalogue the pages need (the launcher's custom benchmarks, the Bugs reference):
// versions and ranges as puffin-build/src/catalogue/version.rs, where a bug is, where it has a patch. Checked against
// mk_vendor on every preset (scripts/tests/custombench_test.sh).

// A version: dotted numbers (missing ones are 0), then letters (a patch release after it, OpenSSL: 1.0.1 < 1.0.1a,
// 0.9.8z < 0.9.8za) or -<pre-release> (before it); not starting with a digit (master): newer than every release.
export function parseVersion(text) {
  // +<text>: build metadata, not compared (BoringSSL's commits: 1.1.1g+git.368d0d87d0bd = 1.1.1g)
  const t = String(text ?? '').trim().replace(/\+.*$/, '');
  if (!/^[0-9]/.test(t)) return { head: true };
  const m = /^([0-9]+(?:\.[0-9]+)*)(.*)$/.exec(t);
  const numbers = m[1].split('.').map(Number);
  while (numbers.length > 1 && numbers[numbers.length - 1] === 0) numbers.pop();
  const rest = m[2];
  const suffix = rest === '' ? { rank: 1 } : rest.startsWith('-') ? { rank: 0, text: rest.slice(1) } : { rank: 2, text: rest };
  return { numbers, suffix };
}
export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a, y = typeof b === 'string' ? parseVersion(b) : b;
  if (x.head || y.head) return (x.head ? 1 : 0) - (y.head ? 1 : 0);
  for (let i = 0; i < Math.min(x.numbers.length, y.numbers.length); i++) {
    if (x.numbers[i] !== y.numbers[i]) return x.numbers[i] < y.numbers[i] ? -1 : 1;
  }
  if (x.numbers.length !== y.numbers.length) return x.numbers.length < y.numbers.length ? -1 : 1;
  if (x.suffix.rank !== y.suffix.rank) return x.suffix.rank < y.suffix.rank ? -1 : 1;
  if (x.suffix.rank === 2 && x.suffix.text.length !== y.suffix.text.length) return x.suffix.text.length < y.suffix.text.length ? -1 : 1;
  return x.suffix.text === y.suffix.text ? 0 : (x.suffix.text ?? '') < (y.suffix.text ?? '') ? -1 : 1;
}
// a range: alternatives separated by ||, each comparisons separated by , that must all hold (>= 1.0.0, < 1.0.0p)
export function inRange(range, version) {
  if (!range) return false;
  return String(range).split('||').some(alternative => alternative.split(',').every(comparison => {
    const m = /^\s*(<=|>=|<|>|=)\s*(\S+)\s*$/.exec(comparison);
    if (!m) return false;
    const c = compareVersions(version, m[2]);
    return { '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0, '=': c === 0 }[m[1]];
  }));
}

// whether a bug is in the code a preset builds: its version is affected, it has the build options the bug requires,
// it does not fix it (PUT capabilities: the build tells, see PR_common.sh ForcedBuild)
export function presentOn(id, entry, preset) {
  if (entry.affected && !inRange(entry.affected, preset.version)) return false;
  for (const [option, value] of Object.entries(entry.requires ?? {})) if (preset[option] !== value) return false;
  return !(preset.fix ?? []).includes(id);
}
// whether a preset is offered to look for a bug: the bug is in its code, and it is an ASan build when the bug is only
// detected with ASan (find.asan)
export function activeOn(id, entry, preset) {
  return presentOn(id, entry, preset) && !(entry.find?.asan && !preset.asan);
}
// whether a bug is only recognised with ASan (its oracle is an ASan report, or find.asan): its experiments are built
// with ASan whatever the preset (mk_vendor make --asan, job scripts: asan_build)
export function needsAsan(entry) { return !!(entry.oracle?.asan || entry.find?.asan); }
// whether a bug has a patch at a version (its finds are then validated by patch differential)
export function patchedAt(entry, version) { return (entry.patches ?? []).some(p => p.versions && inRange(p.versions, version)); }

// the presets of a commit a bug can run on (activeOn), the safest first: a version where it has a patch (its finds
// validated by patch differential), then the newest, ASan first, the fewest fixes, the shortest name; each with
// patched (it has a patch there) and witness (its witness reaches that version, witness_versions)
export function runOptions(id, entry, presets) {
  return (presets ?? []).filter(p => activeOn(id, entry, p))
    .map(p => ({ ...p, patched: patchedAt(entry, p.version), witness: !entry.witness_versions || inRange(entry.witness_versions, p.version) }))
    .sort((a, b) => (b.patched ? 1 : 0) - (a.patched ? 1 : 0) || compareVersions(b.version, a.version) || (b.asan ? 1 : 0) - (a.asan ? 1 : 0)
                   || (a.fix?.length ?? 0) - (b.fix?.length ?? 0) || a.name.length - b.name.length);
}
// how a find of a bug is confirmed: by its patch (patch differential), by its signature only (no patch), the fuzzer's
// own record (its objectives do not replay), or not at all (no oracle); text: what the pages show
export function confirmation(entry) {
  if (!entry.oracle) return { kind: 'none', text: 'no oracle: cannot be recognised' };
  if (entry.replayable === false) return { kind: 'record', text: 'the fuzzer\'s record only: not replayable' };
  if ((entry.patches ?? []).length) return { kind: 'patch', text: `its patch (${entry.patches.map(p => p.versions ?? p.commits ?? '').join(' · ')})` };
  return { kind: 'signature', text: 'signature only: no patch' };
}
