// The words of the bench for what a task found and how it knows: one vocabulary for every page (the objectives pages,
// Results, the Bugs reference, the 🐞 of the scheduler's history, through the report's verdicts) and for the user
// guide (tlspuffin_user_guide.md, "Words of the pages", which tests compare with this file). Marks, words and what
// each means; the decisions (which verdict, which level) are made elsewhere: the validation of the job scripts
// (PR_validate.sh) and the pages' bugs.js. Nothing here imports anything: QuickJS reads it too (report_verdicts.js).

// The terms, as the help panels and the user guide define them
export const TERMS = [
  ['objective', 'an input the fuzzer saved because its oracle fired: a crash (with an ASan report when the build has ASan), a violated claim of the protocol, a panic'],
  ['bug', 'the objectives with the same failure: the same ASan report type and top stack frames, or the same violated claim'],
  ['reproduced', 'a replay of the objective, on the build of its own run, gave that failure again (else: not reproduced, or a replay error when the replay could not run)'],
  ['fuzzer only', 'the fuzzer\'s own log recorded the failure when it saved the objective, but no replay reproduces it (the fuzzer runs every input in one process: state, memory layout)'],
  ['signature', 'how tlspuffin\'s catalogue recognises a known bug (its oracle): a crash with a given ASan report type or signal, a violated claim with its message, a panic with its message; for a crash, also its place: the first frames of the stack of its witness, else its top frames in the catalogue'],
  ['strong signature', 'a crash with the bug\'s ASan report type whose stack has the bug\'s own place: its first 3 frames, outside the sanitizer runtime, libc and the fuzzer, are those of the bug\'s witness (validation runs it, symbolized), else its top frames in the catalogue, in order: as well as a signature can tell (only a patch is certain); green'],
  ['weak signature', 'a signature without stack: a claim or a panic (one message, which several bugs can share: Authentication bypass is CVE-2021-3336\'s, SIG\'s and SKIP\'s), or a crash told by its ASan report type or signal alone (neither top frames in the catalogue nor a witness\'s stack, or a stack without them): it names a bug without telling it apart from another failure of the same kind; yellow'],
  ['validated', 'the objective was replayed on the validation builds (F: every known bug with a patch patched; V_X: F without the patch of X) and got a verdict'],
  ['confirmed', 'by patch differential only: the objective goes away with the patch of X and gives the signature of X without it; certain'],
  ['known bug', 'a bug of tlspuffin\'s catalogue (a CVE, an alias such as BUF), active at the version tested'],
  ['expected', 'for a configuration: its target (Vuln jobs), and the known bugs tlspuffin declares for the version it built'],
  ['unexpected', 'objectives in a configuration where no known bug is expected (no bug declared for its version), or a bug that is neither its target nor a known bug declared for it'],
  ['recognised', 'a find without validation verdict (an older task, whose tlspuffin had no catalogue: then the latest catalogue; or objectives not validated) whose crash has the ASan report type and the place of a known bug in what its run built (its declared bugs, else the version it built): named after it, "≈ X · by its signature with its stack · not validated"; known, not proven (validation by patch would confirm it)'],
  ['new bug', 'a bug no one knows: on the build with every patch, the signature of no known bug; or, without validation, a signature no earlier task had and no known bug of its version'],
];

// The verdict of the validation on an objective (PR_validate.sh ValidationVerdict), as a kind of badge (bugs.js
// BugValidation parts: the same kinds); strongest first. mark, word (the badge), cls (val-<kind> on the objectives
// pages, validation-<kind> on Results), tip (what it means, the first line repeats the badge).
export const VERDICTS = {
  patch: { mark: '✔', word: 'confirmed by patch', tip: 'confirmed by patch differential\nthe patch of this bug removes the objective, and without it the objective gives its signature: it is this bug (certain)' },
  signature: { mark: '≈', word: 'by its signature', tip: 'by its signature only\non the build with every patch, the objective gives the signature of a known bug without patch at this version: one of them; strong (green) when its stack has that bug\'s place (the first frames of its witness\'s stack, else its top frames in the catalogue), weak (yellow) otherwise: a claim, a panic, a crash told by its type alone or elsewhere (a patch would make it certain)' },
  unpatched: { mark: '⚠', word: 'signature of a bug its patch does not remove', tip: 'the signature of a bug that has a patch here, not removed by it\nthe objective stays on the build with every patch: not this bug, or its patch is incomplete; to review' },
  new: { mark: '🚨', word: 'no known bug\'s signature', tip: 'no known bug\'s signature\nthe objective stays on the build with every patch, with the signature of no bug of the catalogue: a new bug, or one missing from the catalogue' },
  other: { mark: '⚠', word: 'another signature', tip: 'another signature\nthe patch of the bug(s) named removes the objective, but without it the objective does not give their signature: to review, never counted as them' },
  'no-replay': { mark: '◌', word: 'does not replay, as known', tip: 'does not replay, as known\nthe catalogue says the objectives of this bug do not replay on their own (they need the state of the fuzzer, replayable = false): not reproducing them on the validation builds is expected, nothing to worry about; the fuzzer\'s record of the crash is the evidence' },
  error: { mark: '⛔', word: 'could not replay', tip: 'could not replay\na validation build could not run the objective (its command line refused, it crashed before the trace, it timed out): no verdict, never read as "not reproduced"' },
  inconclusive: { mark: '?', word: 'not reproduced on the validation builds', tip: 'not reproduced on the validation builds\nthe replays ran, without the failure: it needs the state of the fuzzer, another layout, or two bugs at once' },
  'not-validated': { mark: '…', word: 'not validated', tip: 'not validated\nthe validation\'s time budget was spent before this objective' },
  none: { mark: '○', word: 'no verdict', tip: 'no verdict\nthis objective has no validation verdict (why: on the badge)' },
};
// the order of strength (a bug's verdict is its strongest part)
export const VERDICT_ORDER = ['patch', 'signature', 'unpatched', 'new', 'other', 'error', 'no-replay', 'inconclusive', 'not-validated', 'none'];
// why an objective has no verdict (bugs.js BugValidation: none.why)
export const NO_VERDICT = {
  live: 'not validated yet (the run is going on)',
  missing: 'no validation result for its run (its validation step failed or did not run)',
  failed: 'the validation of its run failed',
  'not-chosen': 'not among the objectives validated in its run (at most 20 a run, the first of each bug first)',
  unsupported: 'not validated at this commit (the reason follows: its tlspuffin has no catalogue, or dev, whose catalogue validation trusts, has none yet); its crashes are still recognised by their stack against the latest catalogue',
};

// The verdict JSON of one objective ({ verdict, entries, known_unpatched, signature_of_patched, … }) as a kind of
// VERDICTS: what the validation recorded, nothing else (every page and tool tells the same). The pages tell one more
// (bugs.js BugValidation): an inconclusive objective of a bug known not to replay is 'no-replay'
export function VerdictKind(v) {
  if (!v) return 'none';
  switch (v.verdict) {
    case 'confirmed': return 'patch';
    case 'not-patched': return (v.known_unpatched ?? []).length ? 'signature' : (v.signature_of_patched ?? []).length ? 'unpatched' : 'new';
    case 'other-signature': return 'other';
    case 'error': case 'inconclusive': case 'not-validated': return v.verdict;
    default: return 'none';
  }
}

// What a bug is for its task (bugs.js Bugs, NewBugs): the tags beside its symptom
export const TAGS = {
  expected: { mark: '🎯', word: 'expected', tip: 'the bug this configuration is meant to find (its target)' },
  apart: { mark: '⦸', word: 'set apart', tip: 'a known CVE of old library versions that is never a target: in a run that looks for a target (a Vuln job, or a configuration with a target), it does not end the run and is named after its CVE' },
  known: { mark: '📋', word: 'known', tip: 'a CVE tlspuffin declares for what this configuration built, whose signature the bug has: not a new bug' },
  unexpected: { mark: '⚠', word: 'unexpected', tip: 'neither the target of its configuration nor a known bug declared for it' },
  new: { mark: '🚨', word: 'NEW BUG', tip: 'a bug no one knows (see "new bug")' },
};

// The level of a task, from its bugs (bugs.js BugsHeadline level): the title of its objectives page, the colour of its
// 🐞 on the scheduler's history, of its objectives on the board (joblauncher.js describeMonitor) and of the top bar's
// live pill (nav.js)
export const LEVELS = {
  new: { mark: '🚨', word: 'new bug', tip: 'a bug no one knows: the signature of no known bug' },
  unexpected: { mark: '⚡', word: 'unexpected', tip: 'objectives where no known bug is expected (none declared for the version tested), or bugs other than those expected there' },
  known: { mark: '', word: 'known bugs', tip: 'every bug found is expected there: a target, or a known bug of the version tested' },
  unclear: { mark: '', word: 'nothing reproduced', tip: 'objectives, but no replay reproduced a bug and the fuzzer recorded none' },
};

// Whether a signature can tell its bug apart by the stack (strong on the reports when the stack has the bug's place): a
// crash for which the catalogue gives top frames, or that has a witness (validation records where it crashes); any other
// is weak (a claim, a panic, a crash told by its type alone)
export const SignatureWithStack = (oracle, topFrames, witness = false) => oracle?.kind === 'crash' && ((topFrames ?? []).length > 0 || witness);

// A signature (the catalogue's oracle { kind, asan, signal, violation, panic }) in words, e.g. "a crash with an ASan
// SEGV report", "the claim “Authentication bypass”"
export function SignatureText(oracle) {
  if (!oracle) return 'no signature';
  if (oracle.kind === 'claim') return `the claim “${oracle.violation ?? '?'}”`;
  if (oracle.kind === 'panic') return `a panic${oracle.panic ? ` “${oracle.panic}”` : ''}`;
  if (oracle.kind === 'crash') {
    const what = [oracle.asan ? `an ASan ${oracle.asan} report` : '', oracle.signal ? `signal ${oracle.signal}` : ''].filter(Boolean).join(', ');
    return what ? `a crash with ${what}` : 'a crash';
  }
  return oracle.kind ?? 'no signature';
}

// The bench that made the verdicts ([{ commit, jobscripts }] of the validation files), in words
export function BenchText(bench) {
  const all = (bench ?? []).filter(b => b?.commit || b?.jobscripts);
  if (!all.length) return '';
  const one = b => b.jobscripts && b.jobscripts !== b.commit ? `${String(b.commit ?? '?').slice(0, 7)} (job scripts ${String(b.jobscripts).slice(0, 7)})`
      : String(b.commit ?? b.jobscripts).slice(0, 7);
  return `validated by the bench ${all.map(one).join(', ')}`;
}
