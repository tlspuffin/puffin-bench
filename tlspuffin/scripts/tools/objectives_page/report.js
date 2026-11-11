// Objectives page of a task (objectives_report.sh: final, objectives_live.sh: while it runs), rendered from the
// JSON written next to it ({ task, commit, name, live?, updated?, user?, job_type?, started?, ended?, cancelled?,
// task_url?, libraries?, runs: [{ library, attempt, found, replayed, reports, groups, cli, asan }] }).
// The page is organized by bug: the groups of every run with the same type and stack frames are one bug.

import '../board/nav.js';
import { resolveCommits, parseTaskName, commitLineHTML } from '../common/commitinfo.js';
import { UNCONFIRMED, TYPE_LABELS, FuzzerText, Mismatch, Partly, Letter, Uncategorised, UncategorisedText, BugName, ShortName, LoadCves, RunFailures, ExpectedConclusion, ExpectedChipTip, KnownByValidation, TargetText, AnalyseReport } from './bugs.js';
import { TERMS, VERDICTS, VERDICT_ORDER, NO_VERDICT, TAGS, LEVELS, SignatureText, SignatureWithStack, BenchText } from '../common/verdicts.js';

// text for HTML (attribute values included), a count as people read it: first, the help panel below uses them
const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const count = (value) => Number(value ?? 0).toLocaleString('en-US');

// the bench's services, on the host of the page
const HOST = `${location.protocol}//${location.hostname}`;
const SCHEDULER = `${HOST}:10082`, PUBLISHER = `${HOST}:10083`, GIT_RESTAPI = `${HOST}:10081`;
const BUGS_PAGE = `${PUBLISHER}/html/publisher/bugs.html`;
// a live page (its bugs are still being validated)
let LIVE = false;
// the CVE table of the bugs reference: the names of the bugs (BugName)
let CVES = null;
// tlspuffin's catalogue the validation rests on (git_restapi; the commit validation used, else the task's): the names,
// oracles and patches of the bugs, null when unavailable
let CATALOGUE = null;
const CatalogueEntry = id => Object.values(CATALOGUE?.vendors ?? {}).map(v => v.entries?.[id]).find(Boolean) ?? null;
// the signature of a bug of the catalogue: from the validation's record of it (report.libraries[].validation.entries),
// else from the catalogue
let ENTRY_ORACLES = {};
const EntryOracle = id => ENTRY_ORACLES[id] ?? CatalogueEntry(id)?.oracle ?? null;
// a bug of the catalogue: "BUF · CVE-2022-39173", linked to its entry on the Bugs reference, its signature on hover
function EntryName(id) {
  const entry = CatalogueEntry(id);
  const text = entry?.alias ? `${entry.alias} · ${id}` : id;
  const oracle = EntryOracle(id);
  const frames = entry?.top_frames?.length ? `\ntop frames (shown, not used to decide): ${entry.top_frames.join(' < ')}` : '';
  return `<a href="${BUGS_PAGE}#${encodeURIComponent(id)}" target="_blank" rel="noopener" title="${esc(`${id}: its signature, ${SignatureText(oracle)}${frames}\nClick: every field of ${id} on the Bugs reference`)}">${esc(text)}</a>`;
}
const EntryNames = (ids, joiner = ' or ') => ids.map(EntryName).join(joiner);
// the name of a bug: from the catalogue when validation names it (KnownByValidation: by patch, or by a signature that is
// not weak: its alias or ID), else BugName (the expected bug of its configuration, a CVE set apart or declared, else
// "Bug A"…)
function DisplayName(bug, short = false) {
  const main = KnownByValidation(bug) ? bug.validation.parts.find(p => p.kind === bug.validation.kind && p.ids.length) : null;
  if (main) {
    const names = main.ids.map(id => CatalogueEntry(id)?.alias ?? id);
    return names.join(short ? '/' : ' / ');
  }
  return short ? ShortName(bug, CVES) : BugName(bug, CVES);
}
// a badge: the mark and words of a verdict (../common/verdicts.js), its meaning on click
const Badge = (kind, html, tip, extra = '') => `<span class="val val-${kind}${extra}" data-click-tip="${esc(`${VERDICTS[kind].mark} ${tip}`)}">${VERDICTS[kind].mark} ${html}</span>`;
// what each verdict says, as the badge of a part of a bug's objectives (BugValidation parts)
function ValidationPart(part, live, bug = null) {
  const n = ` ×${count(part.count)}`;
  const v = VERDICTS[part.kind] ?? VERDICTS.none;
  switch (part.kind) {
    case 'patch': return Badge('patch', `${EntryNames(part.ids, ', ')} · ${v.word}${n}`, v.tip);
    case 'signature': {
      // the signature itself, and how much it tells
      const sigs = [...new Set(part.ids.map(id => SignatureText(EntryOracle(id))))].join(' or ');
      // strong: its stack has the top frames of the bugs named first (part.strong); weak: why
      const tops = ids => [...new Set(ids.flatMap(id => CatalogueEntry(id)?.top_frames ?? []))];
      const crashes = part.ids.filter(id => EntryOracle(id)?.kind === 'crash');
      const weak = !part.weak ? ` · with its stack (top frame ${tops(part.strong ?? []).join(' or ')})`
          : !crashes.length ? ' · weak: one message, no stack'
          : tops(crashes).length ? ` · weak: its stack has none of their top frames (${tops(crashes).join(', ')})`
          : ` · weak: any ${sigs.replace(/^an? /, '')} matches`;
      // the expected bug of its configuration with the same signature, not named: its patch is on the build with every
      // patch, which still gives the signature: not it (a custom benchmark of CVE-2021-3336 on 4.4.0: SIG and SKIP
      // have the same claim and no patch there)
      const same = id => JSON.stringify(EntryOracle(id)) === JSON.stringify(EntryOracle(part.ids[0]));
      const ruledOut = (bug?.expected ?? []).filter(id => !part.ids.includes(id) && EntryOracle(id) && same(id));
      const notIt = ruledOut.length ? ` · not ${EntryNames(ruledOut)}: its patch does not remove it` : '';
      return Badge('signature', `${EntryNames(part.ids)} · ${v.word} (${esc(sigs)})${weak}${notIt}${n}`,
          `${v.tip}\nits signature: ${sigs}${part.weak ? `\nweak signature: ${TERMS.find(t => t[0] === 'weak signature')[1]}`
              : `\nstrong signature: ${TERMS.find(t => t[0] === 'strong signature')[1]}`}`
          + (ruledOut.length ? `\nnot ${ruledOut.join(', ')}, the expected bug, which has the same signature: its patch is on the build with every patch, where this objective still gives the signature` : ''),
          part.weak ? ' val-weak' : '');
    }
    case 'unpatched': return Badge('unpatched', `signature of ${EntryNames(part.ids)}, not removed by its patch${n}`, v.tip);
    case 'new': return Badge('new', `${v.word}${n}`, v.tip)
        + (part.lookalikes?.length ? ` <span class="val-note" title="${esc('the catalogue\'s top frames of these bugs (shown to people, never used to decide) are in its stack, but their patch, applied on the build with every patch, does not remove it: not them, or an incomplete patch; to review')}">its stack looks like ${EntryNames(part.lookalikes)} (patched here): to review</span>` : '');
    case 'other': return Badge('other', `removed by the patch of ${part.ids.length ? EntryNames(part.ids, ', ') : 'a bug'}, ${v.word}${n}`, v.tip);
    case 'error': return Badge('error', `${v.word}${n}`, `${v.tip}${part.failures?.length ? `\n${part.failures.join('\n')}` : ''}`);
    case 'no-replay': return Badge('no-replay', `${EntryNames(part.ids)} · ${v.word}${n}`, v.tip);
    case 'inconclusive': return Badge('inconclusive', `${v.word}${n}`, v.tip);
    case 'not-validated': return Badge('not-validated', `${v.word}${n}`, live ? 'not validated yet' : v.tip);
    default: {
      const why = NO_VERDICT[part.why] ?? NO_VERDICT.missing;
      return Badge('none', `${v.word}: ${esc(why)}${n}`, `no verdict\n${why}${part.detail ? `: ${part.detail}` : ''}${part.attempts?.length ? `\n${part.attempts.join(', ')}` : ''}`);
    }
  }
}
// the validation line of a bug: its parts (each objective has one: a verdict, or why it has none), how many of its
// objectives have a verdict; without verdict, the bugs of the catalogue with its signature
function ValidationHTML(bug, live) {
  const v = bug.validation;
  if (!v) return '';
  const candidates = !v.kind && v.candidates.length ? Badge('none', `the signature of ${EntryNames(v.candidates)} · not validated${live ? ' yet' : ''}`,
      `its signature, not validated${live ? ' yet' : ''}\nnone of its objectives has a verdict: the bug(s) of the catalogue with its signature (claim, or ASan report type and top frame) are named, without proof`) : '';
  if (!v.parts.length) return candidates ? `<div class="validation">${candidates}</div>` : '';
  return `<div class="validation">${candidates}${v.parts.map(part => ValidationPart(part, live, bug)).join('')}<span class="val-note">${count(v.validated)} of ${count(v.objectives)} objectives validated${v.during ? ', during the run' : ''}</span></div>`;
}
// the configurations of the report shown (report.libraries): runs, outcomes, ends, errors of the end-of-run summaries
let REPORT_LIBRARIES = [];
// the job type of the report (perf, vuln-a…): why a run did not succeed depends on it (RunFailures)
let REPORT_JOB_TYPE = null;

// help of this page, shown by the ❔ of the top bar (nav.js reads <template id="help-panel"> when it opens)
const help = document.createElement('template');
help.id = 'help-panel';
help.innerHTML = `
  <h2>What is shown</h2>
  <p>The objectives found by one task, grouped by bug. A <b>live</b> page belongs to a running task: its objectives are
  replayed every few minutes (on core 0, outside the fuzzing cores) and the page reloads every minute. The final page is
  written when the task ends, from its archive.</p>

  <h2>Header</h2>
  <ul>
    <li>Title: <b>🚨 N NEW BUG(S)</b> when the task found a new bug (see below), the number of
      bugs found (and how many a replay reproduced), the commit of the task (short hash, PR, message). <b>N known bugs
      found</b> when every bug found is expected given the tested version: the expected bug of its configuration (🎯
      expected), a CVE tlspuffin declares for that build (📋 known · CVE) or a known bug validation names; <b>⚡</b>
      before it when the task's level is unexpected (see the levels below).</li>
    <li>Task name, user, start → end (duration), links: the task on the Scheduler, the Results, ⬇️ the artefacts (finished
      task), the JSON this page is drawn from, <b>🎯 bugs reference</b> (the expected bugs, the CVEs set apart, the bugs
      found so far), 💾 save offline (one HTML file), 🖨 print / PDF.</li>
    <li>Tiles: distinct bugs · objectives found · replayed and reproduced · VulnA: <b>🎯 runs that found the expected bug</b>
      per configuration; other jobs: configurations with a bug (and how many a replay reproduced).</li>
  </ul>

  <h2>Objectives and bugs</h2>
  <ul>
    <li>An <b>objective</b> is an input saved by the fuzzer because it triggered the oracle.</li>
    <li>Each objective is <b>replayed</b> with exactly the binary, flags and environment of its run (recorded when the
      run started); a binary changed since is a replay error.</li>
    <li>Up to <b>100 objectives per run</b> are replayed; in VulnA those of the expected bug first (the fuzzer's log says
      which). The others are not lost: each objective, replayed or not, gets the category the fuzzer gave it in its own
      log (its crash and backtrace, the AddressSanitizer error of its stderr when the build has ASan, or the claim). An
      objective whose log line was lost to log rotation takes the category of an objective with the same input.</li>
    <li>Objectives with the same error type and top stack frames (or the same violated claim) form one <b>bug</b>.</li>
    <li>Each objective is also matched with the fuzzer's <b>own record</b> of it, from its logs: the crash it caught
      (signal and backtrace) or the claim violation, logged when it saved the objective. A replay that does not confirm
      a bug is tried again (up to 5 times: a memory corruption in a library built without ASAN crashes or not
      depending on the memory layout). Objectives whose replays never confirm what the fuzzer saw are grouped by the
      fuzzer's record and marked <b>⚠ fuzzer ≠ replay</b>: the fuzzer runs every input in one process (state of the
      library, e.g. its session cache), a replay starts a fresh one.</li>
    <li>Types: <span class="type asan">AddressSanitizer error</span> memory corruption ·
      <span class="type sec">security violation</span> a claim of the protocol was violated by the security oracle
      (e.g. authentication bypass, without a crash) · <span class="type panic">panic</span> ·
      <span class="type asan">crash (no sanitizer report)</span> the replay died of SIGSEGV or SIGABRT in a library
      built without ASAN. <span class="type none">not reproduced</span> (the replay did not reach the bug: it ran
      without error, or the library stopped on an error before it, shown as the reason) and
      <span class="type none">replay error</span> (timed out or could not run) are not reproduced bugs.</li>
  </ul>

  <h2>Validation against tlspuffin's catalogue</h2>
  <p>Each objective of a task on a commit with the catalogue is replayed on validation builds: the build with every known
    bug that has a patch patched, and that build without the patch of each such bug (during the run for the experiments
    that name their bug: custom benchmarks, Vuln group A and B; ValidateObjectives after each run, at most 20 objectives
    a run, the first of each bug first). What it says, on each bug, per objective (each badge with how many):</p>
  <ul>
    ${VERDICT_ORDER.map(kind => `<li><span class="val val-${kind}">${VERDICTS[kind].mark} ${esc(VERDICTS[kind].word)}</span> ${esc(VERDICTS[kind].tip.split('\n').slice(1).join('; '))}${kind === 'signature' ? `; <span class="val val-signature val-weak">≈ … weak</span> when its signature is weak (${esc(TERMS.find(t => t[0] === 'weak signature')[1])}): the bug is named, not told apart from another crash of that type, and it is not counted as known by that alone` : ''}${kind === 'none' ? `: ${Object.values(NO_VERDICT).map(esc).join('; ')}` : ''}</li>`).join('')}
  </ul>
  <p>One claim or crash can be several bugs (CVE-2021-3336, SIG and SKIP share "Authentication bypass" on wolfSSL 4.4.0):
    the line of a bug lists what its objectives are. A bug's name comes from the catalogue when validation names it (by
    patch, or by a signature that is not weak); each name links to the bug's entry on the Bugs reference, its signature
    on hover. Below the tiles: the catalogue the verdicts rest on, the bench that made them, and what went wrong (a run
    without validation result, failed controls).</p>

  <h2>Words</h2>
  <p>The same words on every page of the bench (Results, the Bugs reference, History, this page) and in the user guide:</p>
  <dl class="terms">${TERMS.map(([term, text]) => `<dt>${esc(term)}</dt><dd>${esc(text)}</dd>`).join('')}</dl>

  <h2>Expected, set apart, unexpected, new</h2>
  <p>The level of the task, its title here and the colour of its 🐞 on History: ${Object.entries(LEVELS).map(([key, l]) =>
    `<b>${esc(`${l.mark ? `${l.mark} ` : ''}${l.word}`)}</b> ${esc(l.tip)}${key === 'new' ? ' (History: red)' : key === 'unexpected' ? ' (History: gold)' : ' (History: plain)'}`).join('; ')}.</p>
  <ul>
    <li><span class="expected">${TAGS.expected.mark} ${TAGS.expected.word} · CVE</span>: the bug this VulnA configuration is meant to find (the bug row and the
      Configurations table). Its run ends on it.</li>
    <li><b>⦸</b> set apart: a known CVE of the old library versions that is never a target, on those versions only (CVE-2024-5814: wolfSSL &lt; 5.7.2; on any other library or version its claim is a bug); it does not
      end a run.</li>
    <li><span class="unexpected">${TAGS.unexpected.mark} ${TAGS.unexpected.word}</span>: in a configuration with a target, a bug that is neither: a new finding,
      or a rule to add to the targets file.</li>
    <li><span class="new-bug-badge">${TAGS.new.mark} ${TAGS.new.word}</span>: a real bug (fuzzer record or replay), neither expected nor set apart.
      In a configuration with an expected bug (an alias: BUF, SKIP…): its signature (its claim, or the top function of its
      crash) no earlier task had in that configuration, whatever the job. In a plain version (e.g. Perf's wolfSSL 5.8.0):
      not one of the CVEs tlspuffin declares for that build, whose signature is in vuln_targets.json (then
      <span class="known-cve">📋 known · CVE</span>); it stays new on every task until it is added there. The targets, the
      CVEs and the bugs found so far: <a href="${BUGS_PAGE}">🎯 Bugs reference</a>.</li>
  </ul>

  <h2>❓ Without category</h2>
  <p>The tile <b>❓ N without category</b> counts the objectives whose bug cannot be told: no replay reproduced them and the
    fuzzer's log has no record of them (no log in the artefacts, or the record lost to log rotation and no other
    objective with the same input), or a crash without location. Click it: how many per configuration and why. They
    could hide a bug. On a live page, <b>⏳ N not processed yet</b> (faint) counts apart the objectives not replayed yet:
    waiting resolves them (the final report classifies every objective).</p>

  <h2>Using the page</h2>
  <ul>
    <li>Chips: show the reproduced bugs, the not reproduced and the replay errors; <b>unfold all</b> opens every bug.</li>
    <li>A bug row: number of objectives, type, top frames (the frame in red is where it happened), the runs it came from
      (configuration, run, count). Unfolded: the report of one replay, its build and ASAN state, 📋 to copy the report.</li>
    <li><b>Configurations</b>: per configuration, its expected bug and how it is recognised (vuln_targets.json; without
      one, the CVEs tlspuffin declares for its build, recognised as 📋 known), its build, ASAN, runs with objectives and
      runs that succeeded, objectives and bugs found.</li>
    <li><b>🎯 banner</b>, the same conclusion as Results: configurations that found their expected bug, in how many
      runs: every run that found it counts. Green: every run of every configuration; amber: every configuration, not
      every run; red: a configuration in no run. <b>· k untimed</b>: runs that found the bug but did not end normally
      (ended by their timeout, no end-of-run summary): counted, but without a time to find in the statistics of Results
      (time to find, execs), which come from the end-of-run summaries; listed below the banner with why.</li>
    <li>Traces: <b>⬇ all traces (zip)</b> on an unfolded bug; the full reports are in the artefacts,
      <code>&lt;configuration&gt;/&lt;run&gt;-objective</code> and <code>-objective-reports</code>.</li>
  </ul>
  <p>Details: the <b>box cursor</b> means a click opens a small window (badges, tiles); the <b>? cursor</b>, a link or a
    button: hover. Press <b>?</b> to toggle this panel.</p>`;
document.head.appendChild(help);

const PREFIXES = { 'perf': 'Perf', 'vuln-a': 'VulnA', 'vuln-b': 'VulnB', 'campaign': 'Camp' };


function TypeClass(type) {
  if (UNCONFIRMED.has(type)) return 'none';
  if (type === 'security-violation') return 'sec';
  if (type === 'panic') return 'panic';
  return 'asan';
}

// as soon as one objective is not reproduced by its replay: how many, and why it matters (the legend of the types is
// in the help panel)
function UnconfirmedNote(found, replayed, notReproduced, errors, confirmedBugs, fuzzerOnly = 0) {
  if (notReproduced + errors === 0 && replayed >= found) return '';
  const parts = [
    notReproduced ? `${count(notReproduced)} not reproduced (the replay did not reach the bug)` : '',
    errors ? `${count(errors)} replay error${errors > 1 ? 's' : ''} (timed out or could not run)` : '',
    found > replayed ? `${count(found - replayed)} not replayed${confirmedBugs || notReproduced || errors ? '' : ' yet'}` : '',
  ].filter(Boolean);
  const head = confirmedBugs === 0 && found > 0 ? 'Objectives were found, but no replay reproduced a bug' : `Of ${count(found)} objectives`;
  const fz = fuzzerOnly ? ` For ${count(fuzzerOnly)} of them the fuzzer's own log shows a crash or a claim violation
    when it saved them (⚠ not reproduced): the fuzzer runs every input in one process, a replay starts a fresh one;
    they count with the bug the fuzzer recorded.` : '';
  return `<p class="unconf">${head}: ${parts.join(', ')}.${fz} An objective not reproduced may depend on the state of
    the fuzzer or on the memory layout; its trace, report and the fuzzer's logs are in the artefacts.</p>`;
}

function Duration(ms) {
  const minutes = Math.round(ms / 60000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
}

function DateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return isNaN(date) ? String(value) : date.toLocaleString([], { weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit' });
}

// what was built (BuildDescription in PR_common.sh), derived for records without "build"
function Build(run) {
  const cli = run?.cli;
  if (!cli) return run?.put ?? '';
  if (cli.build) return cli.build;
  const preset = String(cli.vendor ?? '').split(':').pop();
  if (cli.cputs === true) return `C harness, ${preset}`;
  if (cli.cputs === false) {
    const library = (cli.library?.name ?? 'NA') !== 'NA' ? `${cli.library.name}${cli.library.version ?? ''}` : `features ${cli.features ?? ''}`;
    return `Rust harness, ${library}`;
  }
  return '';
}

function Asan(run) {
  if (run?.asan === true) return '<span class="ok" data-click-tip="✓ ASAN\nbuild: the library is built with ASAN (AddressSanitizer)">✓</span>';
  if (run?.asan === false) return '<span class="bad" data-click-tip="✗ not instrumented\nbuild: the library is built without ASAN\nso: memory errors are found only when they crash">✗ not instrumented</span>';
  return '<span class="muted" data-click-tip="? ASAN\nbuild: did not record whether ASAN is on">?</span>';
}

// bugs: the groups of every run, merged by type and frames, largest first

// the report excerpt with the error type and the top frame highlighted
function Excerpt(bug) {
  let html = esc(bug.excerpt);
  const words = [bug.type, bug.frames[0]].filter(word => word && !UNCONFIRMED.has(word));
  for (const word of words) {
    html = html.split(esc(word)).join(`<span class="hl">${esc(word)}</span>`);
  }
  return html;
}

// what the fuzzer saw when it saved the objectives of a bug (its logs): "SIGABRT" crash with frames, or a claim


function FramesHTML(frames) {
  return `<b>${esc(frames[0])}</b>${frames.length > 1 ? ' &lt; ' + frames.slice(1).map(esc).join(' &lt; ') : ''}`;
}


// a bug that is not the target of VulnA/VulnB (another known CVE of the library): it did not end the experiment
function NotTargetBadge(bug) {
  return ` <span class="not-target" data-click-tip="Not the CVE this job looks for: ${esc(bug.notTarget)}, which the old library versions of VulnA/VulnB also have. Since 2026-10-06 such an objective no longer ends the experiment (the time to find is that of the targeted CVE); it is still replayed and listed here.">not the target · ${esc(bug.notTarget)}</span>`;
}

// the letter of a bug, colored by what was found; ⚠ when only the fuzzer saw it
function LetterBadge(bug) {
  const what = `${TYPE_LABELS[bug.type] ?? bug.type}${bug.frames.length ? ': ' + bug.frames.join(' < ') : bug.summary ? ': ' + bug.summary : ''}`;
  const repro = bug.notReproduced ? ` (${bug.notReproduced} not reproduced by the replay)` : '';
  const notTarget = bug.notTarget ? ` — not the target of this job: ${bug.notTarget}` : '';
  return `<a class="type letter ${TypeClass(bug.type)}${bug.notTarget ? ' not-target-letter' : ''}" href="#bug-${bug.letter}" title="${esc(DisplayName(bug))}: ${esc(what)} (${bug.count} objectives${esc(repro)})${esc(notTarget)}">${esc(DisplayName(bug, true))}${Mismatch(bug) ? ' ⚠' : ''}</a>`;
}

// The expected bug of a configuration and how it is recognised (vuln_targets.json); without one, the CVEs tlspuffin
// declares for its build when the run recorded them (cli.vulnerabilities: recognised as 📋 known by their signature)
function ExpectedCell(report, library, run) {
  const rule = (t) => t.kind === 'claim' ? `the claim “${esc(t.match)}”` : `a crash with <code>${esc(t.match)}</code> among the top 3 frames`;
  // a custom benchmark's experiment: the catalogue's bug it looks for, by its oracle
  const custom = (report.runs ?? []).find(r => r.library === library && r.cli?.custom?.target)?.cli?.custom ?? run?.cli?.custom;
  if (custom?.target) {
    const stack = SignatureWithStack(custom.oracle, CatalogueEntry(custom.target)?.top_frames);
    return `<b>${EntryName(custom.target)}</b> <span class="muted">(the experiment's target)</span><div class="muted">its signature: ${esc(SignatureText(custom.oracle))}${stack ? ' (with top frames: strong on this page when the stack has them)' : ' (weak: no stack)'}; recognised by validation: by patch when it has one at this version, else by its signature</div>`;
  }
  const target = report.targets?.[library];
  if (target) {
    const alias = CVES?.[target.cve]?.alias;
    return `<b>${esc(alias ?? target.cve)}</b>${alias ? ` <span class="muted">${esc(target.cve)}</span>` : ''}<div class="muted">${rule(target)}</div>`;
  }
  const declared = run?.cli?.vulnerabilities?.declared;
  if (Array.isArray(declared)) {
    if (!declared.length) return '<span class="muted">none · no CVE declared for this build</span>';
    return `<span class="muted">none · declared for this build:</span> ${declared.map(cve => {
      const sig = report.cves?.[cve];
      return `<span${sig ? ` data-click-tip="${esc(`${cve}: recognised by ${sig.kind === 'claim' ? 'the claim “' + sig.match + '”' : 'a crash with ' + sig.match + ' among the top 3 frames'} (📋 known, not new)`)}"` : ' title="no signature in vuln_targets.json: not recognised"'}>${esc(sig?.alias ?? cve)}${sig ? '' : ' ?'}</span>`;
    }).join(', ')}`;
  }
  return '<span class="muted">none</span>';
}

// The expected bugs of the task (VulnA/VulnB: ExpectedRuns), first of the tiles: how many configurations found their
// expected bug and in how many runs, one chip per configuration. Green: every configuration in every run; amber: every
// configuration, not every run; orange: some configurations missed it; red: none found.
// The runs that did not succeed, every configuration ({library, attempt, why}), and how many runs have an outcome
function Failures(libraries) {
  const failures = (libraries ?? []).flatMap(lib => RunFailures(lib, REPORT_JOB_TYPE).map(f => ({ library: lib.library, ...f })));
  const runs = (libraries ?? []).reduce((sum, lib) => sum + Object.keys(lib.outcomes ?? {}).length, 0);
  return { failures, runs };
}

// 🎯 the final conclusion (bugs.js ExpectedConclusion, the same on Results): configurations that found their bug, in how
// many runs; green every run, amber not every run, red a configuration in no run. A run that found the bug without
// succeeding (timeout, no end-of-run summary) is counted, untimed: · k untimed on its chip, why on click
function ExpectedBanner(expectedRuns, libraries) {
  const conclusion = ExpectedConclusion(expectedRuns);
  if (!conclusion) return '';
  const { failures: every, runs } = Failures(libraries);
  // what went wrong (a run that did not find its bug in its time is not: its chip says k/n)
  const failures = every.filter(f => !f.expectedTimeout || expectedRuns?.[f.library]?.found.has(f.attempt));
  const chips = Object.entries(expectedRuns).map(([library, o]) => {
    const tip = ExpectedChipTip(library, o, { alias: CVES?.[o.target.cve]?.alias ?? '', noReplay: NoReplayTarget(o.target.cve, libraries),
        why: attempt => failures.find(f => f.library === library && f.attempt === attempt)?.why });
    return `<span class="exp-chip exp-${(o.provisional && o.level === 'all') ? 'provisional' : o.level}" data-click-tip="${esc(tip)}">${esc(library)} ${o.counted.size}/${o.runs.size}${o.untimed.length ? ` · ${o.untimed.length} untimed` : ''}</span>`;
  }).join('');
  // provisional (a live report: whether each run succeeds is known once the task ended): never green
  const level = (conclusion.provisional && conclusion.level === 'all') ? 'provisional' : conclusion.level;
  const bannerTip = `🎯 ${conclusion.hit} / ${conclusion.configurations}: configurations that found their expected bug in at least one run`
      + `\n${conclusion.counted}/${conclusion.runs} runs: runs that found it / runs`
      + (conclusion.untimed ? `\n${conclusion.untimed} untimed: counted, but the run did not end normally: no time to find in the statistics of Results` : '')
      + (conclusion.provisional ? '\nprovisional: the runs have not all ended' : '')
      + '\ncolour: green every run of every configuration, amber every configuration but not every run, red a configuration in no run'
      + '\nchips: one per configuration, click for its runs';
  return `<div class="expected-banner exp-${level}" data-click-tip="${esc(bannerTip)}"><b>🎯 ${conclusion.hit} / ${conclusion.configurations}</b> expected bug${conclusion.configurations > 1 ? 's' : ''} found <span class="exp-runs">${conclusion.counted}/${conclusion.runs} runs${conclusion.provisional ? ' · provisional' : ''}</span>${chips}`
      + (failures.length ? `<span class="exp-failed" data-click-tip="${esc(`⚠ ${failures.length} of ${runs} runs did not succeed\nwhy: no end-of-run summary, failed or cancelled, or found its bug without ending on it (runs that reached their timeout without their bug are not counted here: the chips say k/n)\nlist: below the banner, with the reason of each run`)}">⚠ ${failures.length} of ${runs} runs did not succeed</span>` : '') + '</div>';
}

// whether a target's objectives do not replay on their own (the report's record of the entry, else the catalogue: CDOS)
const NoReplayTarget = (cve, libraries) => [...(libraries ?? []).map(l => l.validation?.entries?.[cve]?.replayable), CatalogueEntry(cve)?.replayable,
    CVES?.[cve]?.replayable].find(r => r != null) === false;

// The 🎯 k/n of a configuration with a target in the runs column of the configurations, as its chip in the banner (the
// same count, colour and hover): green every run, amber some, red none
function ExpectedRunsChip(library, o) {
  if (!o) return '';
  const level = (o.provisional && o.level === 'all') ? 'provisional' : o.level;
  const failures = Failures(REPORT_LIBRARIES).failures;
  const tip = ExpectedChipTip(library, o, { alias: CVES?.[o.target.cve]?.alias ?? '', noReplay: NoReplayTarget(o.target.cve, REPORT_LIBRARIES),
      why: attempt => failures.find(f => f.library === library && f.attempt === attempt)?.why });
  return `<span class="exp-chip exp-${level}" data-click-tip="${esc(tip)}">🎯 ${o.counted.size}/${o.runs.size}${o.untimed.length ? ` · ${o.untimed.length} untimed` : ''}</span> · `;
}

// The runs that did not succeed because something went wrong, one line each with why, under the tiles: they are not in
// the statistics of Results (time to find, execs), which come from the end-of-run summaries; one that found the
// expected bug is counted in 🎯. Not a Vuln run that reached its timeout without its bug (expectedTimeout): the campaign
// did not find it in time, as the configurations table says
function FailuresNote(libraries, expectedRuns) {
  const all = Failures(libraries);
  const failures = all.failures.filter(f => !f.expectedTimeout || expectedRuns?.[f.library]?.found.has(f.attempt)), runs = all.runs;
  if (!failures.length) return '';
  const found = (f) => expectedRuns?.[f.library]?.found.has(f.attempt) ? 'found the expected bug, counted in 🎯 (untimed): ' : '';
  return `<div class="run-failures"><b>⚠ ${failures.length} of ${runs} runs did not succeed</b> (a run succeeds when it ends `
      + (REPORT_JOB_TYPE === 'perf' ? `by its timeout, as a Perf run should, with its end-of-run summary; only those are in the statistics of Results):`
          : `normally with its end-of-run summary; only those have a time to find in the statistics of Results; one that found the expected bug counts in 🎯 all the same):`)
      + `<ul>${failures.map(f => `<li><b>${esc(f.library)}</b> run ${esc(f.attempt)}: ${esc(found(f) + f.why)}</li>`).join('')}</ul></div>`;
}

// What the bug is for this task, under its symptom: the expected CVE, a CVE set apart, unexpected, new
function BugTags(bug) {
  return (bug.notTarget ? NotTargetBadge(bug) : '')
      + (bug.expected ? ` <span class="expected" data-click-tip="The bug this configuration is meant to find (its target): ${esc(bug.expected.join(', '))}">${TAGS.expected.mark} ${TAGS.expected.word} · ${esc(bug.expected.join(', '))}</span>` : '')
      + (bug.knownCve && !bug.validation?.kind ? ` <span class="known-cve" data-click-tip="${esc(bug.knownCveInferred
          ? `A CVE of the library this configuration built (${Object.keys(bug.knownCve).join(', ')}), whose signature in vuln_targets.json this bug matches: not a new bug.\nInferred: this build declared no CVEs (built before puffin-build), so the CVE comes from the CVE table of vuln_targets.json (library, signature), not from the build`
          : `A CVE that tlspuffin declares for what this configuration built (${Object.keys(bug.knownCve).join(', ')}: the build's vendorinfo, known minus fixed vulnerabilities), and whose signature in vuln_targets.json this bug matches: not a new bug`)}">${TAGS.known.mark} ${TAGS.known.word}${bug.knownCveInferred ? ' (inferred)' : ''} · ${esc([...new Set(Object.values(bug.knownCve))].join(', '))}</span>` : '')
      + (bug.unexpected ? ` <span class="unexpected" data-click-tip="${esc(`${TAGS.unexpected.tip}: a new finding, or a rule of vuln_targets.json to complete`)}">${TAGS.unexpected.mark} ${TAGS.unexpected.word}</span>` : '')
      + (bug.isNew ? ` <span class="new-bug-badge" data-click-tip="New for ${esc(bug.isNew.join(', '))}: with an expected bug, never seen there before this task (any earlier task: VulnA, VulnB, Perf, campaigns); in a plain version, none of the CVEs tlspuffin declares for that build">${TAGS.new.mark} ${TAGS.new.word}</span>` : '');
}

// The bugs as validation sees them, first of the tiles when the task was validated: confirmed by patch, by signature
// (weak apart), to review, without known signature (new-bug candidates), could not replay
function ValidationTiles(bugs) {
  const validated = bugs.filter(b => b.validation?.kind);
  if (!validated.length) return '';
  const has = (kind, f = () => true) => validated.filter(b => b.validation.parts.some(p => p.kind === kind && f(p))).length;
  const tile = (n, cls, text, tip) => n ? `<div class="tile ${cls}" data-click-tip="${esc(tip)}"><b>${count(n)}</b><span>${n === 1 ? text.replace(/^bugs /, 'bug ') : text}</span></div>` : '';
  return tile(has('patch'), 'val-tile', `bugs ${VERDICTS.patch.word}`, `${VERDICTS.patch.mark} ${VERDICTS.patch.tip}`)
    + tile(has('signature', p => !p.weak), 'val-tile', `bugs ${VERDICTS.signature.word} and stack`, `${VERDICTS.signature.mark} ${VERDICTS.signature.tip}\nstrong signature: ${TERMS.find(t => t[0] === 'strong signature')[1]}`)
    + tile(has('signature', p => p.weak), 'warn', `bugs by a weak signature`, `${VERDICTS.signature.mark} ${VERDICTS.signature.tip}\nweak signature: ${TERMS.find(t => t[0] === 'weak signature')[1]}`)
    + tile(has('unpatched') + has('other'), 'warn', 'to review', `${VERDICTS.unpatched.mark} ${VERDICTS.unpatched.tip}\n${VERDICTS.other.mark} ${VERDICTS.other.tip}`)
    + tile(has('new'), 'val-new-tile', 'without known signature', `${VERDICTS.new.mark} ${VERDICTS.new.tip}`)
    + tile(has('error'), 'warn', VERDICTS.error.word, `${VERDICTS.error.mark} ${VERDICTS.error.tip}`);
}

// The validation of the task in one line: the catalogue it rests on, the bench that validated, what went wrong (a
// configuration whose run has no validation result, failed controls, an error): below the tiles
function ValidationNote(libraries) {
  const validated = (libraries ?? []).filter(l => l.validation && !l.validation.unsupported);
  if (!validated.length) return '';
  const catalogue = validated.map(l => l.validation.catalogue).find(Boolean);
  const bench = BenchText(validated.flatMap(l => l.validation.bench ?? []).filter((b, i, all) =>
      all.findIndex(x => x.commit === b.commit && x.jobscripts === b.jobscripts) === i));
  const problems = validated.flatMap(l => [
    ...(l.validation.errors ?? []).map(e => `${l.library} run ${e.attempt}: ${e.error}`),
    ...(l.validation.controls_failed ?? []).map(a => `${l.library} run ${a}: the controls failed (verdicts not trusted)`),
  ]);
  return `<p class="note validation-note">Validation against tlspuffin's catalogue${catalogue
      ? ` (${catalogue.source === 'dev' ? 'dev' : 'the commit\'s own'} at <span class="mono">${esc(String(catalogue.commit ?? '').slice(0, 10))}</span>)` : ''}${bench ? ` · ${esc(bench)}` : ''}${problems.length
      ? ` · <span class="bad">⚠ ${problems.map(esc).join(' · ')}</span>` : ''}</p>`;
}

// What was found, then what the replay did with it. Mismatch: the fuzzer's record (its logs) is the evidence.
function TypeBadges(bug) {
  const type = `<span class="type ${TypeClass(bug.type)}">${esc(TYPE_LABELS[bug.type] ?? bug.type)}</span>`;
  const why = 'The fuzzer runs every input in one process (state of the library, memory layout); a replay starts a fresh process.';
  // a bug known not to replay (CDOS): as expected, no warning
  if (bug.noReplay?.length && !bug.reproduced) {
    return `${type}<span class="val val-no-replay" data-click-tip="${esc(`${VERDICTS['no-replay'].mark} ${VERDICTS['no-replay'].tip}`)}">${VERDICTS['no-replay'].mark} ${esc(VERDICTS['no-replay'].word)}</span>`;
  }
  if (Mismatch(bug)) {
    return `${type}<span class="mismatch" data-click-tip="The fuzzer's log shows this ${bug.fuzzer.kind === 'crash' ? 'crash' : 'claim violation'} when it saved these objectives, but no replay reproduces it (it runs without crash, or stops on an error of the library). ${why}">⚠ not reproduced by the replay</span>`;
  }
  if (Partly(bug)) {
    return `${type} <span class="mismatch" data-click-tip="The fuzzer saw the same bug for all these objectives; the replay reproduced ${bug.reproduced} of them. ${why}">⚠ ${count(bug.notReproduced)} not reproduced</span>`;
  }
  return type;
}

// the fuzzer's log, with the frames of its record highlighted
function FuzzerExcerptHTML(bug) {
  let html = esc(bug.fuzzer.excerpt);
  for (const frame of (bug.fuzzer.frames ?? []).slice(0, 1)) {
    html = html.split(esc(frame)).join(`<span class="hl">${esc(frame)}</span>`);
  }
  return html;
}

// the traces of the bug's objectives (kept next to the page): one link each, and all of them in one zip
function TracesHTML(bug) {
  if (!bug.traces?.length) return '';
  const missing = bug.count - bug.traces.length;
  const list = bug.traces.map(t => `<a class="trace mono" href="${esc(t.url)}" download="${esc(`${t.library}-${t.attempt}-${t.name}.trace`)}"
      title="${esc(t.library)} run ${esc(t.attempt)}">⬇ ${esc(t.library)}/${esc(t.attempt)}/${esc(t.name)}</a>`).join('');
  return `<div class="row traces-row"><span>traces</span><span>
      <button type="button" class="btn zip" data-bug="${esc(bug.letter)}" title="⬇ all traces\nfile: the traces of this bug kept next to the page, in one zip">⬇ all traces (zip, ${count(bug.traces.length)})</button>
      ${missing > 0 ? `<span class="muted">${count(missing)} more in the artefacts</span>` : ''}
      <details class="trace-list"><summary>one by one</summary>${list}</details></span></div>`;
}

// A zip of files without compression (method 0: traces are small), built in the browser: no server-side state
function Crc32(bytes) {
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}
function ZipStore(files) {  // files: [{ name, bytes: Uint8Array }]
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = Crc32(f.bytes), size = f.bytes.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint32(14, crc, true);
    local.setUint32(18, size, true); local.setUint32(22, size, true); local.setUint16(26, name.length, true);
    parts.push(local, name, f.bytes);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint32(16, crc, true);
    dir.setUint32(20, size, true); dir.setUint32(24, size, true); dir.setUint16(28, name.length, true); dir.setUint32(42, offset, true);
    central.push(dir, name);
    offset += 30 + name.length + size;
  }
  const centralSize = central.reduce((sum, p) => sum + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

async function DownloadBugTraces(bug, task, button) {
  const label = button.textContent;
  button.disabled = true;
  try {
    const files = [];
    for (const [i, t] of bug.traces.entries()) {
      button.textContent = `⬇ ${i + 1}/${bug.traces.length}…`;
      const response = await fetch(t.url);
      if (!response.ok) throw new Error(`${t.url}: HTTP ${response.status}`);
      files.push({ name: `${t.library}/${t.attempt}/${t.name}.trace`, bytes: new Uint8Array(await response.arrayBuffer()) });
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(ZipStore(files));
    link.download = `task-${task}-bug-${bug.letter}-traces.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    button.textContent = label;
  } catch (error) {
    button.textContent = `⚠ ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function BugRow(bug, open) {
  const where = bug.runs.map(run => `<span class="lib">${esc(run.library)} run ${esc(run.attempt)} ×${count(run.count)}</span>`).join('');
  const fz = bug.fuzzer;
  const reasons = [...(bug.reasons ?? new Map()).entries()].sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason || 'ran without error'} ×${n}`);
  const tries = [...(bug.tries ?? new Map()).entries()].map(([t, n]) => `${t} ×${n}`).join(', ');
  // objectives the replay does not confirm: what the fuzzer saw is the evidence
  const frames = bug.frames.length
      // a crash without sanitizer stack: the backtrace of the fuzzer's crash handler gives where it happened
      ? `${FramesHTML(bug.frames)}${bug.framesFromFuzzer ? ` <span class="muted">(fuzzer's backtrace, ${esc(fz.detail)})</span>` : ''}`
      : `<span class="muted">${esc(bug.summary || (bug.type === 'no-crash' ? 'the replay ran without crash nor violation' : ''))}</span>`;
  const replayed = bug.run?.replayed;
  return `<details class="bug" id="bug-${esc(bug.letter)}" data-kind="${bug.notTarget ? 'not-target' : bug.reproduced ? 'confirmed' : bug.noReplay?.length ? 'no-replay' : bug.fuzzer ? 'fuzzer' : bug.type}" ${open ? 'open' : ''}>
    <summary>
      <div class="count"><span class="bugletter"><span class="chev" title="Click: replay report and fuzzer log">▸</span> ${esc(DisplayName(bug))}</span>${count(bug.count)} <small>objective${bug.count > 1 ? 's' : ''}</small>${bug.notReproduced && bug.reproduced ? `<small class="nr">(${count(bug.notReproduced)} not reproduced)</small>` : ''}</div>
      <div>${TypeBadges(bug)}</div>
      <div class="symptom"><div class="frames" title="${esc((bug.frames.join(' < ') || bug.summary) + (reasons.length ? '\nnot reproduced: ' + reasons.join(', ') : ''))}">${frames}</div>${BugTags(bug) ? `<div class="bug-tags">${BugTags(bug)}</div>` : ''}${ValidationHTML(bug, LIVE)}</div>
      <div class="where">${where}</div>
    </summary>
    <div class="detail">
      <div class="logs">
        <div class="logtitle">replay${tries ? ` · tries: ${esc(tries)}` : ''}</div>
        <pre>${Excerpt(bug) || '<span class="muted">no report excerpt</span>'}</pre>
        ${fz?.excerpt ? `<div class="logtitle">fuzzer log, when it saved the objective</div><pre>${FuzzerExcerptHTML(bug)}</pre>` : ''}
      </div>
      <div class="side">
        ${bug.first_trace ? `<div class="row"><span>first trace</span><span class="mono">${esc(bug.library)}/${esc(bug.run?.attempt)}-objective/${esc(bug.first_trace)}.trace</span></div>` : ''}
        <div class="row"><span>build</span><span>${esc(Build(bug.run)) || '<span class="muted">?</span>'}</span></div>
        <div class="row"><span>ASAN</span><span>${Asan(bug.run)}</span></div>
        ${fz ? `<div class="row"><span>fuzzer saw</span><span class="mono">${esc(FuzzerText(fz))}</span></div>` : ''}
        ${reasons.length ? `<div class="row"><span>not reproduced</span><span class="mono">${esc(reasons.join(', '))}</span></div>` : ''}
        ${tries ? `<div class="row"><span>replay tries</span><span>${esc(tries)}</span></div>` : ''}
        ${bug.summary && bug.reproduced ? `<div class="row"><span>summary</span><span class="mono">${esc(bug.summary)}</span></div>` : ''}
        ${replayed != null ? `<div class="row"><span>run ${esc(bug.run?.attempt)} of ${esc(bug.library)}</span><span>${count(bug.run?.found)} found, ${count(replayed)} replayed</span></div>` : ''}
        ${TracesHTML(bug)}
        <button type="button" class="btn copy" title="📋 copy report\nclick: copies this report to the clipboard">📋 copy report</button>
      </div>
    </div>
  </details>`;
}

// "💾 save offline": one HTML file of the page as shown (its CSS inlined, no script: the bugs are <details>, they fold
// and unfold without it), every bug listed, the links absolute (task, results, traces lead to the bench)
async function SaveOffline(report, link) {
  const label = link.textContent;
  link.textContent = '💾 saving…';
  try {
    const page = document.documentElement.cloneNode(true);
    const css = await Promise.all([...document.querySelectorAll('link[rel="stylesheet"]')].map(async l => {
      const response = await fetch(l.href);
      return response.ok ? response.text() : '';
    }));
    page.querySelectorAll('script, link[rel="stylesheet"], .pb-nav, .pb-help').forEach(el => el.remove());
    const style = document.createElement('style');
    style.textContent = css.join('\n') + '\n.offline-note { color: var(--muted); font-size: 12px; margin: 8px 0 }';
    page.querySelector('head').appendChild(style);
    // no filters nor buttons without script: every bug, the traces by link
    page.querySelectorAll('.bar, .btn.copy, .page-tools').forEach(el => el.remove());
    page.querySelectorAll('.bug[hidden]').forEach(bug => bug.removeAttribute('hidden'));
    const here = location.href.split('#')[0];
    page.querySelectorAll('.btn.zip').forEach(button => {
      const a = document.createElement('a');
      a.href = `${here}#bug-${button.dataset.bug}`;
      a.textContent = '⬇ all traces (zip): on the bench';
      button.replaceWith(a);
    });
    page.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (!href.startsWith('#')) a.setAttribute('href', new URL(href, location.href).href);
    });
    const wrap = page.querySelector('.wrap');
    if (wrap) {
      const note = document.createElement('p');
      note.className = 'offline-note';
      note.innerHTML = `Saved on ${esc(new Date().toLocaleString())} from <a href="${esc(here)}">${esc(here)}</a>`
        + `${report.live ? ' while the task was running' : ''}: a snapshot; its links lead to the bench.`;
      wrap.prepend(note);
    }
    const blob = new Blob([`<!doctype html>\n${page.outerHTML}`], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `objectives-${report.live ? 'live-' : ''}${report.task}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    link.textContent = label;
  } catch (error) {
    link.textContent = `⚠ ${error.message}`;
  }
}

// When the bench's tools update a page: the round of the cron after a moment (every everyS seconds, at multiples of
// it), and the time its work may take (budgetS); null without the schedule (pages written before it was recorded)
function NextRound(afterS, everyS) { return Math.floor(afterS / everyS) * everyS + everyS; }
const Clock = (epochS) => new Date(epochS * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function NextLiveUpdate(refresh, nowS = Date.now() / 1000) {
  if (!refresh?.live_every_s) return null;
  const from = Math.max(nowS, refresh.updated_epoch ?? nowS);
  return NextRound(from, refresh.live_every_s) + (refresh.live_budget_s ?? 0);
}

// A placeholder (ObjectivesPlaceholders, PR_common.sh): the run's monitor wrote it at the first objective, so that its
// links lead somewhere; the bench's tools replace it. live: the first replays (objectives_live.sh); final: the report
// of the ended task (objectives_report.sh), the live page meanwhile. Reloads every minute until replaced.
async function RenderPlaceholder(root, report) {
  const nowS = Date.now() / 1000, r = report.refresh ?? {};
  const first = report.first_objective ? `first objective at ${esc(Clock(report.first_objective))}` : 'objectives found';
  let body;
  if (report.placeholder === 'live') {
    const by = NextLiveUpdate({ ...r, updated_epoch: nowS }, nowS);
    body = `<p class="note">⏳ The task has objectives (${first}). Their first replays are in progress: objectives_live.sh replays new
      objectives every ${Math.round((r.live_every_s ?? 300) / 60)} minutes on core 0, outside the fuzzing cores, and replaces this page
      ${by ? `by about <b>${esc(Clock(by))}</b>` : 'within minutes'}. The page reloads every minute.</p>`;
  } else {
    // running or ended: the scheduler says (a task it no longer knows has ended)
    const state = await fetch(`${SCHEDULER}/api/task/${encodeURIComponent(report.task)}/state`, { cache: 'no-store' })
        .then(response => response.ok ? response.json() : null).catch(() => null);
    const running = [...JSON.stringify(state ?? {}).matchAll(/"state":"(Running|Pending)"/g)].length > 0;
    const live = report.live_page ? `<a href="${esc(report.live_page)}">its live objectives page</a>` : 'its live objectives page';
    const every = r.report_every_s ?? 600;
    body = running
      ? `<p class="note">⏳ The task is running (${first}): ${live} shows them, replayed and grouped by bug. This page becomes
          its final report within ${Math.round(every / 60)} minutes of the end of the task.</p>`
      : `<p class="note pending-final">⏳ The task ended (${first}). Its final report (objectives_report.sh, every ${Math.round(every / 60)}
          minutes: every objective replayed and classified) is being written: the round of about <b>${esc(Clock(NextRound(nowS, every)))}</b>
          writes it, in a few minutes. Meanwhile: ${live}. The page reloads every minute.</p>`;
  }
  root.innerHTML = `<div class="top"><h1>Objectives of task ${esc(report.task)}${report.commit ? ` · <span class="mono">${esc(String(report.commit).slice(0, 10))}</span>` : ''}</h1>
      <div class="meta">${report.task_url ? `<a href="${esc(report.task_url)}" target="_blank" rel="noopener">task on the board</a>` : ''}</div></div>
    <div class="wrap">${body}</div>`;
  document.title = `Objectives · task ${report.task} · being written`;
  setInterval(() => { if (!document.querySelector('.pb-help.open')) location.reload(); }, 60000);
}

async function Render() {
  const root = document.getElementById('report');
  const source = root.dataset.json;
  let report;
  try {
    const response = await fetch(source, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    report = await response.json();
  } catch (error) {
    root.innerHTML = `<div class="wrap"><p class="unconf">Cannot read ${esc(source)}: ${esc(error.message)}</p></div>`;
    return;
  }
  if (report.placeholder) { await RenderPlaceholder(root, report); return; }
  const runs = report.runs ?? [];
  LIVE = !!report.live;
  REPORT_LIBRARIES = report.libraries ?? [];
  REPORT_JOB_TYPE = report.job_type ?? null;
  // the signatures of the bugs validation knew (its record), before the catalogue's
  ENTRY_ORACLES = Object.assign({}, ...(report.libraries ?? []).map(l => Object.fromEntries(
      Object.entries(l.validation?.entries ?? {}).map(([id, e]) => [id, e?.oracle]).filter(([, o]) => o))));
  // 🚨 new bugs: never seen for their library before this task (known_bugs.json next to the reports)
  const known = await fetch('known_bugs.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
  CVES = await LoadCves();
  // validation against tlspuffin's catalogue: the catalogue it used (else the task's commit's), then each bug's verdict
  const catalogueCommit = (report.libraries ?? []).map(l => l.validation?.catalogue?.commit).find(Boolean) ?? report.commit;
  if (/^[0-9a-f]{7,40}$/.test(String(catalogueCommit ?? ''))) {
    CATALOGUE = await fetch(`${GIT_RESTAPI}/api/git/catalogue/tlspuffin/${catalogueCommit}`, { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null).then(c => c?.format === 'vulnerabilities.toml' ? c : null).catch(() => null);
  }
  // what the task found, as Results and History tell it (bugs.js AnalyseReport): the expected bug of each configuration
  // (vuln_targets.json's, a custom benchmark experiment's), the bugs and their validation verdicts, the new ones
  // (validation first, then the earlier tasks and the CVEs of each build), the 🎯 runs, the headline and level
  const { targets, bugs, newBugs, expectedRuns, headline } = AnalyseReport(report, known, CATALOGUE);
  // objectives whose bug cannot be told (the tile says how many and why)
  const uncategorised = Uncategorised(runs, !!(report.live || report.pending_final));
  // VulnA/VulnB: bugs that are not the job's target (another known CVE) are counted apart
  const confirmed = bugs.filter(bug => bug.reproduced > 0 && !bug.notTarget);
  const notTargetBugs = bugs.filter(bug => bug.notTarget);
  const notTargetObjectives = notTargetBugs.reduce((sum, bug) => sum + bug.count, 0);
  const found = runs.reduce((sum, run) => sum + (run.found ?? 0), 0);
  const replayed = runs.reduce((sum, run) => sum + (run.replayed ?? 0), 0);
  const reproduced = runs.reduce((sum, run) => sum + (run.reports ?? 0), 0);
  const libraries = report.libraries?.length ? report.libraries.map(lib => lib.library) : [...new Set(runs.map(run => run.library))];
  // configurations with a bug: recorded by the fuzzer or reproduced by a replay (a bug that never replays, such as CDOS's
  // crash in the session cache, is still a bug found), and among them those a replay reproduced; CVEs set apart excluded
  const real = bugs.filter(bug => !bug.notTarget && (bug.reproduced > 0 || bug.fuzzer));
  const hit = [...new Set(real.flatMap(bug => bug.runs.map(run => run.library)))];
  const hitConfirmed = [...new Set(real.flatMap(bug => bug.runs.filter(run => run.reproduced > 0).map(run => run.library)))];
  // objectives of bugs no replay confirms and the fuzzer did not record (no log, older tasks)
  const unconfirmedCount = (type) => bugs.filter(bug => !bug.reproduced && !bug.fuzzer && bug.type === type).reduce((sum, bug) => sum + bug.count, 0);
  bugs.forEach((bug, i) => { bug.letter = Letter(i); });
  // seen only by the fuzzer, but the bugs known not to replay (CDOS: as expected)
  const fuzzerOnly = bugs.filter(bug => Mismatch(bug) && !bug.notTarget && !bug.noReplay?.length);
  // the bugs known not to replay that no replay reproduced (CDOS): their own filter, shown
  const knownNoReplay = bugs.filter(bug => !bug.notTarget && !bug.reproduced && bug.noReplay?.length);
  const fuzzerOnlyObjectives = fuzzerOnly.reduce((sum, bug) => sum + bug.count, 0);
  // every objective the replay does not reproduce while the fuzzer recorded it (also within reproduced bugs)
  const notReproducedWithRecord = bugs.filter(bug => bug.fuzzer).reduce((sum, bug) => sum + bug.notReproduced, 0);

  // the title: the new bugs, the real ones, with the marks of the task's level (bugs.js BugsHeadline)
  const news = ['new', 'unexpected'].includes(headline.level);
  const title = headline.text ?? (found > 0 ? 'Objectives found, no bug reproduced' : 'No objective');
  document.title = `${title} · task ${report.task}`;
  const span = report.started && report.ended ? Duration(new Date(report.ended) - new Date(report.started)) : '';
  const links = [
    report.task_url ? `<a href="${esc(report.task_url)}" target="_blank" rel="noopener">task on the board</a>` : '',
    `<a href="${PUBLISHER}/files/tlspuffin" target="_blank" rel="noopener">results</a>`,
    report.live ? '' : `<a href="${SCHEDULER}/api/task/${esc(report.task)}/artefacts">⬇️ artefacts (zip)</a>`,
    `<a href="${esc(source)}" target="_blank" rel="noopener">JSON</a>`,
  ].filter(Boolean).join(' · ')
    // tools of the page, left out of a saved copy
    + ` · <a href="${BUGS_PAGE}" target="_blank" rel="noopener" title="The expected bug of each configuration, the CVEs set apart (the file to edit) and the bugs found so far per library">🎯 bugs reference</a>`
    + `<span class="page-tools"> · <a href="#" id="save-offline" title="One HTML file of this page as shown, to keep or send: bugs fold and unfold, the links lead to the bench">💾 save offline</a>`
    + ` · <a href="#" id="print-page" title="Print, or save as PDF from the print dialog: every bug of the current filter unfolded">🖨 print / PDF</a></span>`;

  root.innerHTML = `
    <div class="top">
      <h1>${title} · <span id="commit-line"><span class="mono">${esc(String(report.commit ?? '').slice(0, 10))}</span></span></h1>
      <div class="meta">${esc(report.name)}${report.user ? ` · ${esc(report.user)}` : ''}
        ${report.started ? ` · ran ${esc(DateTime(report.started))}${report.ended ? ` → ${esc(DateTime(report.ended))}` : ''}${span ? ` (${span})` : ''}` : ''}
        ${report.cancelled ? ' · <span class="bad">cancelled</span>' : ''}
        ${report.live ? ` · <span class="live">● live · updated ${esc(report.updated)}${(n => n ? ` · next update by about ${esc(Clock(n))}` : '')(NextLiveUpdate(report.refresh))}</span>` : ''} · ${links}</div>
      <div class="tiles">
        ${ExpectedBanner(expectedRuns, report.libraries)}
        ${ValidationTiles(bugs)}
        <div class="tile ${confirmed.length && news ? 'gold' : ''}" data-click-tip="${esc(`distinct bugs reproduced\n${TERMS.find(t => t[0] === 'reproduced')[1]}`)}"><b>${count(confirmed.length)}</b><span>distinct bug${confirmed.length === 1 ? '' : 's'} reproduced</span></div>
        ${uncategorised.total ? `<div class="tile warn uncat-tile" data-click-tip="${esc(UncategorisedText(uncategorised))}"><b>❓ ${count(uncategorised.total)}</b> without category</div>` : ''}
      ${uncategorised.pending ? `<div class="tile pending-tile" data-click-tip="${esc(UncategorisedText(uncategorised, null, true))}"><b>⏳ ${count(uncategorised.pending)}</b> not processed yet</div>` : ''}
      ${fuzzerOnly.length ? `<div class="tile warn" data-click-tip="Objectives whose replay does not reproduce what the fuzzer saw (crash or claim violation, from its logs)"><b>${count(fuzzerOnly.length)}</b><span>seen only by the fuzzer (${count(fuzzerOnlyObjectives)} objectives)</span></div>` : ''}
        ${notTargetBugs.length ? `<div class="tile" data-click-tip="Bugs that are not the CVE this job looks for (${esc([...new Set(notTargetBugs.map(b => b.notTarget))].join(', '))}): listed after the targeted ones, not counted in the configurations hit"><b>${count(notTargetBugs.length)}</b><span>not the target (${count(notTargetObjectives)} objectives)</span></div>` : ''}
        <div class="tile"><b>${count(found)}</b><span>objectives found</span></div>
        <div class="tile"><b>${count(replayed)}</b><span>replayed · ${count(reproduced)} reproduced</span></div>
        ${Object.keys(expectedRuns).length ? '' /* the 🎯 tile says it (bugs found by the fuzzer, reproduced by a replay or not) */
          : `<div class="tile" data-click-tip="${esc(`with a bug recorded by the fuzzer or reproduced by a replay: ${hit.join(', ') || 'none'}\nreproduced by a replay: ${hitConfirmed.join(', ') || 'none'}`)}"><b>${hit.length} / ${libraries.length}</b><span>configurations with a bug${hit.length ? ` (${hitConfirmed.length} reproduced)` : ''}</span></div>`}
      </div>
    </div>
    <div class="wrap">
      ${ValidationNote(report.libraries)}
      ${FailuresNote(report.libraries, expectedRuns)}
      ${report.live ? '<p class="note">Task running: objectives are replayed every few minutes on core 0, outside the fuzzing cores. The page reloads every minute.</p>' : ''}
      ${report.pending_final ? '<p class="note pending-final">⏳ The task ended: this is its last live page. The final report (every objective classified, the replays of the task) is being written and replaces it within minutes; the page reloads every minute.</p>' : ''}
      <h2>Configurations</h2>
      <div class="card"><table class="libtable"><tr><th>configuration</th><th>expected bug · recognised by</th><th>build</th><th>ASAN</th><th>runs</th><th>objectives</th><th>bugs</th></tr>
        ${libraries.map(library => {
          const libRuns = runs.filter(run => run.library === library);
          // its bugs: confirmed by the replay, or seen only by the fuzzer (⚠)
          const libBugs = bugs.filter(bug => bug.runs.some(run => run.library === library) && (bug.reproduced > 0 || !!bug.fuzzer));
          const total = report.libraries?.find(lib => lib.library === library)?.runs;
          const libFound = libRuns.reduce((sum, run) => sum + (run.found ?? 0), 0);
          const libReproduced = libRuns.reduce((sum, run) => sum + (run.reports ?? 0), 0);
          const first = libRuns[0] ?? report.libraries?.find(lib => lib.library === library);
          // runs that succeeded (the task's summary), the others with why on click
          const libEntry = report.libraries?.find(lib => lib.library === library);
          const failed = RunFailures(libEntry, report.job_type), outcomes = Object.keys(libEntry?.outcomes ?? {}).length;
          const succeeded = !outcomes ? ''
              : failed.length ? ` · <span class="runs-failed" data-click-tip="${esc(`${outcomes - failed.length} of ${outcomes} runs succeeded; did not succeed:\n` + failed.map(f => `run ${f.attempt}: ${f.why}`).join('\n'))}">⚠ ${outcomes - failed.length} succeeded</span>`
              : ` · <span data-click-tip="${esc(`succeeded\nruns: ended normally with their end-of-run summary, which saw what their job scripts looked for${expectedRuns[library]?.preTarget ? '\nbefore targets: the job scripts had no expected bug (before 2026-10-07), any objective' : ''}`)}">${outcomes} succeeded${expectedRuns[library]?.preTarget ? ' (before targets: any objective)' : ''}</span>`;
          return `<tr><td><b>${esc(library)}</b></td><td>${ExpectedCell(report, library, first)}</td><td>${esc(Build(first)) || '<span class="muted">?</span>'}</td><td>${Asan(first)}</td>
            <td>${ExpectedRunsChip(library, expectedRuns[library])}<span data-click-tip="with objectives\nruns: that saved at least one objective (any bug) / runs">${total != null ? `${libRuns.length} with objectives / ${total}` : libRuns.length}</span>${succeeded}</td>
            <td>${libFound ? `${count(libFound)} (${count(libReproduced)} reproduced)` : '0'}</td>
            <td>${libBugs.map(bug => LetterBadge(bug) + (bug.expectedFor?.has(library) && targets[library]
                ? ` <span class="expected" data-click-tip="${esc(`The bug this configuration is meant to find (${targets[library].custom ? 'the experiment\'s target' : 'vuln_targets.json'}): ${TargetText(targets[library])}`)}">${TAGS.expected.mark} ${TAGS.expected.word} · ${esc(targets[library].cve)}</span>` : '')).join(' ') || '—'}</td></tr>`;
        }).join('')}</table></div>
      ${bugs.length ? `
      <div class="bar">
        <button type="button" class="chip" id="chip-all">All (${bugs.length})</button>
        <button type="button" class="chip on" data-kind="confirmed">reproduced bugs (${confirmed.length})</button>
        ${fuzzerOnly.length ? `<button type="button" class="chip on" data-kind="fuzzer">⚠ seen only by the fuzzer (${fuzzerOnly.length})</button>` : ''}
        ${knownNoReplay.length ? `<button type="button" class="chip on" data-kind="no-replay" title="${esc(VERDICTS['no-replay'].tip)}">${VERDICTS['no-replay'].mark} ${esc(VERDICTS['no-replay'].word)} (${knownNoReplay.length})</button>` : ''}
        ${notTargetBugs.length ? `<button type="button" class="chip on" data-kind="not-target">not the target (${notTargetBugs.length})</button>` : ''}
        <button type="button" class="chip ${confirmed.length || fuzzerOnly.length ? '' : 'on'}" data-kind="no-crash">not reproduced, no fuzzer record (${count(unconfirmedCount('no-crash'))})</button>
        <button type="button" class="chip ${confirmed.length || fuzzerOnly.length ? '' : 'on'}" data-kind="replay-error">replay errors (${count(unconfirmedCount('replay-error'))})</button>
        <span class="grow"></span>
        <button type="button" class="chip" id="toggle-all">unfold all</button>
      </div>
      <h2>Bugs, by number of objectives</h2>
      <div class="card" id="bugs">${bugs.map(bug => BugRow(bug, false)).join('')}</div>
      ` : ''}
      ${UnconfirmedNote(found, replayed, bugs.reduce((sum, bug) => sum + (bug.replayType === 'no-crash' || bug.fuzzer ? bug.notReproduced : 0), 0), unconfirmedCount('replay-error'), confirmed.length, notReproducedWithRecord)}
    </div>`;

  // filters: the kinds of bugs shown
  const shown = new Set([...root.querySelectorAll('.chip.on[data-kind]')].map(chip => chip.dataset.kind));
  const apply = () => root.querySelectorAll('.bug').forEach(bug => { bug.hidden = !shown.has(bug.dataset.kind); });
  const kindChips = [...root.querySelectorAll('.chip[data-kind]')];
  const allChip = root.querySelector('#chip-all');
  const syncAll = () => allChip?.classList.toggle('on', kindChips.every(chip => chip.classList.contains('on')));
  // All: every kind shown; again: back to the reproduced bugs and those seen only by the fuzzer
  allChip?.addEventListener('click', () => {
    const all = !allChip.classList.contains('on');
    kindChips.forEach(chip => {
      const on = all || ['confirmed', 'fuzzer', 'no-replay'].includes(chip.dataset.kind);
      chip.classList.toggle('on', on);
      on ? shown.add(chip.dataset.kind) : shown.delete(chip.dataset.kind);
    });
    syncAll();
    apply();
  });
  kindChips.forEach(chip => chip.addEventListener('click', () => {
    chip.classList.toggle('on');
    chip.classList.contains('on') ? shown.add(chip.dataset.kind) : shown.delete(chip.dataset.kind);
    syncAll();
    apply();
  }));
  apply();
  // a bug letter of the configurations table: show that bug (its chip on if it was filtered out), open, in view
  const ShowBug = (id, smooth = true) => {
    const bug = /^#bug-[A-Z]+$/.test(id) ? root.querySelector(id) : null;
    if (!bug) return false;
    const chip = root.querySelector(`.chip[data-kind="${bug.dataset.kind}"]`);
    if (chip && !chip.classList.contains('on')) chip.click();
    bug.hidden = false;
    bug.open = true;
    bug.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    return true;
  };
  root.querySelectorAll('a.letter').forEach(link => link.addEventListener('click', (event) => {
    if (!ShowBug(link.getAttribute('href'))) return;
    event.preventDefault();
    history.replaceState(null, '', link.getAttribute('href'));
  }));
  // a link to one bug (…/<task>.html#bug-C)
  ShowBug(location.hash, false);
  // Esc (top bar, board/nav.js): fold the open bugs
  window.addEventListener('pb-escape', (event) => {
    if ((event.detail?.layer !== 'panel') || event.defaultPrevented) return;
    const open = root.querySelectorAll('.bug[open]');
    if (!open.length) return;
    event.preventDefault();
    open.forEach(bug => { bug.open = false; });
  });
  root.querySelector('#toggle-all')?.addEventListener('click', (event) => {
    const open = event.target.textContent === 'unfold all';
    root.querySelectorAll('.bug:not([hidden])').forEach(bug => { bug.open = open; });
    event.target.textContent = open ? 'fold all' : 'unfold all';
  });
  root.querySelector('#save-offline')?.addEventListener('click', (event) => { event.preventDefault(); SaveOffline(report, event.target); });
  root.querySelector('#print-page')?.addEventListener('click', (event) => { event.preventDefault(); window.print(); });
  // printing: the bugs of the current filter unfolded, then as they were
  let folded = [];
  window.addEventListener('beforeprint', () => {
    folded = [...root.querySelectorAll('.bug:not([hidden]):not([open])')];
    folded.forEach(bug => { bug.open = true; });
  });
  window.addEventListener('afterprint', () => { folded.forEach(bug => { bug.open = false; }); folded = []; });
  root.querySelectorAll('.bug .zip').forEach(button => button.addEventListener('click', () => {
    const bug = bugs.find(b => b.letter === button.dataset.bug);
    if (bug) DownloadBugTraces(bug, report.task, button);
  }));
  root.querySelectorAll('.bug .copy').forEach(button => button.addEventListener('click', async () => {
    const text = [...button.closest('.bug').querySelectorAll('pre')].map(pre => pre.textContent).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = '✓ copied';
    } catch (error) {
      button.textContent = 'copy failed';
    }
  }));

  // the commit line: commit, PR and message (git_restapi)
  if (report.commit) {
    const desc = (await resolveCommits(GIT_RESTAPI, 'tlspuffin', [report.commit]).catch(() => null))?.get(report.commit);
    if (desc && desc.kind !== 'unknown') {
      const { type } = parseTaskName(report.name ?? '', report.commit);
      document.getElementById('commit-line').innerHTML =
          commitLineHTML(desc, { prefix: type || PREFIXES[report.job_type] || '', max: 80 });
    }
  }
  // the live page reloads every minute, unless the help is open
  if (report.live || report.pending_final) {
    setInterval(() => { if (!document.querySelector('.pb-help.open')) location.reload(); }, 60000);
  }
}

Render();
