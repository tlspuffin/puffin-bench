// The bugs of a task's objectives, shared by the objectives pages (report.js, next to them) and the Results page
// (publisher, which imports it from /html/objectives/bugs.js): a bug is what the fuzzer recorded when it saved the
// objectives (crash location or violated claim); objectives whose replay does not reproduce it count in it; another
// bug only when a replay confirms another trace. Input: the runs of a report JSON (objectives_report.sh,
// objectives_live.sh). The words of the verdicts: ../common/verdicts.js (the pages' common folder; in the tools'
// tree, tools/common links to it, for QuickJS).

import { VerdictKind, VERDICT_ORDER, SignatureText, LEVELS } from '../common/verdicts.js';
import { FrameName, RUNTIME_FRAME, PlaceOf, HasPlace } from '../common/signatures.js';
import { inRange } from '../common/catalogue.js';
export { FrameName };

export const UNCONFIRMED = new Set(['no-crash', 'replay-error', 'not-replayed']);
export const TYPE_LABELS = { 'no-crash': 'not reproduced', 'replay-error': 'replay error', 'not-replayed': 'not replayed', 'security-violation': 'security violation',
  'crash': 'crash' };


// notTargeted ({claim: CVE}, report.not_targeted): VulnA/VulnB claims that are not the target of the job (a known CVE
// of the old library versions, found besides the targeted one): such a bug gets notTarget = its CVE and comes after
// the targeted bugs
// IsExpected(target, group, verdictOf): the group of objectives is the configuration's expected bug ({cve, kind, place or
// match} of vuln_targets.json): a crash whose stack, the fuzzer's backtrace or the replay's, has the target's place
// (../common/signatures.js HasPlace, the one rule: the job scripts ask it too, PR_common.sh TargetMatches through
// tools/js/has_place.js), or the claim with that message. A custom benchmark's target (CustomTargets: { cve, oracle,
// custom }): validation decides when it named a bug for one of the group's objectives (verdictOf(trace): its verdict),
// else its signature (OracleMatchesGroup), until validation says
export function IsExpected(target, group, verdictOf = null) {
  if (!target) return false;
  if (target.custom) {
    const verdicts = (group.traces ?? []).map(trace => verdictOf?.(trace)).filter(Boolean);
    if (verdicts.some(v => (v.entries ?? []).includes(target.cve) || (v.known_unpatched ?? []).includes(target.cve))) return true;
    if (verdicts.some(v => ['confirmed', 'not-patched', 'other-signature'].includes(v.verdict))) return false;
    return OracleMatchesGroup(target.oracle, group);
  }
  const fz = group.fuzzer;
  if (target.kind === 'claim') {
    return (fz?.kind === 'claim' && fz.detail === target.match)
        || (group.type === 'security-violation' && (group.frames ?? [])[0] === target.match);
  }
  return (fz?.kind === 'crash' && HasPlace(target.place, fz.frames))
      || (!['no-crash', 'replay-error', 'security-violation'].includes(group.type) && HasPlace(target.place, group.frames));
}

// the signal of a crash with an ASan report of that type, when the fuzzer records only the signal (LibAFL replaces
// ASan's handler of SEGV, BUS, FPE, ILL: as PR_common.sh OracleMatches)
const ASAN_SIGNAL = { SEGV: 'SIGSEGV', BUS: 'SIGBUS', FPE: 'SIGFPE', ILL: 'SIGILL' };
// OracleMatchesGroup(oracle, group): a group of objectives has a catalogue signature, by its replay or the fuzzer's
// record: the claim; a crash with the ASan report type (or its signal) and the signal; a panic
function OracleMatchesGroup(oracle, group) {
  if (!oracle) return false;
  const fz = group.fuzzer;
  if (oracle.kind === 'claim') {
    return (fz?.kind === 'claim' && fz.detail === oracle.violation)
        || (group.type === 'security-violation' && (group.frames ?? [])[0] === oracle.violation);
  }
  if (oracle.kind === 'panic') return group.type === 'panic';
  if (oracle.kind !== 'crash') return false;
  const detail = fz?.kind === 'crash' ? String(fz.detail ?? '') : '';
  const asanOk = !oracle.asan || group.type === oracle.asan || detail.includes(`ASan ${oracle.asan}`)
      || (!detail.includes('ASan ') && !!ASAN_SIGNAL[oracle.asan] && detail.includes(ASAN_SIGNAL[oracle.asan]));
  const signalOk = !oracle.signal || detail.includes(oracle.signal);
  return asanOk && signalOk && (fz?.kind === 'crash' || !['no-crash', 'replay-error', 'security-violation', 'panic'].includes(group.type));
}

// CustomTargets(runs): the targets of a custom benchmark's experiments (their runs' cli.custom: the catalogue's bug and
// its signature), as targets of their configuration: { library: { cve, kind, oracle, custom: true } }
function CustomTargets(runs) {
  const out = {};
  for (const run of runs ?? []) {
    const c = run.cli?.custom;
    if (c?.target && !out[run.library]) out[run.library] = { cve: c.target, kind: c.oracle?.kind ?? null, oracle: c.oracle ?? null, custom: true };
  }
  return out;
}
// ReportTargets(report): the expected bug of each configuration of a report: vuln_targets.json's (report.targets) and
// those of a custom benchmark's experiments
function ReportTargets(report) {
  return { ...(report?.targets ?? {}), ...CustomTargets(report?.runs) };
}
// TargetText(target): how a configuration's expected bug is recognised, in words
export function TargetText(t) {
  if (t?.custom) return `${SignatureText(t.oracle)} (its signature), validation deciding`;
  return t?.kind === 'claim' ? `the claim “${t.match}”` : `a crash whose stack has its place, ${(t?.place ?? []).join(' < ')}`;
}
// VerdictOf(libraries, library, attempt): the validation verdict of an objective of that run, by its trace name
export function VerdictOf(libraries, library, attempt) {
  const byTrace = (libraries ?? []).find(l => l.library === library)?.validation?.byTrace;
  return byTrace ? (trace) => byTrace[`${attempt}/${trace}`] : null;
}

// how the scheduler ended a run, in words
const RUN_END = { TimedOut: 'ended by its timeout', Failed: 'failed', Cancelled: 'was cancelled' };

// RunFailures(lib, jobType): the runs of a configuration that did not succeed, with why ([{attempt, why}]), from its
// entry in the objectives report (libraries[]): the outcome of each run in the task's summary (outcomes: success only
// when the run ended as its job expects and its summary saw what it looked for; null: no end-of-run summary), how the
// scheduler ended it (ends), the error its end-of-run script recorded (end_errors), what its job scripts saw (script).
// A Perf run succeeds when it reaches its timeout. [] for a report without outcomes (before 2026-10-09).
// expectedTimeout: a run of a job that ends on a find (Vuln) that reached its timeout with its end-of-run summary: it
// did not find its bug within its time, an outcome of the campaign, not a failure of the bench
export function RunFailures(lib, jobType) {
  return Object.entries(lib?.outcomes ?? {}).filter(([, state]) => state !== 'success').map(([attempt, state]) => {
    const end = lib.ends?.[attempt], error = lib.end_errors?.[attempt];
    const ended = (end && end !== 'Done') ? (RUN_END[end] ?? `ended ${end}`) : null;
    const script = lib.script?.[attempt];
    const why = (state == null)
        ? `no end-of-run summary${ended ? ` (the run ${ended})` : error ? ` (${error})` : ' (no error recorded: the task\'s logs say why)'}`
        : jobType === 'perf' ? (end === 'Done' ? 'it ended before its timeout' : ended ? `the run ${ended}` : 'its end-of-run summary says it failed')
        : ended ? `the run ${ended}`
        : script?.cve ? 'it ended normally, but its job scripts did not see the expected bug'
        : script ? 'it ended normally, but its job scripts saw no objective'
        : 'it ended normally, but its end-of-run summary says it failed';
    return { attempt: Number(attempt), why, expectedTimeout: state != null && jobType !== 'perf' && end === 'TimedOut' };
  }).sort((a, b) => a.attempt - b.attempt);
}

// ExpectedRuns(runs, targets, libraries): per configuration with a declared target (vuln_targets.json), its runs, those
// that found the expected bug (found), those of them a replay confirmed (reproduced), and the count (counted, see
// CountRuns): the final count of Results and of the objectives report. Every run of the configuration is in runs, also
// those without objective (libraries[]: the task's steps)
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
    const verdictOf = VerdictOf(libraries, run.library, run.attempt);
    const expected = (run.groups ?? []).filter(g => IsExpected(target, g, verdictOf));
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
// summary ({attempt: 'success', 'fail', null}; Results has them from the summary it shows, the report from its file).
// Every run that found the expected bug is counted, also when it did not end normally (ended by its timeout, no
// end-of-run summary: the fuzzer saved the bug before); those (untimed) have no time to find in the statistics of
// Results, which come from the end-of-run summaries
export function CountRuns(o, outcomes) {
  // without outcomes (a live report: runs not ended), provisional
  o.provisional = !outcomes;
  o.counted = new Set(o.found);
  // found by runs that did not succeed: counted, without a time to find
  o.untimed = outcomes ? [...o.found].filter(a => outcomes[a] !== 'success').sort((x, y) => x - y) : [];
  o.level = ExpectedLevelOf(o.counted.size, o.runs.size);
  return o;
}

// ExpectedChipTip(library, o, marks): the hover of a 🎯 chip, the same on Results and on the objectives report: its
// target, then one line per mark of the chip as it is displayed (🎯 k/n, · k untimed and each of those runs with why,
// · no replay, +k ⦸, ⚠ k). marks: { why(attempt): why a run did not succeed, notReproduced, notTarget, unexpected, alias }
export function ExpectedChipTip(library, o, { why = () => null, notReproduced = 0, notTarget = 0, unexpected = 0, alias = '', noReplay = false } = {}) {
  const t = o.target;
  return [`🎯 ${library}: ${t.cve}${alias && alias !== library ? ` (${alias})` : ''}, expected ${TargetText(t)}`,
      `🎯 ${o.counted.size}/${o.runs.size}: runs that found it / runs${o.provisional ? ' (provisional: runs not ended)' : ''}`,
      ...(o.preTarget ? ['before targets: the job scripts of this task had no expected bug (before 2026-10-07): a run '
          + 'ended on its first objective, whatever the bug, and succeeded with it; 🎯 counts the runs whose objectives '
          + 'include the expected bug'] : []),
      ...(o.untimed.length ? [`· ${o.untimed.length} untimed: found it, counted, but the run did not end normally: no time to find in the statistics of Results`,
          ...o.untimed.map(attempt => `run ${attempt}: ${why(attempt) ?? 'did not succeed'}`)] : []),
      noReplay ? `◌ its objectives do not replay on their own, as the catalogue says (replayable = false): the fuzzer's log is the evidence, as expected`
        : notReproduced > 0 ? `· no replay: no replay reproduced it in ${notReproduced} of the ${o.found.size} runs that found it (the fuzzer's log is the evidence)` : '',
      notTarget ? `+${notTarget} ⦸: objectives of a known CVE set apart, not the target of this job` : '',
      unexpected ? `⚠ ${unexpected}: objectives of an unexpected bug, neither the target nor a CVE set apart` : '',
  ].filter(Boolean).join('\n');
}

// the colour of a 🎯 count: all (green) every run, partial (amber) not every run, none (red) no run
const ExpectedLevelOf = (counted, runs) => counted === 0 ? 'none' : counted < runs ? 'partial' : 'all';

// ExpectedConclusion(expectedRuns): the final 🎯 conclusion of a task, the same on Results and on the objectives report:
// configurations that found their bug, counted runs, runs, counted runs without a time to find, and the level:
// all (green) every run of every configuration; partial (amber) every configuration in some runs; none (red) a
// configuration in no run; provisional: some runs without outcome yet (a live report). null without a target
export function ExpectedConclusion(expectedRuns) {
  const all = Object.values(expectedRuns ?? {});
  if (!all.length) return null;
  const sum = (f) => all.reduce((total, o) => total + f(o), 0);
  return { configurations: all.length, hit: all.filter(o => o.counted.size > 0).length,
           counted: sum(o => o.counted.size), runs: sum(o => o.runs.size), untimed: sum(o => o.untimed.length),
           provisional: all.some(o => o.provisional),
           level: all.some(o => o.level === 'none') ? 'none' : all.some(o => o.level === 'partial') ? 'partial' : 'all' };
}

// FrameName and RUNTIME_FRAME: ../common/signatures.js (one definition with the signatures of the bugs)

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

export function Bugs(runs, notTargeted = {}, targets = {}, libraries = [], jobType = '') {
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
      // a claim set apart (CVE-2024-5814) only where its scope says: the same claim elsewhere is another bug, a real one;
      // and only in a run that looks for a target, as the job scripts set it apart from what the run looks for
      // (PR_common.sh ObjectiveTargeted): a Vuln job, or a configuration with a target (a Vuln flow launched as another
      // job); elsewhere (Perf, campaigns) it is a known CVE of its build like the others (📋). Never in the experiment that
      // looks for that very bug (a custom benchmark of CVE-2024-5814): there it is the target
      const claimOf = fz?.kind === 'claim' ? fz.detail : (group.type === 'security-violation' ? rFrames[0] : null);
      const looksForTarget = /^vuln-/.test(String(jobType ?? '')) || !!targets?.[run.library];
      const apartCve = looksForTarget && claimOf && notTargeted?.[claimOf] ? SetApart(notTargeted[claimOf], run) : null;
      const apart = apartCve && apartCve !== targets?.[run.library]?.cve ? apartCve : null;
      const scope = looksForTarget && claimOf && notTargeted?.[claimOf] ? (apart ? '|apart' : '|flagged') : '';
      // the harness aborting on a claim (tlspuffin before ac3b89aff logs the claim, then aborts): the fuzzer may have
      // recorded the abort instead of the claim, which the replay confirms: the claim's bug, as when it recorded the claim
      const abortOfClaim = fz?.kind === 'crash' && HarnessAbort(fz.frames) && group.type === 'security-violation';
      // a replay without the fuzzer's record of its objective: a crash by the first frame that locates it too, so that
      // it is the bug the fuzzer recorded at that place (as known_bugs.json: BugSignature), not another one
      const rTop = !['security-violation', 'panic'].includes(group.type) ? LocationFrames(rFrames)[0] : undefined;
      const key = (same ? fzKey
          : abortOfClaim ? `claim|${rFrames.join(' < ')}`
          : confirmed ? ((group.type === 'crash' && !rFrames.length) ? `crash|${run.library}`
                         : rTop ? `crash|${rTop}` : `${group.type}|${rFrames.join(' < ')}`)
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
        if (IsExpected(targets[run.library], group, VerdictOf(libraries, run.library, run.attempt))) (bug.expectedFor ??= new Set()).add(run.library);
      } else {
        bug.declared = false;
      }
      // its objectives, by run and trace (the validation's verdicts are by "<attempt>/<trace>")
      for (const name of group.traces ?? []) (bug.objectives ??= []).push({ library: run.library, attempt: run.attempt, name });
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

// InferredCve(bug, run, cves): for a run whose build declared no CVEs (built before puffin-build), the CVE of the
// library it built (cves[cve].library, vuln_targets.json _cves) whose signature the bug matches (IsExpected: a crash at
// its place, in order, so that BUF's crash in RefineSuites, called by SDOS2's DoTls13ClientHello, is not SDOS2); null
// when none; undefined when the run does not say which library it built
export function InferredCve(bug, run, cves) {
  const library = run?.cli?.library?.name;
  if (!library) return undefined;
  const group = { fuzzer: bug.fuzzer, type: [...(bug.types?.keys() ?? [])][0] ?? bug.replayType, frames: bug.frames };
  return Object.entries(cves ?? {}).find(([, c]) => String(c.library ?? '').toLowerCase() === String(library).toLowerCase()
      && IsExpected(c, group))?.[0] ?? null;
}

// NewBugs(bugs, known, task, report): the bugs flagged 🚨 new, per configuration (bug.runs: their library), for a real
// bug (recorded by the fuzzer or reproduced by a replay) that is neither the expected bug of its configuration nor a
// known CVE set apart:
//  - a configuration with an expected bug (an alias such as BUF, SKIP: report.targets; a custom benchmark's experiment:
//    ReportTargets): new when no earlier task had
//    its signature in that configuration (known_bugs.json: "<configuration>|<signature>" -> the first task with it,
//    tools/known_bugs.js);
//  - a plain version (no target, e.g. Perf "WolfSSL" built as wolfssl580): not new when it is a CVE tlspuffin declares
//    for that build (KnownCve: bug.knownCve = the CVE), else new, also when earlier tasks had it (it stays flagged
//    until it is added to the CVE list of vuln_targets.json); a run without declaration: a CVE of the library it built
//    (InferredCve: bug.knownCve = the CVE, bug.knownCveInferred), else as an alias.
// Validation first, when it gave the bug a verdict (bug.validation, BugValidation): a bug it names by patch or by a
// signature that is not weak is known (KnownByValidation); one with the signature of no known bug on the build with
// every patch is new in each of its configurations; a weak signature (any crash of an ASan type) decides nothing, the
// rules above do.
// Marks bug.isNew = [configurations]; returns the new bugs.
export function NewBugs(bugs, known, task, report = null) {
  const out = [];
  const targets = ReportTargets(report);
  for (const bug of bugs) {
    if (bug.notTarget || bug.expected || !(bug.reproduced > 0 || bug.fuzzer)) continue;
    if (KnownByValidation(bug)) continue;
    if (bug.validation?.kind === 'new') {
      bug.isNew = [...new Set(bug.runs.map(run => run.library))];
      out.push(bug);
      continue;
    }
    const sig = BugSignature(bug);
    if (!sig) continue;
    const libs = [];
    for (const lib of new Set(bug.runs.map(run => run.library))) {
      const run = bug.runs.find(r => r.library === lib);
      const plain = !targets[lib];
      const declared = plain ? KnownCve(bug, run, report?.cves) : undefined;
      const inferred = plain && declared === undefined ? InferredCve(bug, run, report?.cves) : null;
      const cve = declared ?? inferred;
      if (cve) {
        (bug.knownCve ??= {})[lib] = cve;
        if (inferred) (bug.knownCveInferred ??= {})[lib] = true;
        continue;
      }
      if (plain && declared === null) { libs.push(lib); continue; }
      if (!known) continue;
      const first = known[`${lib}|${sig}`];
      if (!first || String(first.task) === String(task)) libs.push(lib);
    }
    if (libs.length) { bug.isNew = libs; out.push(bug); }
  }
  return out;
}

// BugsHeadline(bugs, newBugs, report): the title of an objectives report (report.js), repeated by the scheduler's history
// page (report_verdicts.js -> task_links.json), after NewBugs: the real bugs (recorded by the fuzzer or reproduced by
// a replay, CVEs set apart excluded), how many a replay reproduced, the new ones, whether every real bug is expected
// given the tested version (in each configuration it was found in: the expected bug of the configuration, a CVE
// tlspuffin declares for what it built, or a known bug validation names: KnownByValidation), and the level of the task
// (LEVELS of ../common/verdicts.js):
//   new         a new bug (NewBugs);
//   unexpected  objectives in a configuration where no known bug is expected (no target, its build declares none), or,
//               but in a Vuln job (it looks for known bugs), a real bug that is not expected there;
//   known       every real bug expected there;
//   unclear     objectives, but no real bug (no replay reproduced one, the fuzzer recorded none);
//   null        no objective.
// text: the marks of the level (LEVELS) with what was found; null without a real bug.
export function BugsHeadline(bugs, newBugs, report) {
  const real = bugs.filter(bug => !bug.notTarget && (bug.reproduced > 0 || bug.fuzzer));
  const confirmed = bugs.filter(bug => bug.reproduced > 0 && !bug.notTarget).length;
  const allKnown = real.length > 0 && real.every(bug => KnownByValidation(bug) || [...new Set(bug.runs.map(run => run.library))]
      .every(lib => bug.expectedFor?.has(lib) || bug.knownCve?.[lib]));
  const vuln = ['vuln-a', 'vuln-b', 'vuln-custom'].includes(report?.job_type);
  const runs = report?.runs ?? [];
  const targets = ReportTargets(report);
  const declaredNone = lib => runs.filter(run => run.library === lib)
      .every(run => Array.isArray(run.cli?.vulnerabilities?.declared) && run.cli.vulnerabilities.declared.length === 0);
  const nothingExpected = [...new Set(runs.filter(run => (run.found ?? 0) > 0).map(run => run.library))]
      .filter(lib => !targets[lib] && declaredNone(lib));
  const objectives = runs.reduce((sum, run) => sum + (run.found ?? 0), 0);
  const level = newBugs.length ? 'new'
      : nothingExpected.length ? 'unexpected'
      : !real.length ? (objectives > 0 ? 'unclear' : null)
      : (vuln || allKnown) ? 'known' : 'unexpected';
  const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
  const alarm = newBugs.length ? `${LEVELS.new.mark} ${newBugs.length} NEW BUG${newBugs.length > 1 ? 'S' : ''}` : '';
  const where = nothingExpected.length ? `${LEVELS.unexpected.mark} objectives where no known bug is expected (${nothingExpected.join(', ')})` : '';
  const found = real.length ? `${level === 'unexpected' && !where ? `${LEVELS.unexpected.mark} ` : ''}${plural(real.length, allKnown ? 'known bug' : 'bug')} found`
      + (confirmed < real.length ? ` (${confirmed} reproduced)` : '') : '';
  return { real: real.length, confirmed, new: newBugs.length, allKnown, alarm, found, level, nothingExpected,
           text: found || where ? [alarm, found, where].filter(Boolean).join(' · ') : null };
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

// the CVE table of the bugs reference (vuln_targets.json _cves), null when it cannot be read; read once per page.
// Next to this module: the pages are served by the publisher (/html/) and by the scheduler (/files/)
let cvesLoading = null;
export function LoadCves() {
  cvesLoading ??= fetch(new URL('../jobsscripts/tlspuffin/vuln_targets.json', import.meta.url), { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null).then(json => json?._cves ?? null).catch(() => null);
  return cvesLoading;
}

// ---- Validation against tlspuffin's catalogue (PR_validate.sh): what the verdicts of a bug's objectives say ----

// The signature of a bug, as the catalogue's oracles say it: a claim, or a crash with its report type and top frame
export function BugSignatureOf(bug) {
  const claim = bug.fuzzer?.kind === 'claim' ? bug.fuzzer.detail : (bug.type === 'security-violation' ? bug.frames?.[0] : null);
  if (claim) return { kind: 'claim', violation: claim };
  return { kind: 'crash', type: bug.type, top: LocationFrames(bug.frames)[0] ?? null };
}
// whether a catalogue entry's oracle is that signature: the claim; or a crash with its ASan report type (when the oracle
// names one) and, when the entry gives its top frames, the bug's top frame among them
export function OracleMatchesBug(entry, signature) {
  const o = entry?.oracle;
  if (!o) return false;
  if (signature.kind === 'claim') return o.kind === 'claim' && o.violation === signature.violation;
  if (o.kind !== 'crash') return false;
  if (o.asan && o.asan !== signature.type) return false;
  const tops = entry.top_frames ?? [];
  return !tops.length || (signature.top != null && tops.some(f => FrameName(f) === signature.top));
}
// the catalogue's bugs of a library with the signature of a bug (catalogue: git_restapi's, vendors.<lib>.entries)
export function SignatureEntries(bug, catalogue, vendor) {
  const signature = BugSignatureOf(bug);
  return Object.entries(catalogue?.vendors?.[vendor]?.entries ?? {}).filter(([, e]) => OracleMatchesBug(e, signature)).map(([id]) => id);
}
// the ASan report type of a bug: its replay's, else the fuzzer's record ("SIGABRT · ASan bad-free"); null without ASan
const NOT_A_TYPE = new Set(['crash', 'no-crash', 'replay-error', 'not-replayed', 'security-violation', 'panic']);
function AsanTypeOfBug(bug) {
  const types = [...(bug.types?.keys() ?? []), bug.type, bug.replayType].filter(t => t && !NOT_A_TYPE.has(t));
  return types[0] ?? /ASan ([\w-]+)/.exec(String(bug.fuzzer?.detail ?? ''))?.[1] ?? null;
}
// Whether a known bug can be in what a run built: among the bugs its build declared when it declared them (the
// catalogue's bugs of its version minus those its preset fixes, cli.vulnerabilities.declared), else in the catalogue's
// affected versions at the version it built (cli.library.version: "540" is 5.4.0, "111j" 1.1.1j; the vendor field is the
// preset asked, which an older commit may not have had). Unknown version: no. A bug given by commits (a bug of
// tlspuffin's harness: affected_commits): in a commit without its fix only (affected_at_commit, from git:
// objectives_report.sh Verdicts), in whatever version that commit built
export function PresentInRun(id, entry, run) {
  if (entry?.affected_commits) return entry.affected_at_commit === true && (!entry.affected || PresentAtVersion(entry, run));
  const declared = run?.cli?.vulnerabilities?.declared;
  if (Array.isArray(declared)) return declared.includes(id);
  return PresentAtVersion(entry, run);
}
// whether the catalogue's affected versions of a bug have the library version a run built ("540": 5.4.0)
function PresentAtVersion(entry, run) {
  const m = /^(\d)(\d)(\d)([a-z]*)$/.exec(String(run?.cli?.library?.version ?? ''));
  return !!m && !!entry?.affected && inRange(entry.affected, `${m[1]}.${m[2]}.${m[3]}${m[4]}`);
}
// the library a configuration built (its run's record: wolfssl:wolfssl540-asan…), lower case
export function VendorOfRun(run) {
  return (String(run?.cli?.vendor ?? '').split(':')[0] || run?.cli?.library?.name || '').toLowerCase() || null;
}

// The strength of a signature verdict (validation compares the catalogue's oracle only: the claim, the panic, the ASan
// report type or signal). Strong: a crash whose stack (the replay's, or the fuzzer's record) has the place of the bug it
// names (../common/signatures.js: PlaceOf, HasPlace, the one rule of every page): as well as a signature can tell.
// Weak: every other, a signature without stack: a claim or a panic (one message, shared by several bugs: Authentication
// bypass is CVE-2021-3336's, SIG's and SKIP's), a crash whose bug has no known place, or a stack without it. A weak
// signature names a bug without telling it apart from another failure of the same kind: it never makes a bug known by
// itself (NewBugs, BugsHeadline)
export function StrongSignature(oracle, place, bug) {
  if (oracle?.kind !== 'crash' || !(place ?? []).length) return false;
  return HasPlace(place, bug.frames) || HasPlace(place, bug.fuzzer?.frames);
}

// The verdict of a bug from those of its objectives (report.libraries[].validation.byTrace, by "<attempt>/<trace>"),
// as parts, strongest first (VERDICT_ORDER of ../common/verdicts.js, where their words are):
//   patch       confirmed by patch differential: the bug is ids (the full green)
//   signature   on the build with every patch, with the signature of known bugs without patch there (ids): one of
//               them; strong (the ids whose catalogue top frames its stack has: part.strong, named first), else weak
//               (StrongSignature)
//   unpatched   on the build with every patch, with the claim or panic of bugs that have a patch there (ids): their
//               patch does not remove it: not them, or an incomplete patch (⚠)
//   new         on the build with every patch, the signature of no known bug: a new bug, or one missing from the
//               catalogue (🚨); lookalikes: the catalogue's bugs with a patch here whose top frames it has (said, not
//               decided)
//   other       removed by the patch of ids, with another signature: to review (⚠)
//   error       a validation build could not run it (failures: what failed)
//   no-replay   inconclusive, for a bug whose objectives do not replay on their own (the catalogue's replayable = false:
//               CDOS), which it is (its configuration's target) or whose signature it has (ids): expected, not a doubt
//   inconclusive, not-validated
//   none        objectives without verdict, by why (NO_VERDICT of verdicts.js: live, missing, failed, not-chosen,
//               unsupported), in a configuration with a validation
//   signature   also, when none of its objectives has a verdict (recognised: true): recognised by its signature with
//               its stack against the catalogue given (the latest one when its commit has none: latest), among the
//               bugs in what its runs built (PresentInRun), not validated
// kind: the strongest part with a verdict (null: none), ids: the bugs of that kind; counts: validated / objectives, per
// verdict; candidates: the catalogue's bugs with its signature (for "has the signature of X"). null when the bug's
// configurations have no validation and the catalogue names no candidate. oracles: the signature of each bug named.
export function BugValidation(bug, libraries, catalogue = null, live = false) {
  const byLib = Object.fromEntries((libraries ?? []).filter(l => l.validation).map(l => [l.library, l.validation]));
  const objectives = bug.objectives ?? [];
  const oracleOf = id => Object.values(byLib).map(v => v.entries?.[id]?.oracle).find(Boolean)
      ?? Object.values(catalogue?.vendors ?? {}).map(v => v.entries?.[id]?.oracle).find(Boolean) ?? null;
  // the place of a bug, the strength of a signature verdict (PlaceOf): from its catalogue top frames (the report's record
  // of the entry, report_verdicts.js, else the catalogue) and its witness's stack (recorded by validation: witness_frames)
  const firstOf = (field, id) => [...Object.values(byLib).map(v => v.entries?.[id]?.[field]), ...Object.values(catalogue?.vendors ?? {}).map(v => v.entries?.[id]?.[field])]
      .find(t => t?.length) ?? [];
  const topFramesOf = id => PlaceOf(firstOf('top_frames', id), firstOf('witness_frames', id));
  const verdicts = [], without = [];
  for (const o of objectives) {
    const v = byLib[o.library]?.byTrace?.[`${o.attempt}/${o.name}`];
    if (v) verdicts.push(v); else if (byLib[o.library]) without.push(o);
  }
  const vendor = VendorOfRun(bug.run) ?? VendorOfRun(bug.runs?.[0]);
  const candidates = catalogue && vendor ? SignatureEntries(bug, catalogue, vendor) : [];
  // without verdict (not validated, or its commit has no catalogue: then the latest catalogue, report_verdicts.js), the
  // crash bugs of the catalogue in what its runs built (PresentInRun) whose place its stack has (R3,
  // ../common/signatures.js), of its ASan type when its run had ASan: it is recognised as one of them by its signature
  // with its stack, not validated
  const asanType = AsanTypeOfBug(bug);
  const runs = bug.runs?.length ? bug.runs : [bug.run];
  const recognised = !catalogue || !vendor ? [] : Object.entries(catalogue.vendors?.[vendor]?.entries ?? {})
      .filter(([id, e]) => e.oracle?.kind === 'crash' && (!asanType || !e.oracle.asan || e.oracle.asan === asanType)
          && runs.some(run => PresentInRun(id, e, run)) && StrongSignature(e.oracle, topFramesOf(id), bug)).map(([id]) => id);
  // the known bugs it is whose objectives do not replay on their own (NoReplay)
  const noReplay = NoReplay(bug, libraries, catalogue);
  const counts = verdicts.reduce((c, v) => ({ ...c, [v.verdict]: (c[v.verdict] ?? 0) + 1 }), {});
  const base = { validated: verdicts.length, objectives: objectives.length || bug.count, counts, candidates,
                 during: verdicts.some(v => v.during_attempt), oracles: {} };
  if (!verdicts.length && !without.length && !recognised.length) return candidates.length ? { ...base, kind: null, ids: [], parts: [] } : null;
  // its objectives by what validation says of each (one claim can be several bugs: CVE-2021-3336 and SIG, SKIP on
  // 4.4.0 share "Authentication bypass"); the kind is the validation's (VerdictKind), whatever the page knows besides
  const partOf = v => {
    const kind = VerdictKind(v);
    if (kind === 'patch') return ['patch', v.entries ?? []];
    if (kind === 'signature') return ['signature', v.known_unpatched];
    if (kind === 'unpatched') return ['unpatched', v.signature_of_patched];
    if (kind === 'other') return ['other', v.other_signature ?? []];
    return [kind, []];
  };
  // a crash without known signature that looks like a bug with a patch here (the catalogue's top frames, shown to
  // people): said beside the 🚨, decides nothing
  const named = new Set(verdicts.flatMap(v => v.known_unpatched ?? []));
  const lookalikes = candidates.filter(id => !named.has(id));
  const parts = [];
  const add = (kind, ids, extra = {}) => {
    const part = parts.find(p => p.kind === kind && p.ids.join() === ids.join() && (p.why ?? '') === (extra.why ?? ''));
    if (part) { part.count += 1; return part; }
    const created = { kind, ids, count: 1, ...extra };
    parts.push(created);
    return created;
  };
  for (const v of verdicts) {
    const [kind, ids] = partOf(v);
    const part = kind === 'inconclusive' && noReplay.length ? add('no-replay', noReplay) : add(kind, ids);
    if (kind === 'error' && v.failure?.message) {
      part.failures ??= [];
      const what = `${v.failure.build === 'F' ? 'the build with every patch' : `the build without the patch of ${v.failure.build}`}: ${v.failure.message}`;
      if (!part.failures.includes(what) && part.failures.length < 3) part.failures.push(what);
    }
  }
  // objectives without verdict, and why
  for (const o of without) {
    const lib = byLib[o.library];
    const error = (lib.errors ?? []).find(e => String(e.attempt) === String(o.attempt));
    const why = live ? 'live'
        : error ? (/no validation result/.test(error.error ?? '') ? 'missing' : 'failed')
        : lib.unsupported ? 'unsupported'
        : Object.keys(lib.byTrace ?? {}).some(key => key.startsWith(`${o.attempt}/`)) ? 'not-chosen' : 'missing';
    const part = add('none', [], { why });
    if (error && why === 'failed') part.detail ??= error.error;
    // why validation could not run at this commit, as it recorded it (its tlspuffin has no catalogue; dev has none yet)
    if (why === 'unsupported' && typeof lib.unsupported === 'string') part.detail ??= lib.unsupported;
    (part.attempts ??= new Set()).add(`${o.library} run ${o.attempt}`);
  }
  parts.forEach(part => { if (part.attempts) part.attempts = [...part.attempts]; });
  // no verdict at all: recognised by its signature with its stack against the catalogue (the latest one when its commit
  // has none), not validated
  if (!verdicts.length && recognised.length) {
    const part = add('signature', recognised);
    Object.assign(part, { count: base.objectives, recognised: true, catalogue: catalogue?.commit ?? null, latest: !!catalogue?.latest });
  }
  // a signature verdict: strong for the bugs whose top frames the stack has (named first), else weak
  for (const part of parts.filter(p => p.kind === 'signature')) {
    const strong = part.ids.filter(id => StrongSignature(oracleOf(id), topFramesOf(id), bug));
    part.weak = strong.length === 0;
    // the reference stack of each bug named (the catalogue's top frames, else its witness's crash location), for the badge
    part.references = Object.fromEntries(part.ids.map(id => [id, topFramesOf(id)]));
    if (strong.length) { part.strong = strong; part.ids = [...strong, ...part.ids.filter(id => !strong.includes(id))]; }
  }
  for (const part of parts.filter(p => p.kind === 'new')) if (lookalikes.length) part.lookalikes = lookalikes;
  for (const id of new Set(parts.flatMap(p => p.ids))) base.oracles[id] = oracleOf(id);
  parts.sort((a, b) => VERDICT_ORDER.indexOf(a.kind) - VERDICT_ORDER.indexOf(b.kind) || b.count - a.count);
  // the bug's verdict: its strongest part with a verdict, with the bugs of every part of that kind
  const kind = parts.find(p => p.kind !== 'none')?.kind ?? null;
  const ofKind = parts.filter(p => p.kind === kind);
  return { ...base, parts, kind, ids: [...new Set(ofKind.flatMap(p => p.ids))],
           weak: kind === 'signature' && ofKind.every(p => p.weak) };
}

// NoReplay(bug, libraries, catalogue, cves): the known bugs it is (the expected bug of its configuration) or whose
// signature the fuzzer recorded, whose objectives do not replay on their own (replayable = false: CDOS), from the report's
// record of the entries (report_verdicts.js adds the catalogue's flag), the catalogue, else the bench's own table of CVEs
// (report.cves, vuln_targets.json _cves: also for the reports of commits without catalogue): its objectives not
// reproduced by a replay are expected, not a doubt about the find
export function NoReplay(bug, libraries, catalogue = null, cves = null) {
  const byLib = (libraries ?? []).filter(l => l.validation?.entries).map(l => l.validation.entries);
  const entriesOf = id => [...byLib.map(e => e[id]), ...Object.values(catalogue?.vendors ?? {}).map(v => v.entries?.[id]), cves?.[id]];
  const oracleOf = id => entriesOf(id).map(e => e?.oracle).find(Boolean) ?? null;
  const vendor = VendorOfRun(bug.run) ?? VendorOfRun(bug.runs?.[0]);
  const known = new Set([...byLib.flatMap(e => Object.keys(e)), ...Object.keys(catalogue?.vendors?.[vendor]?.entries ?? {})]);
  const group = { fuzzer: bug.fuzzer, type: [...(bug.types?.keys() ?? [])][0] ?? bug.replayType ?? bug.type, frames: bug.frames };
  return [...new Set([...(bug.expected ?? []), ...[...known].filter(id => OracleMatchesGroup(oracleOf(id), group))])]
      .filter(id => entriesOf(id).map(e => e?.replayable).find(r => r != null) === false);
}

// KnownByValidation(bug): validation names a known bug for it: confirmed by patch, or by a signature that is not weak
export const KnownByValidation = bug => bug.validation?.kind === 'patch' || (bug.validation?.kind === 'signature' && !bug.validation.weak);

// AnalyseReport(report, known, catalogue): what the pages and tools tell of an objectives report, decided in one place
// (the objectives page, Results, report_verdicts.js for History): the expected bug of each configuration, the bugs with
// their validation verdicts, the new ones (known: the registry of the bugs found so far, known_bugs.json), the 🎯 runs
// that found their expected bug, the headline and level of the task. catalogue (git_restapi's, optional; else the
// report's catalogue_digest): the bugs with the signature of a bug none of whose objectives was validated, which bugs
// do not replay, the top frames of the signatures
export function AnalyseReport(report, known = null, catalogue = null) {
  // without the catalogue (Results), the digest report_verdicts.js wrote into the report: the same flags
  catalogue ??= report?.catalogue_digest?.format === 'vulnerabilities.toml' ? report.catalogue_digest : null;
  const runs = report?.runs ?? [], libraries = report?.libraries ?? [];
  const targets = ReportTargets(report);
  const bugs = Bugs(runs, report?.not_targeted, targets, libraries, report?.job_type);
  for (const bug of bugs) {
    bug.validation = BugValidation(bug, libraries, catalogue, !!report?.live);
    bug.noReplay = NoReplay(bug, libraries, catalogue, report?.cves);
  }
  const newBugs = NewBugs(bugs, known, report?.task, report);
  const expectedRuns = ExpectedRuns(runs, targets, libraries);
  return { targets, bugs, newBugs, expectedRuns, headline: BugsHeadline(bugs, newBugs, report) };
}
