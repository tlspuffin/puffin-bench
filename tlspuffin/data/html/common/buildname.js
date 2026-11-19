// Names of the builds of tlspuffin's vendors, as puffin-build writes them at the commits that have its names
// (puffin-build/src/catalogue/spec.rs, tlspuffin 54b07f490): the launcher's picker composes them, checks a name typed by
// hand, and says what a build holds. Checked against mk_vendor (scripts/tests/buildname_test.sh).
//
// A name (what follows "<vendor>:") is <version>[,<modifier>…][,<catalogue part>]: the version as presets.toml writes it
// (5.4.0), the same release written otherwise (5.4), without its dots when unambiguous (540), a development head by its
// other name (master for main), or a preset's name in its place (wolfssl540-heap); modifiers asan, sancov, gcov,
// llvm_cov and the builder's options (wolfSSL's postauth), each also no-<modifier>, in lower case (not both; gcov
// implies no-sancov, so not with sancov); at most one catalogue part: only-<bugs> (every other known bug of the build
// patched), fix-<bugs> (these patched), fix-all (every known bug that has a patch at its version patched), <bugs> being
// IDs or aliases (any case) joined by +, each in the build (and, for fix-, with a patch at its version). The same with
// '-' between the parts (540-asan-only-BUF), a preset followed by -<modifier>s and a catalogue part
// (wolfssl540-asan-only-HEAP: nothing implied), only-<bug> without a version or an ID or alias alone (the bug's
// reference build, only that bug left, with ASan). only-<bugs> brings what its bugs need (their required options, ASan
// when their oracle is an ASan report) unless the name says otherwise (a required option said otherwise: the build
// would not have the bug): the picker always writes ASan out with a catalogue part, so that its ASan is the one chosen.

import { presentOn, patchedAt, needsAsan, compareVersions, parseVersion, inRange } from './catalogue.js';

// a bug's name in builds and labels: its alias when it has one (HEAP), else its ID (CVE-2024-5814)
export const bugName = (id, entry) => entry?.alias || id;

// The versions of a vendor (git_restapi's presets: the builds of kind "version" without modifier), newest first, with
// their build's name: [{ version: '5.4.0', name: 'wolfssl540' }]; development heads (master, main) first
export function Versions(presets) {
  const seen = new Map();
  for (const p of presets ?? []) {
    if (p.kind === 'version' && !p.asan && !seen.has(p.version)) seen.set(p.version, { version: p.version, name: p.name });
  }
  return [...seen.values()].sort((a, b) => compareVersions(b.version, a.version));
}

// The name of a build from its parts: version (as presets.toml writes it), the modifiers chosen ({ asan: true, ... }),
// the vendor's defaults ([modifiers]: { asan: false, ... }), a catalogue part ({ kind: 'only', bug: 'HEAP' } or
// { kind: 'fix-all' }, or null). A modifier is written when it differs from its default; ASan always with a catalogue
// part (only-<bug> would bring it); not sancov off with gcov (gcov implies it).
export function Compose({ version, modifiers = {}, defaults = {}, part = null }) {
  const tokens = [];
  for (const [m, on] of Object.entries(modifiers)) {
    if (m === 'sancov' && !on && modifiers.gcov) continue;
    const byDefault = !!defaults[m];
    if (on !== byDefault || (m === 'asan' && part)) tokens.push(on ? m : `no-${m}`);
  }
  if (part?.kind === 'fix-all') tokens.push('fix-all');
  else if (part?.kind) tokens.push(`${part.kind}-${part.bug}`);   // only-<bug>, or as typed: fix-<bugs>, only-<A+B>
  return [version, ...tokens].join(',');
}

// What the options of a build are once its catalogue part is applied: only-<bug> brings what the bug needs (its
// required options; ASan when only an ASan report shows it), unless said (said: the modifiers the name writes out)
export function Needs(entry) {
  return { ...(entry?.requires ?? {}), ...(entry && needsAsan(entry) ? { asan: true } : {}) };
}

// What a build holds: the bugs of the catalogue in its code (presentOn: its version affected, the options they require,
// not fixed by the build itself), which of them it patches (its catalogue part: only-<X> patches the others that have
// a patch at its version, fix-all all of those), and the ones left. build: { version, options: { asan, postauth, ... },
// fix: [IDs the build itself fixes: an alias's fix-…], part }; entries: the vendor's catalogue entries.
// → { present: [IDs], patched: [IDs], left: [IDs], unpatchable: [IDs left without a patch at that version] }
export function Contents(build, entries) {
  const preset = { version: build.version, fix: build.fix ?? [], ...(build.options ?? {}) };
  const present = Object.entries(entries ?? {}).filter(([id, e]) => presentOn(id, e, preset)).map(([id]) => id);
  const patchable = present.filter(id => patchedAt(entries[id], build.version));
  const target = build.part?.kind === 'only' ? idOf(build.part.bug, entries) : null;
  const patched = build.part?.kind === 'fix-all' ? patchable : build.part?.kind === 'only' ? patchable.filter(id => id !== target) : [];
  const left = present.filter(id => !patched.includes(id));
  return { present, patched, left, unpatchable: left.filter(id => !patchedAt(entries[id], build.version)) };
}

// the ID of a bug named by its ID or its alias (any case); null when the catalogue has none
export function idOf(name, entries) {
  const lower = String(name ?? '').toLowerCase();
  for (const [id, e] of Object.entries(entries ?? {})) {
    if (id.toLowerCase() === lower || (e.alias && e.alias.toLowerCase() === lower)) return id;
  }
  return null;
}

// The version of the presets a token names, as mk_vendor reads it (puffin-build's version_of, spec.rs): as written, a
// development head by its other name (main = master) when the vendor has one, the same release written otherwise
// (5.4 = 5.4.0), or without its dots when that is unambiguous (540 = 5.4.0). { version }, { several: [versions] },
// or {}
function VersionOf(token, versions) {
  const all = versions.map(v => v.version);
  if (all.includes(token)) return { version: token };
  const heads = ['master', 'main'];
  const found = heads.includes(token) ? all.filter(v => heads.includes(v))
      : parseVersion(token).head ? [] : all.filter(v => !parseVersion(v).head && compareVersions(v, token) === 0);
  if (found.length === 1) return { version: found[0] };
  const compact = all.filter(v => v.replace(/\./g, '') === token);
  return compact.length === 1 ? { version: compact[0] } : compact.length ? { several: compact } : {};
}

// The version of a bug's reference build (puffin-build's reference_preset, catalogue/mod.rs): the entry's reference (a
// preset, or a version and modifiers), else the newest version of a preset that has the bug and does not fix it; null:
// none (a bug of the harness, keyed by commits). defaults: the vendor's modifiers by default, under each preset
function ReferenceVersion(id, entry, presets, versions, defaults) {
  if (!entry?.affected) return null;
  if (entry.reference) {
    return (presets ?? []).find(p => p.name === entry.reference)?.version
        ?? VersionOf(String(entry.reference).split(',')[0], versions).version ?? null;
  }
  const withBug = (presets ?? []).filter(p => presentOn(id, entry, { ...defaults, ...p, fix: p.fix ?? [] }));
  return withBug.map(p => p.version).sort((a, b) => compareVersions(b, a))[0] ?? null;
}

// mk_vendor's presets among git_restapi's builds: those of presets.toml, not the ones git_restapi derives, each version's
// build with ASan (<its name>-asan: a name of puffin-build's grammar, no preset, so no start: wolfssl584-asan,gcov is
// refused; dashed, wolfssl584-asan-gcov is wolfssl584 with asan and gcov, and wolfssl584-asan-no-asan says both).
// → { names: Map of the presets by name, derived: Set of the derived names }
function TomlPresets(presets) {
  const plain = new Set((presets ?? []).filter(p => p.kind === 'version').map(p => p.name));
  const derived = new Set((presets ?? []).filter(p => p.kind === 'version' && p.asan && p.name.endsWith('-asan')
      && plain.has(p.name.slice(0, -'-asan'.length))).map(p => p.name));
  return { derived, names: new Map((presets ?? []).filter(p => !derived.has(p.name)).map(p => [p.name, p])) };
}

// Parse a name (what follows "<vendor>:") against the vendor's builds at a commit, for the launcher's note on a name
// typed by hand, as mk_vendor reads it: { version, preset, options, part, alone, problems, unchecked } (problems: what
// mk_vendor would refuse, in words; empty when the name reads well; options: the modifiers the name says; alone: a bug
// named alone, its reference build (reference: the version is that build's, also for only-<bug> alone); implies: its only-<bugs> brings what they need (Needs: their options, ASan), as
// mk_vendor does unless the name is a preset followed by modifiers in the form of slugs (wolfssl540-only-HEAP), the
// options the launcher shows (#composerState); unchecked: what could not be checked, the catalogue not loaded). presets:
// git_restapi's builds of the vendor; modifiers: its [modifiers]; entries: its catalogue entries (null: catalogue parts
// not checked).
export function Parse(name, { presets = [], modifiers = {}, entries = null } = {}) {
  const problems = [], unchecked = [];
  const { derived, names } = TomlPresets(presets);
  const versions = Versions(presets);
  const defaults = Object.fromEntries(Object.entries(modifiers ?? {}).map(([m, d]) => [m, !!d?.default]));
  const result = { version: null, preset: null, options: {}, part: null, alone: false, implies: false, problems, unchecked };
  if (!name) { problems.push('no build named'); return result; }
  // a bug alone: its reference build, only that bug left, with ASan
  const alone = entries && !names.has(name) ? idOf(name, entries) : null;
  if (alone) {
    Object.assign(result, { part: { kind: 'only', bugs: [alone] }, alone: true, implies: true, reference: true, options: { asan: true },
                            version: ReferenceVersion(alone, entries[alone], presets, versions, defaults) });
    if (!result.version) problems.push(`${name}: no build of this library has it here (write a version first)`);
    return result;
  }
  let head, tokens;
  if (name.includes(',')) {
    [head, ...tokens] = name.split(',');
    // an empty part, also the first (,only-HEAP): mk_vendor refuses it
    if (head === '') problems.push('an empty part between commas');
  } else {
    // dashed: a catalogue part runs to the end (IDs have dashes); the head is the longest preset name it starts with,
    // else the first part
    const m = /(?:^|-)((?:only|fix)-.+)$/.exec(name);
    const before = m ? name.slice(0, m.index) : name;
    if (before.split('-').some((part, i, all) => part === '' && !(i === all.length - 1 && m))) {
      problems.push(`'${name}': a '-' with nothing after it`);
    }
    const parts = before.split('-').filter(Boolean);
    let n = parts.length;
    while (n > 1 && !names.has(parts.slice(0, n).join('-'))) n--;
    head = parts.slice(0, n).join('-');
    // no-<modifier>: one part
    const rest = [];
    for (let i = n; i < parts.length; i++) {
      rest.push(parts[i] === 'no' && i + 1 < parts.length ? `no-${parts[++i]}` : parts[i]);
    }
    tokens = [...rest, ...(m ? [m[1]] : [])];
  }
  // only-<bug> first: no version, the bug's reference build
  if (/^only-/.test(head)) { tokens = [head, ...tokens]; head = ''; }
  // the head: a preset, a version (VersionOf)
  if (names.has(head)) {
    result.preset = head;
    result.version = names.get(head).version;
  } else if (head) {
    const v = VersionOf(head, versions);
    if (v.version) result.version = v.version;
    else if (derived.has(head)) {
      const base = head.slice(0, -'-asan'.length);
      problems.push(`${head}: not a preset before a comma (${base} with ASan: write ${base},asan,… or ${head}-…)`);
    } else if (v.several) problems.push(`${head} could be ${v.several.join(' or ')}: write the version with its dots`);
    else if (!entries && !tokens.length && /^[A-Za-z]/.test(head)) {
      unchecked.push(`${head}: not a version here; a bug of the catalogue? not checked: the catalogue of the commit is `
                   + 'not loaded');
    } else problems.push(`${head}: not a version here (${versions.map(v => v.version).join(', ') || 'none listed'})`);
  }
  // modifiers and keywords as mk_vendor reads them: in lower case (a bug's name in any case)
  const said = {}, both = new Set();
  for (const token of tokens) {
    if (token === '') { problems.push('an empty part between commas'); continue; }
    const cat = /^(only|fix)-(.+)$/.exec(token);
    if (token === 'fix-all' || cat) {
      if (result.part) { problems.push('one catalogue part at most (only-…, fix-…, fix-all)'); continue; }
      if (token === 'fix-all') { result.part = { kind: 'fix-all', bugs: [] }; continue; }
      const bugs = cat[2].split('+');
      const ids = entries ? bugs.map(b => idOf(b, entries)) : bugs;
      if (entries) bugs.forEach((b, i) => { if (!ids[i]) problems.push(`${b}: not a bug of the catalogue here`); });
      result.part = { kind: cat[1], bugs: ids.filter(Boolean) };
      continue;
    }
    const off = token.startsWith('no-');
    const modifier = off ? token.slice(3) : token;
    if (Object.keys(modifiers ?? {}).length && !(modifier in modifiers)) {
      problems.push(`${token}: not a modifier of this library (${Object.keys(modifiers).join(', ')}, each also no-…)`);
      continue;
    }
    if (modifier in said && said[modifier] !== !off && !both.has(modifier)) {
      both.add(modifier);
      problems.push(`both ${modifier} and no-${modifier}`);
    }
    said[modifier] = !off;
  }
  result.options = said;
  // only-<bugs> brings what they need, unless the name is a preset followed by modifiers in the form of slugs
  result.implies = result.part?.kind === 'only' && !(result.preset && !name.includes(','));
  if (said.gcov === true && said.sancov === true) {
    problems.push('gcov and sancov: a gcov build measures coverage, it is not fuzzed (gcov implies no-sancov)');
  }
  const bugs = result.part?.bugs ?? [];
  if (!head) {
    // only-<bug> alone starts from its reference build; several bugs, or another catalogue part, need a version
    if (result.part?.kind === 'only' && bugs.length === 1 && entries) {
      result.version = ReferenceVersion(bugs[0], entries[bugs[0]], presets, versions, defaults);
      result.reference = true;
      if (!result.version) {
        problems.push(`only-${bugs[0]}: no build of this library has it here (write a version first)`);
      }
    } else if (result.part?.kind === 'only' && bugs.length > 1) {
      problems.push('several bugs need a version (each bug alone starts from its own reference build)');
    } else if (entries || !result.part) {
      problems.push('a version first');
    }
  }
  // each bug of the catalogue part in the build: its version affected, with the options it requires (only-<bugs> brings
  // them, unless the name says otherwise: an error; a preset followed by modifiers in the form of slugs implies
  // nothing), not fixed by the preset it starts from; and for fix-<bugs>, with a patch at its version
  if (entries && result.version && bugs.length && result.part.kind !== 'fix-all') {
    const preset = result.preset ? names.get(result.preset) : null;
    const implies = result.implies;
    const required = implies ? Object.assign({}, ...bugs.map(id => entries[id]?.requires ?? {})) : {};
    for (const id of bugs) {
      for (const [option, value] of implies ? Object.entries(entries[id]?.requires ?? {}) : []) {
        if (option in said && said[option] !== value) {
          problems.push(`${id} needs ${value ? option : `no-${option}`}: without it the build does not have the bug`);
        }
      }
    }
    const build = { ...defaults, ...(preset ?? {}), ...required, ...said,
                    version: result.version, fix: preset?.fix ?? [] };
    for (const id of bugs) {
      const entry = entries[id];
      if (!entry) continue;
      const needs = Object.entries(entry.requires ?? {}).filter(([option, value]) => build[option] !== value)
          .map(([option, value]) => (value ? option : `no-${option}`));
      // a preset that fixes the bug: only-<it> cannot leave it; fix-<it> is refused dashed (wolfssl530-cdos-fix-BUF),
      // after a comma mk_vendor builds the preset as it is (wolfssl530-cdos,fix-BUF)
      if (build.fix.includes(id)) {
        if (result.part.kind === 'only' || !name.includes(',')) problems.push(`${result.preset} fixes ${id}`);
        continue;
      }
      if (!entry.affected || !inRange(entry.affected, result.version)) {
        problems.push(`${id} does not affect ${result.version} (affected: ${entry.affected ?? 'by commits'})`);
      } else if (!presentOn(id, entry, build)) {
        problems.push(`${id} is not in this build: it needs ${needs.join(', ')}`);
      } else if (result.part.kind === 'fix' && !patchedAt(entry, result.version)) {
        problems.push(`${id} has no patch for version ${result.version}`);
      }
    }
  }
  return result;
}

// The label of a name's parts: version, the modifiers written out (postauth off, gcov…), the catalogue part (only HEAP,
// fix-all), ASan; for VendorLabel (joblauncher.js)
export function PartLabels(tokens, entries = null) {
  const out = [];
  let asan = null;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === 'asan') { asan = true; continue; }
    if (lower === 'no-asan') { asan = false; continue; }
    if (lower === 'plain' || lower === '') continue;
    const cat = /^(only|fix)-(.+)$/.exec(token);
    if (lower === 'fix-all') out.push('fix-all');
    else if (cat) out.push(`${cat[1]} ${cat[2].split('+').map(b => { const id = idOf(b, entries); return id ? bugName(id, entries[id]) : b; }).join('+')}`);
    else if (lower.startsWith('no-')) out.push(`${lower.slice(3)} off`);
    else out.push(token);
  }
  return { parts: out, asan };
}

// puffin-build's modifiers in its order (spec.rs modifiers: the instrumentation, then the builder's options by name)
const INSTRUMENTATION = ['asan', 'sancov', 'gcov', 'llvm_cov'];

// The slug of a build, as puffin-build names it (spec.rs build: the name of its directory and of its PUT, which mk_vendor
// list gives): the name of a preset with that build, else that of the build it starts from (the preset written, or the
// plainest preset of its version) followed by -<modifier>s where it differs from it, then its catalogue part
// (only-<IDs>, fix-<IDs>, fix-all; a fix- that gives a preset's build is that preset); a preset followed by -<modifier>s
// (the form of slugs) keeps them, nothing implied; a bug alone (or only-<bug> alone) starts from its reference preset
// (the newest version with the bug, the fewest fixes, ASan, the shortest name). null when Parse finds a problem, the
// catalogue is not loaded, or the builds have no kinds (git_restapi's format 1). Checked against mk_vendor
// (scripts/tests/buildname_test.sh).
export function Slug(name, { presets = [], modifiers = {}, entries = null } = {}) {
  const parsed = Parse(name, { presets, modifiers, entries });
  if (parsed.problems.length || parsed.unchecked.length || !(presets ?? []).some(p => p.kind)) return null;
  const { names } = TomlPresets(presets);
  if (names.has(name)) return name;
  const order = [...INSTRUMENTATION, ...Object.keys(modifiers ?? {}).filter(m => !INSTRUMENTATION.includes(m)).sort()];
  const defaults = Object.fromEntries(Object.entries(modifiers ?? {}).map(([m, d]) => [m, !!d?.default]));
  const valueOf = (build, m) => (m in build ? !!build[m] : !!defaults[m]);
  const plainValue = m => (m === 'sancov' ? true : INSTRUMENTATION.includes(m) ? false : !!defaults[m]);
  const sortedFix = build => [...(build.fix ?? [])].sort().join('+');
  const same = (a, b) => a.version === b.version && sortedFix(a) === sortedFix(b) && order.every(m => valueOf(a, m) === valueOf(b, m));
  const byName = (a, b) => a.name.length - b.name.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const presetWith = build => [...names.values()].filter(p => same(p, build)).sort(byName)[0]?.name ?? null;
  // build_name: the preferred preset if it is that build, else another preset that is, else from's name and the modifiers
  // that differ from it
  const buildName = (build, prefer, from) => {
    if (names.has(prefer) && same(names.get(prefer), build)) return prefer;
    return presetWith(build)
        ?? [from.name, ...order.filter(m => valueOf(build, m) !== valueOf(from, m)).map(m => (valueOf(build, m) ? m : `no-${m}`))].join('-');
  };
  // plain_preset: of a version, without fixes: no ASan, the fewest options off their plain value, the shortest name
  const plainOf = version => [...names.values()].filter(p => p.version === version && !(p.fix ?? []).length)
      .map(p => ({ p, asan: valueOf(p, 'asan') ? 1 : 0, away: order.filter(m => m !== 'asan' && valueOf(p, m) !== plainValue(m)).length }))
      .sort((a, b) => a.asan - b.asan || a.away - b.away || byName(a.p, b.p))[0]?.p ?? null;
  const part = parsed.part ? { kind: parsed.part.kind, ids: [...parsed.part.bugs].sort() } : null;
  const text = select => (select.kind === 'fix-all' ? 'fix-all' : `${select.kind}-${select.ids.join('+')}`);
  // where it starts: the preset written, the bug's reference preset, or the plainest preset of the version written
  let start;
  if (parsed.reference) {
    const id = part?.ids[0], entry = entries?.[id];
    if (!entry?.affected) return null;
    if (entry.reference) start = names.get(entry.reference) ?? null;
    else {
      const withBug = [...names.values()].filter(p => !parseVersion(p.version).head
          && presentOn(id, entry, { ...defaults, ...p, fix: p.fix ?? [] }));
      start = withBug.sort((a, b) => compareVersions(b.version, a.version) || (a.fix ?? []).length - (b.fix ?? []).length
          || (valueOf(b, 'asan') ? 1 : 0) - (valueOf(a, 'asan') ? 1 : 0) || byName(a, b))[0] ?? null;
    }
  } else start = parsed.preset ? names.get(parsed.preset) : plainOf(parsed.version);
  if (!start) return null;
  const exact = !!parsed.preset && !name.includes(',');
  const flags = { ...(parsed.alone ? { asan: true } : {}), ...parsed.options };
  const info = { version: start.version, fix: [...(start.fix ?? [])], ...Object.fromEntries(order.map(m => [m, valueOf(start, m)])) };
  Object.assign(info, flags);
  if (flags.gcov === true) info.sancov = false;
  // what the bugs of only- need, unless said otherwise (a slug says everything)
  if (!exact && part?.kind === 'only') {
    for (const id of part.ids) {
      for (const [option, wanted] of Object.entries(entries?.[id]?.requires ?? {})) if (!(option in flags)) info[option] = wanted;
      if (entries?.[id] && needsAsan(entries[id]) && !('asan' in flags)) info.asan = true;
    }
  }
  if (exact) {
    const base = Object.keys(flags).length ? buildName(info, start.name, start) : start.name;
    return part ? `${base}-${text(part)}` : base;
  }
  // named from its version: the fixes of the preset it starts from join its catalogue part
  const startFixes = info.fix;
  info.fix = [];
  let select = part;
  if (select?.kind === 'fix') select = { kind: 'fix', ids: [...new Set([...select.ids, ...startFixes])].sort() };
  else if (!select && startFixes.length) select = { kind: 'fix', ids: [...startFixes].sort() };
  const plain = plainOf(info.version);
  if (!plain) return null;
  const base = buildName(info, start.name, plain);
  if (!select) return base;
  if (select.kind === 'fix') {
    const preset = presetWith({ ...info, fix: select.ids });
    if (preset) return preset;
  }
  return `${base}-${text(select)}`;
}
