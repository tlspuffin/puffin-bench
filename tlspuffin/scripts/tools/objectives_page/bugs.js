// The bugs of a task's objectives, shared by the objectives pages (report.js, next to them) and the Results page
// (publisher, which imports it from /html/objectives/bugs.js): a bug is what the fuzzer recorded when it saved the
// objectives (crash location or violated claim); objectives whose replay does not reproduce it count in it; another
// bug only when a replay confirms another trace. Input: the runs of a report JSON (objectives_report.sh,
// objectives_live.sh).

export const UNCONFIRMED = new Set(['no-crash', 'replay-error', 'not-replayed']);
export const TYPE_LABELS = { 'no-crash': 'not reproduced', 'replay-error': 'replay error', 'not-replayed': 'not replayed', 'security-violation': 'security violation',
  'crash': 'crash' };


// notTargeted ({claim: CVE}, report.not_targeted): VulnA/VulnB claims that are not the target of the job (a known CVE
// of the old library versions, found besides the targeted one): such a bug gets notTarget = its CVE and comes after
// the targeted bugs
// IsExpected(target, group): the group of objectives is the configuration's expected bug ({cve, kind, match} of
// vuln_targets.json): a crash with the frame among the top 3 of the fuzzer's backtrace or of the replay's stack, or the
// claim with that message (as PR_common.sh TargetMatches)
export function IsExpected(target, group) {
  if (!target) return false;
  const fz = group.fuzzer;
  const top = (frames) => (frames ?? []).slice(0, 3).some(f => String(f).includes(target.match));
  if (target.kind === 'claim') {
    return (fz?.kind === 'claim' && fz.detail === target.match)
        || (group.type === 'security-violation' && (group.frames ?? [])[0] === target.match);
  }
  return (fz?.kind === 'crash' && top(fz.frames))
      || (!['no-crash', 'replay-error', 'security-violation'].includes(group.type) && top(group.frames));
}

// how the scheduler ended a run, in words
const RUN_END = { TimedOut: 'ended by its timeout', Failed: 'failed', Cancelled: 'was cancelled' };

// RunFailures(lib): the runs of a configuration not counted as succeeded, with why ([{attempt, why}]), from its entry in
// the objectives report (libraries[]): the outcome of each run in the task's summary (outcomes: success only when the
// run ended normally and its summary saw what it looked for; null: no end-of-run summary), how the scheduler ended it
// (ends), the error its end-of-run script recorded (end_errors). [] for a report without outcomes (before 2026-10-09)
export function RunFailures(lib) {
  return Object.entries(lib?.outcomes ?? {}).filter(([, state]) => state !== 'success').map(([attempt, state]) => {
    const end = lib.ends?.[attempt], error = lib.end_errors?.[attempt];
    const ended = (end && end !== 'Done') ? (RUN_END[end] ?? `ended ${end}`) : null;
    const why = (state == null)
        ? `no end-of-run summary${ended ? ` (the run ${ended})` : error ? ` (${error})` : ' (no error recorded: the task\'s logs say why)'}`
        : ended ? `the run ${ended}` : 'its end-of-run summary counts it as failed';
    return { attempt: Number(attempt), why };
  }).sort((a, b) => a.attempt - b.attempt);
}

// ExpectedRuns(runs, targets, libraries): per configuration with a declared target (vuln_targets.json), its runs, those
// that found the expected bug (found), those of them a replay confirmed (reproduced), and those of them that succeeded
// (counted): the final count of Results and of the objectives report. A run that found the bug but did not succeed
// (ended by its timeout, no end-of-run summary) is not counted: it is not in the statistics of Results (time to find).
// Every run of the configuration is in runs, also those without objective (libraries[]: the task's steps); counted is
// found for a report without outcomes (written before 2026-10-09, or a live report of a running task)
export function ExpectedRuns(runs, targets = {}, libraries = []) {
  const out = {};
  const entry = (library) => out[library] ??= { target: targets[library], runs: new Set(), found: new Set(), reproduced: new Set() };
  for (const lib of libraries ?? []) {
    if (!targets?.[lib.library]) continue;
    // the runs the scheduler started (ends: a run still Pending never ran, e.g. in a cancelled task: not a run), else
    // those of the summary, else (a live report) every run of the configuration
    const attempts = lib.ends ? Object.entries(lib.ends).filter(([, end]) => end !== 'Pending').map(([a]) => Number(a))
        : lib.outcomes ? Object.keys(lib.outcomes).map(Number) : [...Array(Number(lib.runs) || 0).keys()];
    attempts.forEach(a => entry(lib.library).runs.add(a));
  }
  for (const run of runs) {
    const target = targets?.[run.library];
    if (!target) continue;
    const o = entry(run.library);
    o.runs.add(run.attempt);
    const expected = (run.groups ?? []).filter(g => IsExpected(target, g));
    if (expected.length) o.found.add(run.attempt);
    // reproduced: a replay confirmed it in this run (else the fuzzer's log is the only evidence)
    if (expected.some(g => !UNCONFIRMED.has(g.type))) o.reproduced.add(run.attempt);
  }
  for (const [library, o] of Object.entries(out)) {
    const lib = (libraries ?? []).find(l => l.library === library);
    CountRuns(o, lib?.outcomes);
    // job scripts without target (before 2026-10-07): their runs ended on any objective and succeeded with it; 🎯
    // counts only those whose objectives include the expected bug (the report records the target the scripts had)
    const script = Object.values(lib?.script ?? {});
    o.preTarget = script.length > 0 && script.every(s => !s?.cve);
  }
  return out;
}

// CountRuns(o, outcomes): the runs of a configuration (ExpectedRuns) counted with the outcome of each run in the task's
// summary ({attempt: 'success', 'fail', null}; Results has them from the summary it shows, the report from its file)
export function CountRuns(o, outcomes) {
  // without outcomes (a live report: runs not ended), the count is every run that found the bug, provisional
  o.provisional = !outcomes;
  o.counted = new Set([...o.found].filter(a => !outcomes || outcomes[a] === 'success'));
  // found by runs that did not succeed
  o.lost = [...o.found].filter(a => !o.counted.has(a)).sort((x, y) => x - y);
  o.level = ExpectedLevelOf(o.counted.size, o.runs.size);
  return o;
}

// ExpectedChipTip(library, o, marks): the hover of a 🎯 chip, the same on Results and on the objectives report: its
// target, then one line per mark of the chip as it is displayed (🎯 k/n, +k failed and each of those runs with why,
// · no replay, +k ⦸, ⚠ k). marks: { why(attempt): why a run is not counted, notReproduced, notTarget, unexpected, alias }
export function ExpectedChipTip(library, o, { why = () => null, notReproduced = 0, notTarget = 0, unexpected = 0, alias = '' } = {}) {
  const t = o.target;
  return [`🎯 ${library}: ${t.cve}${alias && alias !== library ? ` (${alias})` : ''}, expected ${t.kind === 'claim' ? `claim “${t.match}”` : `crash in ${t.match}`}`,
      `🎯 ${o.counted.size}/${o.runs.size}: runs that found it and succeeded / runs${o.provisional ? ' (provisional: runs not ended)' : ''}`,
      ...(o.preTarget ? ['before targets: the job scripts of this task had no expected bug (before 2026-10-07): a run '
          + 'ended on its first objective, whatever the bug, and succeeded with it; 🎯 counts the runs whose objectives '
          + 'include the expected bug'] : []),
      ...(o.lost.length ? [`+${o.lost.length} failed: found it too, not counted (the run did not succeed)`,
          ...o.lost.map(attempt => `run ${attempt}: ${why(attempt) ?? 'did not succeed'}`)] : []),
      notReproduced > 0 ? `· no replay: no replay reproduced it in ${notReproduced} of the ${o.found.size} runs that found it (the fuzzer's log is the evidence)` : '',
      notTarget ? `+${notTarget} ⦸: objectives of a known CVE set apart, not the target of this job` : '',
      unexpected ? `⚠ ${unexpected}: objectives of an unexpected bug, neither the target nor a CVE set apart` : '',
  ].filter(Boolean).join('\n');
}

// the colour of a 🎯 count: all (green) every run, partial (amber) not every run, none (red) no run
const ExpectedLevelOf = (counted, runs) => counted === 0 ? 'none' : counted < runs ? 'partial' : 'all';

// ExpectedConclusion(expectedRuns): the final 🎯 conclusion of a task, the same on Results and on the objectives report:
// configurations that found their bug, counted runs, runs, runs that found it without succeeding, and the level:
// all (green) every run of every configuration; partial (amber) every configuration in some runs; none (red) a
// configuration in no run; provisional: some runs without outcome yet (a live report). null without a target
export function ExpectedConclusion(expectedRuns) {
  const all = Object.values(expectedRuns ?? {});
  if (!all.length) return null;
  const sum = (f) => all.reduce((total, o) => total + f(o), 0);
  return { configurations: all.length, hit: all.filter(o => o.counted.size > 0).length,
           counted: sum(o => o.counted.size), runs: sum(o => o.runs.size), lost: sum(o => o.lost.length),
           provisional: all.some(o => o.provisional),
           level: all.some(o => o.level === 'none') ? 'none' : all.some(o => o.level === 'partial') ? 'partial' : 'all' };
}

// The function of a frame, to tell bugs apart: the simple C++ mangling "_Z<length><name>…" undone, the arguments
// dropped ("MemcmpInterceptorCommon(void*," and "_Z23MemcmpInterceptorCommonPvPFi…" are the same function)
export function FrameName(frame) {
  let name = String(frame ?? '').trim();
  const mangled = /^_Z(\d+)(.*)$/.exec(name);
  if (mangled) name = mangled[2].slice(0, Number(mangled[1]));
  // the arguments after a function name ("MemcmpInterceptorCommon(void*,"), not a leading "<(Head,Tail) as …>"
  return name.replace(/([\w>])\(.*$/, '$1').trim();
}
// frames of the sanitizer runtime and of the libc memory and string functions it intercepts: never the location of a bug
// and the fuzzer's own frames (its harness, LibAFL, the Rust runtime): a crash whose backtrace has nothing else (e.g. the
// harness aborting on a security claim violation it does not log, tlspuffin before ac3b89aff) has no location
const RUNTIME_FRAME = /Interceptor|^__interceptor_|^___interceptor_|^__asan|^__sanitizer|^__ubsan|^(memcmp|bcmp|memcpy|memmove|memset|memchr|strcmp|strncmp|strlen|strnlen|strcpy|strncpy|strcat|strchr|strstr)$|^puffin::fuzzer::|^<?libafl|^<?(std|core|alloc)::|^<\(Head,Tail\)|^<ST as libafl/;

// a crash of the harness itself: std::process::abort from puffin's harness (a claim violation the fuzzer does not log)
export function HarnessAbort(frames) {
  return String((frames ?? [])[0] ?? '').startsWith('puffin::fuzzer::harness');
}
// the frames of a backtrace that locate a bug: normalized, without the runtime ones
export function LocationFrames(frames) {
  return (frames ?? []).map(FrameName).filter(name => name && !RUNTIME_FRAME.test(name));
}

// What a run built, from its record (cli): the build text ("C harness, wolfssl540-buf"), else the Rust harness's library,
// else the vendor preset: { library: 'wolfssl', version: 540 }, null when unknown
export function BuiltOf(run) {
  const cli = run?.cli ?? {};
  const text = cli.build || (cli.cputs === false && cli.library?.name ? `${cli.library.name}${cli.library.version ?? ''}` : cli.vendor) || '';
  const m = /([a-z]+)(\d{3,})/.exec(String(text));
  return m ? { library: m[1], version: Number(m[2]) } : null;
}

// The CVE of a claim set apart for a run (vuln_targets.json _not_targeted: {cve, library, below}): only on that library
// below that version (CVE-2024-5814: wolfSSL < 5.7.2); elsewhere the claim is a bug (null). An entry as a plain CVE (reports
// written before the scope existed) applies everywhere.
export function SetApart(entry, run) {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  if (!entry.library) return entry.cve;
  const built = BuiltOf(run);
  if (!built || built.library !== entry.library) return null;
  return built.version < Number(String(entry.below ?? '').replace(/\./g, '')) ? entry.cve : null;
}

export function Bugs(runs, notTargeted = {}, targets = {}) {
  // A bug is what the fuzzer recorded when it saved the objectives (crash location, or violated claim): objectives
  // whose replay does not reproduce it still belong to it. Only a replay that confirms another bug trace (another top
  // frame, another claim) makes another bug. Without a fuzzer record, the replay's signature identifies the bug.
  const bugs = new Map();
  for (const run of runs) {
    for (const group of run.groups ?? []) {
      const fz = group.fuzzer;
      const rFrames = group.frames ?? [];
      const confirmed = !UNCONFIRMED.has(group.type);
      // a fuzzer record by the first frame that locates it (its backtraces vary in depth and in mangling)
      const fzTop = fz?.kind === 'crash' ? LocationFrames(fz.frames)[0] : undefined;
      const fzKey = fz ? (fz.kind === 'crash' ? `crash|${fzTop || run.library}` : `claim|${fz.detail}`) : '';
      const same = fz && (!confirmed || group.type === 'crash'
          || (fz.kind === 'crash' && rFrames.length && fzTop && LocationFrames(rFrames)[0] === fzTop)
          || (fz.kind === 'claim' && group.type === 'security-violation' && rFrames.join(' < ') === fz.detail));
      // a claim set apart (CVE-2024-5814) only where its scope says: the same claim elsewhere is another bug, a real one
      const claimOf = fz?.kind === 'claim' ? fz.detail : (group.type === 'security-violation' ? rFrames[0] : null);
      const apart = claimOf && notTargeted?.[claimOf] ? SetApart(notTargeted[claimOf], run) : null;
      const scope = claimOf && notTargeted?.[claimOf] ? (apart ? '|apart' : '|flagged') : '';
      // the harness aborting on a claim (tlspuffin before ac3b89aff logs the claim, then aborts): the fuzzer may have
      // recorded the abort instead of the claim, which the replay confirms: the claim's bug, as when it recorded the claim
      const abortOfClaim = fz?.kind === 'crash' && HarnessAbort(fz.frames) && group.type === 'security-violation';
      const key = (same ? fzKey
          : abortOfClaim ? `claim|${rFrames.join(' < ')}`
          : confirmed ? ((group.type === 'crash' && !rFrames.length) ? `crash|${run.library}` : `${group.type}|${rFrames.join(' < ')}`)
          : `${group.type}|replay-only`) + scope;
      let bug = bugs.get(key);
      if (!bug) {
        bug = { key, count: 0, reproduced: 0, runs: new Map(), types: new Map(), frames: [], summary: '', excerpt: '',
          first_trace: '', library: run.library, run, fuzzer: same ? fz : null, reasons: new Map(), tries: new Map(),
          replayType: group.type, traces: [] };
        bugs.set(key, bug);
      }
      if (apart) bug.apartCve = apart;
      const n = group.count ?? 0;
      bug.count += n;
      // the expected bug of this configuration (targets: vuln_targets.json); targets declared: every library the bug
      // was found in has one, then a bug that is none of them is unexpected
      if (targets?.[run.library]) {
        bug.declared = (bug.declared ?? true);
        if (IsExpected(targets[run.library], group)) (bug.expectedFor ??= new Set()).add(run.library);
      } else {
        bug.declared = false;
      }
      // its objectives kept next to the report page (objectives_report.sh: <task>-traces/<library>/<run>/)
      if (run.traces_dir) {
        for (const name of group.traces ?? []) {
          bug.traces.push({ library: run.library, attempt: run.attempt, name, url: `${run.traces_dir}/${name}.trace` });
        }
      }
      if (confirmed) {
        bug.reproduced += n;
        bug.types.set(group.type, (bug.types.get(group.type) ?? 0) + n);
        // the report of a confirming replay is the best excerpt, its stack the best frames
        if (!bug.confirmedExcerpt) {
          bug.confirmedExcerpt = true;
          Object.assign(bug, { excerpt: group.excerpt ?? '', first_trace: group.first_trace ?? '', library: run.library, run });
          if (rFrames.length) { bug.frames = rFrames; bug.summary = group.summary ?? ''; }
          else if (!bug.summary) bug.summary = group.summary ?? '';
        }
      } else if (!bug.excerpt) {
        Object.assign(bug, { excerpt: group.excerpt ?? '', first_trace: group.first_trace ?? '', library: run.library, run,
          summary: group.summary ?? '' });
      }
      if (same && !bug.fuzzer?.excerpt && fz?.excerpt) bug.fuzzer = fz;
      const r = bug.runs.get(`${run.library}|${run.attempt}`) ?? { library: run.library, attempt: run.attempt, count: 0, reproduced: 0, cli: run.cli };
      r.count += n; if (confirmed) r.reproduced += n;
      bug.runs.set(`${run.library}|${run.attempt}`, r);
      for (const x of group.replay_reasons ?? []) bug.reasons.set(x.reason || '', (bug.reasons.get(x.reason || '') ?? 0) + x.count);
      for (const t of group.tries ?? []) bug.tries.set(t.tries, (bug.tries.get(t.tries) ?? 0) + t.count);
    }
  }
  for (const bug of bugs.values()) {
    bug.runs = [...bug.runs.values()];
    bug.notReproduced = bug.count - bug.reproduced;
    // the most precise type: the replay's sanitizer/claim/panic signature, else what the fuzzer saw
    const precise = [...bug.types.keys()].find(t => t !== 'crash');
    bug.type = precise ?? (bug.reproduced ? 'crash' : bug.fuzzer ? (bug.fuzzer.kind === 'crash' ? 'crash' : 'security-violation')
        : bug.replayType);
    if (!bug.frames.length && bug.fuzzer) {
      bug.frames = bug.fuzzer.kind === 'crash' ? (bug.fuzzer.frames ?? []) : [bug.fuzzer.detail];
      bug.framesFromFuzzer = bug.fuzzer.kind === 'crash';
    }
  }
  for (const bug of bugs.values()) {
    const claim = bug.fuzzer?.kind === 'claim' ? bug.fuzzer.detail : (bug.type === 'security-violation' ? bug.frames[0] : null);
    bug.notTarget = bug.apartCve ?? null;
    bug.expected = bug.expectedFor ? [...bug.expectedFor].map(lib => targets[lib].cve).filter((c, i, a) => a.indexOf(c) === i) : null;
    bug.unexpected = !bug.notTarget && !bug.expected && bug.declared === true;
  }
  return [...bugs.values()].sort((a, b) => (!!a.notTarget - !!b.notTarget) || (b.count - a.count));
}

export function FuzzerText(fz) {
  if (!fz) return '';
  return fz.kind === 'crash' ? `crash (${fz.detail})${fz.frames?.length ? ' in ' + fz.frames.join(' < ') : ''}`
      : `claim violated: ${fz.detail}`;
}

// the fuzzer saw a crash or a claim violation, but no replay confirms it
export const Mismatch = (bug) => bug.reproduced === 0 && !!bug.fuzzer;
// a bug some of whose objectives were reproduced by their replay, and others not
export const Partly = (bug) => bug.reproduced > 0 && bug.notReproduced > 0;

// Bug A, B, … Z, AA, AB…: in the order of the list, to refer to them from the configurations table
export function Letter(i) {
  return i < 26 ? String.fromCharCode(65 + i) : Letter(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26));
}

// BugSignature(bug): what identifies a bug across tasks, whatever gave it (the fuzzer's record or a replay, ASan type or
// not): the claim message, or the top function of the crash; null for a crash without location (it cannot be told
// apart: it counts as uncategorised, never as a new bug)
export function BugSignature(bug) {
  const claim = bug.fuzzer?.kind === 'claim' ? bug.fuzzer.detail : (bug.type === 'security-violation' ? bug.frames?.[0] : null);
  if (claim) return `claim|${claim}`;
  const top = LocationFrames(bug.frames)[0];
  return top ? `crash|${top}` : null;
}

// KnownCve(bug, run, cves): the CVE tlspuffin declares for what the run built (cli.vulnerabilities.declared, from the
// build's vendorinfo.sh) whose signature (cves: {CVE: {kind, match}}, cve_signatures.jq) the bug matches; null when
// none; undefined when the run has no declaration (built before puffin-build, Rust harness, older job scripts)
export function KnownCve(bug, run, cves) {
  const declared = run?.cli?.vulnerabilities?.declared;
  if (!Array.isArray(declared)) return undefined;
  const group = { fuzzer: bug.fuzzer, type: [...(bug.types?.keys() ?? [])][0] ?? bug.replayType, frames: bug.frames };
  return declared.find(cve => cves?.[cve] && IsExpected(cves[cve], group)) ?? null;
}

// NewBugs(bugs, known, task, report): the bugs flagged 🚨 new, per configuration (bug.runs: their library), for a real
// bug (recorded by the fuzzer or confirmed by a replay) that is neither the expected bug of its configuration nor a
// known CVE set apart:
//  - a configuration with an expected bug (an alias such as BUF, SKIP: report.targets): new when no earlier task had
//    its signature in that configuration (known_bugs.json: "<configuration>|<signature>" -> the first task with it,
//    tools/known_bugs.js);
//  - a plain version (no target, e.g. Perf "WolfSSL" built as wolfssl580): not new when it is a CVE tlspuffin declares
//    for that build (KnownCve: bug.knownCve = the CVE), else new, also when earlier tasks had it (it stays flagged
//    until it is added to the CVE list of vuln_targets.json); a run without declaration: as an alias.
// Marks bug.isNew = [configurations]; returns the new bugs.
export function NewBugs(bugs, known, task, report = null) {
  const out = [];
  for (const bug of bugs) {
    if (bug.notTarget || bug.expected || !(bug.reproduced > 0 || bug.fuzzer)) continue;
    const sig = BugSignature(bug);
    if (!sig) continue;
    const libs = [];
    for (const lib of new Set(bug.runs.map(run => run.library))) {
      const run = bug.runs.find(r => r.library === lib);
      const plain = !report?.targets?.[lib];
      const cve = plain ? KnownCve(bug, run, report?.cves) : undefined;
      if (cve) { (bug.knownCve ??= {})[lib] = cve; continue; }
      if (plain && cve === null) { libs.push(lib); continue; }
      if (!known) continue;
      const first = known[`${lib}|${sig}`];
      if (!first || String(first.task) === String(task)) libs.push(lib);
    }
    if (libs.length) { bug.isNew = libs; out.push(bug); }
  }
  return out;
}

// Uncategorised(runs): the objectives whose bug cannot be told, per configuration, with why: no replay confirmed it
// and the fuzzer's log has no record of it (no log in the artefacts, or no record: log rotated, nothing logged), a
// crash without location (a bug, but it cannot be compared with other tasks: never 🚨 new), or not in the report at
// all (written before every objective was classified; on a live page: not processed yet). { total, libs: { library: { count, reasons: { why: n } } } }
export function Uncategorised(runs, live = false) {
  // pending: on a live page, the objectives not replayed yet (waiting resolves them), apart from the others
  const out = { total: 0, libs: {}, pending: 0, pendingLibs: {} };
  const add = (library, why, n, pending = false) => {
    if (!(n > 0)) return;
    const lib = (pending ? out.pendingLibs : out.libs)[library] ??= { count: 0, reasons: {} };
    lib.count += n;
    lib.reasons[why] = (lib.reasons[why] ?? 0) + n;
    if (pending) out.pending += n; else out.total += n;
  };
  for (const run of runs ?? []) {
    const logs = run.fuzzer_logs;
    let grouped = 0;
    for (const group of run.groups ?? []) {
      grouped += group.count ?? 0;
      if (UNCONFIRMED.has(group.type) && group.fuzzer && HarnessAbort(group.fuzzer.frames)) {
        // recorded by the fuzzer as an abort of its harness, not confirmed by a replay: which claim is unknown
        add(run.library, 'the harness aborted: a security claim violation this fuzzer does not log (its replay tells which claim)', group.count, live && group.type === 'not-replayed');
      } else if (live && group.type === 'not-replayed' && !group.fuzzer) {
        // a live page: not replayed yet and no record yet; waiting resolves it
        add(run.library, 'not replayed yet, no record of the fuzzer yet: the final report classifies every objective', group.count, true);
      } else if (UNCONFIRMED.has(group.type) && !group.fuzzer) {
        const what = group.type === 'not-replayed' ? 'not replayed' : group.type === 'replay-error' ? 'replay failed' : 'not reproduced by its replay';
        const why = !logs ? 'no record of the fuzzer (report written before its logs were counted)'
            : logs.files === 0 ? 'no fuzzer log in the artefacts'
            : 'no record in the fuzzer\'s logs (rotated, or nothing logged)';
        add(run.library, `${what}, ${why}`, group.count);
      } else if (!UNCONFIRMED.has(group.type) && group.type !== 'security-violation' && !(group.frames ?? []).length
                 && !(group.fuzzer?.frames ?? []).length && group.fuzzer?.kind !== 'claim') {
        add(run.library, HarnessAbort(group.fuzzer?.frames ?? group.frames)
            ? 'the harness aborted: a security claim violation this fuzzer does not log (its replay tells which claim)'
            : 'crash without location (no frame): a bug, but it cannot be compared with other tasks', group.count);
      }
    }
    if ((run.found ?? 0) > grouped) {
      add(run.library, live
          ? 'not processed yet: the live page replays a few per round, up to 100 per run; the final report, written when the task ends, classifies every objective'
          : 'not in this report: written before every objective was classified (the cron job rewrites it)', run.found - grouped, live);
    }
  }
  return out;
}

// the text of the click window: per configuration, its count and reasons
export function UncategorisedText(entry, library = null, pending = false) {
  const all = pending ? entry.pendingLibs : entry.libs;
  const libs = library ? (all[library] ? { [library]: all[library] } : {}) : all;
  if (pending) {
    const total = Object.values(libs).reduce((s, l) => s + l.count, 0);
    return [`${total.toLocaleString('en-US')} objective(s) not processed yet`, ...Object.entries(libs).map(([lib, l]) => `${lib}: ${l.count.toLocaleString('en-US')}`),
      '', 'The live page replays a few per round, up to 100 per run; the final report, written when the task ends, classifies every objective. Waiting resolves them.'].join('\n');
  }
  const total = Object.values(libs).reduce((s, l) => s + l.count, 0);
  return [`${total.toLocaleString('en-US')} objective(s) without category`, ...Object.entries(libs).flatMap(([lib, l]) =>
    [`${lib}: ${l.count.toLocaleString('en-US')}`, ...Object.entries(l.reasons).map(([why, n]) => `- ${n.toLocaleString('en-US')}: ${why}`)]),
    '', 'They could hide a bug: nothing (no replay, no fuzzer record) says what they are, or, without location, they cannot be compared with other tasks.'].join('\n');
}

// The name of a bug, from the CVE table of the bugs reference (vuln_targets.json _cves: CVE → alias): the alias of its
// CVE when it is the expected bug of its configuration (BUF, CDOS…), a known CVE set apart, or a CVE declared for the
// build of a plain version (bug.knownCve, NewBugs) (its CVE id when the
// table has no alias), else "Bug A", "Bug B"…; ShortName: the same without "Bug " (the badges). Anchors keep the letter.
export function BugName(bug, cves = null) {
  const cvesOf = bug.expected?.length ? bug.expected : bug.notTarget ? [bug.notTarget]
      : bug.knownCve ? [...new Set(Object.values(bug.knownCve))] : [];
  if (cvesOf.length) return cvesOf.map(cve => cves?.[cve]?.alias ?? cve).join(' / ');
  return `Bug ${bug.letter}`;
}
export function ShortName(bug, cves = null) {
  const name = BugName(bug, cves);
  return name === `Bug ${bug.letter}` ? bug.letter : name.replace(/ \/ /g, '/');
}

// the CVE table of the bugs reference (vuln_targets.json _cves), null when it cannot be read; read once per page
let cvesLoading = null;
export function LoadCves() {
  cvesLoading ??= fetch('/html/jobsscripts/tlspuffin/vuln_targets.json', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null).then(json => json?._cves ?? null).catch(() => null);
  return cvesLoading;
}
