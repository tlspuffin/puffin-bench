// Objectives page of a task (objectives_report.sh: final, objectives_live.sh: while it runs), rendered from the
// JSON written next to it ({ task, commit, name, live?, updated?, user?, job_type?, started?, ended?, cancelled?,
// task_url?, libraries?, runs: [{ library, attempt, found, replayed, reports, groups, cli, asan }] }).
// The page is organized by bug: the groups of every run with the same type and stack frames are one bug.

import '../board/nav.js';
import { resolveCommits, parseTaskName, commitLineHTML } from '../common/commitinfo.js';
import { UNCONFIRMED, TYPE_LABELS, Bugs, ExpectedRuns, NewBugs, FuzzerText, Mismatch, Partly, Letter, Uncategorised, UncategorisedText, BugName, ShortName, LoadCves, RunFailures, ExpectedConclusion, ExpectedChipTip } from './bugs.js';

// the CVE table of the bugs reference: the names of the bugs (BugName)
let CVES = null;
// the configurations of the report shown (report.libraries): runs, outcomes, ends, errors of the end-of-run summaries
let REPORT_LIBRARIES = [];

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
      bugs found (and how many a replay confirmed), the commit of the task (short hash, PR, message).</li>
    <li>Task name, user, start → end (duration), links: the task on the Scheduler, the Results, ⬇️ the artefacts (finished
      task), the JSON this page is drawn from, <b>🎯 bugs reference</b> (the expected bugs, the CVEs set apart, the bugs
      found so far), 💾 save offline (one HTML file), 🖨 print / PDF.</li>
    <li>Tiles: distinct bugs · objectives found · replayed and reproduced · VulnA: <b>🎯 runs that found the expected bug</b>
      per configuration; other jobs: configurations with a bug (and how many a replay confirmed).</li>
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
      <span class="type none">replay error</span> (timed out or could not run) are not confirmed bugs.</li>
  </ul>

  <h2>Expected, set apart, unexpected, new</h2>
  <ul>
    <li><span class="expected">🎯 expected · CVE</span>: the bug this VulnA configuration is meant to find (the bug row and the
      Configurations table). Its run ends on it.</li>
    <li><b>⦸</b> set apart: a known CVE of the old library versions that is never a target, on those versions only (CVE-2024-5814: wolfSSL &lt; 5.7.2; on any other library or version its claim is a bug); it does not
      end a run.</li>
    <li><span class="unexpected">⚠ unexpected</span>: in a configuration with a target, a bug that is neither: a new finding,
      or a rule to add to the targets file.</li>
    <li><span class="new-bug-badge">🚨 NEW BUG</span>: a real bug (fuzzer record or replay), neither expected nor set apart.
      In a configuration with an expected bug (an alias: BUF, SKIP…): its signature (its claim, or the top function of its
      crash) no earlier task had in that configuration, whatever the job. In a plain version (e.g. Perf's wolfSSL 5.8.0):
      not one of the CVEs tlspuffin declares for that build, whose signature is in vuln_targets.json (then
      <span class="known-cve">📋 known · CVE</span>); it stays new on every task until it is added there. The targets, the
      CVEs and the bugs found so far: <a href="/html/publisher/bugs.html">🎯 Bugs reference</a>.</li>
  </ul>

  <h2>❓ Without category</h2>
  <p>The tile <b>❓ N without category</b> counts the objectives whose bug cannot be told: no replay confirmed them and the
    fuzzer's log has no record of them (no log in the artefacts, or the record lost to log rotation and no other
    objective with the same input), or a crash without location. Click it: how many per configuration and why. They
    could hide a bug. On a live page, <b>⏳ N not processed yet</b> (faint) counts apart the objectives not replayed yet:
    waiting resolves them (the final report classifies every objective).</p>

  <h2>Using the page</h2>
  <ul>
    <li>Chips: show the confirmed bugs, the not reproduced and the replay errors; <b>unfold all</b> opens every bug.</li>
    <li>A bug row: number of objectives, type, top frames (the frame in red is where it happened), the runs it came from
      (configuration, run, count). Unfolded: the report of one replay, its build and ASAN state, 📋 to copy the report.</li>
    <li><b>Configurations</b>: per configuration, its expected bug and how it is recognised (vuln_targets.json; without
      one, the CVEs tlspuffin declares for its build, recognised as 📋 known), its build, ASAN, runs with objectives and
      runs that succeeded, objectives and bugs found.</li>
    <li><b>🎯 banner</b>, the same conclusion as Results: configurations that found their expected bug, in how many
      runs. Only runs that succeeded count: a run succeeds when it ends normally with its end-of-run summary, which saw
      the bug; only those are in the statistics of Results (time to find, execs). Green: every run of every
      configuration; amber: every configuration, not every run; red: a configuration in no run. <b>+k failed</b>: runs that
      found the bug without succeeding (ended by their timeout, no end-of-run summary), listed below the banner with why.</li>
    <li>Traces: <b>⬇ all traces (zip)</b> on an unfolded bug; the full reports are in the artefacts,
      <code>&lt;configuration&gt;/&lt;run&gt;-objective</code> and <code>-objective-reports</code>.</li>
  </ul>
  <p>Details: the <b>box cursor</b> means a click opens a small window (badges, tiles); the <b>? cursor</b>, a link or a
    button: hover. Press <b>?</b> to toggle this panel.</p>`;
document.head.appendChild(help);

const PREFIXES = { 'perf': 'Perf', 'vuln-a': 'VulnA', 'vuln-b': 'VulnB', 'campaign': 'Camp' };

const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const count = (value) => Number(value ?? 0).toLocaleString('en-US');

function TypeClass(type) {
  if (UNCONFIRMED.has(type)) return 'none';
  if (type === 'security-violation') return 'sec';
  if (type === 'panic') return 'panic';
  return 'asan';
}

// as soon as one objective is not confirmed by its replay: how many, and why it matters (the legend of the types is
// in the help panel)
function UnconfirmedNote(found, replayed, notReproduced, errors, confirmedBugs, fuzzerOnly = 0) {
  if (notReproduced + errors === 0 && replayed >= found) return '';
  const parts = [
    notReproduced ? `${count(notReproduced)} not reproduced (the replay did not reach the bug)` : '',
    errors ? `${count(errors)} replay error${errors > 1 ? 's' : ''} (timed out or could not run)` : '',
    found > replayed ? `${count(found - replayed)} not replayed${confirmedBugs || notReproduced || errors ? '' : ' yet'}` : '',
  ].filter(Boolean);
  const head = confirmedBugs === 0 && found > 0 ? 'Objectives were found, but no replay confirmed a bug' : `Of ${count(found)} objectives`;
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
  if (run?.asan === true) return '<span class="ok" title="✓ ASAN\nbuild: the library is built with ASAN (AddressSanitizer)">✓</span>';
  if (run?.asan === false) return '<span class="bad" title="✗ not instrumented\nbuild: the library is built without ASAN\nso: memory errors are found only when they crash">✗ not instrumented</span>';
  return '<span class="muted" title="? ASAN\nbuild: did not record whether ASAN is on">?</span>';
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
  return `<a class="type letter ${TypeClass(bug.type)}${bug.notTarget ? ' not-target-letter' : ''}" href="#bug-${bug.letter}" title="${esc(BugName(bug, CVES))}: ${esc(what)} (${bug.count} objectives${esc(repro)})${esc(notTarget)}">${esc(ShortName(bug, CVES))}${Mismatch(bug) ? ' ⚠' : ''}</a>`;
}

// The expected bug of a configuration and how it is recognised (vuln_targets.json); without one, the CVEs tlspuffin
// declares for its build when the run recorded them (cli.vulnerabilities: recognised as 📋 known by their signature)
function ExpectedCell(report, library, run) {
  const rule = (t) => t.kind === 'claim' ? `the claim “${esc(t.match)}”` : `a crash with <code>${esc(t.match)}</code> among the top 3 frames`;
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
// The runs not counted as succeeded, every configuration ({library, attempt, why}), and how many runs have an outcome
function Failures(libraries) {
  const failures = (libraries ?? []).flatMap(lib => RunFailures(lib).map(f => ({ library: lib.library, ...f })));
  const runs = (libraries ?? []).reduce((sum, lib) => sum + Object.keys(lib.outcomes ?? {}).length, 0);
  return { failures, runs };
}

// 🎯 the final conclusion (bugs.js ExpectedConclusion, the same on Results): configurations that found their bug, in how
// many runs that succeeded; green every run, amber not every run, red a configuration in no run. A run that found the
// bug without succeeding (timeout, no end-of-run summary) is not counted: +k failed on its chip, why on click
function ExpectedBanner(expectedRuns, libraries) {
  const conclusion = ExpectedConclusion(expectedRuns);
  if (!conclusion) return '';
  const { failures, runs } = Failures(libraries);
  const chips = Object.entries(expectedRuns).map(([library, o]) => {
    const tip = ExpectedChipTip(library, o, { alias: CVES?.[o.target.cve]?.alias ?? '',
        why: attempt => failures.find(f => f.library === library && f.attempt === attempt)?.why });
    return `<span class="exp-chip exp-${(o.provisional && o.level === 'all') ? 'provisional' : o.level}" data-click-tip="${esc(tip)}">${esc(library)} ${o.counted.size}/${o.runs.size}${o.lost.length ? ` +${o.lost.length} failed` : ''}</span>`;
  }).join('');
  // provisional (a live report: whether each run succeeds is known once the task ended): never green
  const level = (conclusion.provisional && conclusion.level === 'all') ? 'provisional' : conclusion.level;
  const bannerTip = `🎯 ${conclusion.hit} / ${conclusion.configurations}: configurations that found their expected bug in at least one run that succeeded`
      + `\n${conclusion.counted}/${conclusion.runs} runs: runs that found it and succeeded / runs (only those are in the statistics of Results)`
      + (conclusion.provisional ? '\nprovisional: the runs have not all ended; the final report counts only the runs that found the bug and succeeded' : '')
      + '\ncolour: green every run of every configuration, amber every configuration but not every run, red a configuration in no run'
      + '\nchips: one per configuration, click for its runs';
  return `<div class="expected-banner exp-${level}" title="${esc(bannerTip)}"><b>🎯 ${conclusion.hit} / ${conclusion.configurations}</b> expected bug${conclusion.configurations > 1 ? 's' : ''} found <span class="exp-runs">${conclusion.counted}/${conclusion.runs} runs${conclusion.provisional ? ' · provisional' : ''}</span>${chips}`
      + (failures.length ? `<span class="exp-failed" data-click-tip="${esc(`⚠ ${failures.length} of ${runs} runs did not succeed\nwhy: ended by their timeout, or no end-of-run summary\nlist: below the banner, with the reason of each run`)}">⚠ ${failures.length} of ${runs} runs did not succeed</span>` : '') + '</div>';
}

// The 🎯 k/n of a configuration with a target in the runs column of the configurations, as its chip in the banner (the
// same count, colour and hover): green every run, amber some, red none
function ExpectedRunsChip(library, o) {
  if (!o) return '';
  const level = (o.provisional && o.level === 'all') ? 'provisional' : o.level;
  const failures = Failures(REPORT_LIBRARIES).failures;
  const tip = ExpectedChipTip(library, o, { alias: CVES?.[o.target.cve]?.alias ?? '',
      why: attempt => failures.find(f => f.library === library && f.attempt === attempt)?.why });
  return `<span class="exp-chip exp-${level}" data-click-tip="${esc(tip)}">🎯 ${o.counted.size}/${o.runs.size}${o.lost.length ? ` +${o.lost.length} failed` : ''}</span> · `;
}

// The runs not counted as succeeded, one line each with why, under the tiles: they are not in the statistics of Results
// (time to find, execs), whatever they found
function FailuresNote(libraries, expectedRuns) {
  const { failures, runs } = Failures(libraries);
  if (!failures.length) return '';
  const found = (f) => expectedRuns?.[f.library]?.found.has(f.attempt) ? 'found the expected bug, not counted: ' : '';
  return `<div class="run-failures"><b>⚠ ${failures.length} of ${runs} runs did not succeed</b> (a run succeeds when it ends `
      + `normally with its end-of-run summary; only those are in the statistics of Results, whatever the others found):`
      + `<ul>${failures.map(f => `<li><b>${esc(f.library)}</b> run ${esc(f.attempt)}: ${esc(found(f) + f.why)}</li>`).join('')}</ul></div>`;
}

// What the bug is for this task, under its symptom: the expected CVE, a CVE set apart, unexpected, new
function BugTags(bug) {
  return (bug.notTarget ? NotTargetBadge(bug) : '')
      + (bug.expected ? ` <span class="expected" data-click-tip="The bug this configuration is meant to find (vuln_targets.json): ${esc(bug.expected.join(', '))}">🎯 expected · ${esc(bug.expected.join(', '))}</span>` : '')
      + (bug.knownCve ? ` <span class="known-cve" data-click-tip="${esc(`A CVE that tlspuffin declares for what this configuration built (${Object.keys(bug.knownCve).join(', ')}: the build's vendorinfo, known minus fixed vulnerabilities), and whose signature in vuln_targets.json this bug matches: not a new bug`)}">📋 known · ${esc([...new Set(Object.values(bug.knownCve))].join(', '))}</span>` : '')
      + (bug.unexpected ? ' <span class="unexpected" data-click-tip="Neither the expected bug of its configuration nor a known CVE set apart: a new finding, or a rule of vuln_targets.json to complete">⚠ unexpected</span>' : '')
      + (bug.isNew ? ` <span class="new-bug-badge" data-click-tip="New for ${esc(bug.isNew.join(', '))}: with an expected bug, never seen there before this task (any earlier task: VulnA, VulnB, Perf, campaigns); in a plain version, none of the CVEs tlspuffin declares for that build">🚨 NEW BUG</span>` : '');
}

// What was found, then what the replay did with it. Mismatch: the fuzzer's record (its logs) is the evidence.
function TypeBadges(bug) {
  const type = `<span class="type ${TypeClass(bug.type)}">${esc(TYPE_LABELS[bug.type] ?? bug.type)}</span>`;
  const why = 'The fuzzer runs every input in one process (state of the library, memory layout); a replay starts a fresh process.';
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
  return `<details class="bug" id="bug-${esc(bug.letter)}" data-kind="${bug.notTarget ? 'not-target' : bug.reproduced ? 'confirmed' : bug.fuzzer ? 'fuzzer' : bug.type}" ${open ? 'open' : ''}>
    <summary>
      <div class="count"><span class="bugletter"><span class="chev" title="Click: replay report and fuzzer log">▸</span> ${esc(BugName(bug, CVES))}</span>${count(bug.count)} <small>objective${bug.count > 1 ? 's' : ''}</small>${bug.notReproduced && bug.reproduced ? `<small class="nr">(${count(bug.notReproduced)} not reproduced)</small>` : ''}</div>
      <div>${TypeBadges(bug)}</div>
      <div class="symptom"><div class="frames" title="${esc((bug.frames.join(' < ') || bug.summary) + (reasons.length ? '\nnot reproduced: ' + reasons.join(', ') : ''))}">${frames}</div>${BugTags(bug) ? `<div class="bug-tags">${BugTags(bug)}</div>` : ''}</div>
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
  const runs = report.runs ?? [];
  const bugs = Bugs(runs, report.not_targeted, report.targets);
  REPORT_LIBRARIES = report.libraries ?? [];
  const expectedRuns = ExpectedRuns(runs, report.targets, report.libraries);
  // 🚨 new bugs: never seen for their library before this task (known_bugs.json next to the reports)
  const known = await fetch('known_bugs.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
  CVES = await LoadCves();
  const newBugs = NewBugs(bugs, known, report.task, report);
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
  // configurations with a bug: recorded by the fuzzer or confirmed by a replay (a bug that never replays, such as CDOS's
  // crash in the session cache, is still a bug found), and among them those a replay confirmed; CVEs set apart excluded
  const real = bugs.filter(bug => !bug.notTarget && (bug.reproduced > 0 || bug.fuzzer));
  const hit = [...new Set(real.flatMap(bug => bug.runs.map(run => run.library)))];
  const hitConfirmed = [...new Set(real.flatMap(bug => bug.runs.filter(run => run.reproduced > 0).map(run => run.library)))];
  // objectives of bugs no replay confirms and the fuzzer did not record (no log, older tasks)
  const unconfirmedCount = (type) => bugs.filter(bug => !bug.reproduced && !bug.fuzzer && bug.type === type).reduce((sum, bug) => sum + bug.count, 0);
  bugs.forEach((bug, i) => { bug.letter = Letter(i); });
  const fuzzerOnly = bugs.filter(bug => Mismatch(bug) && !bug.notTarget);
  const fuzzerOnlyObjectives = fuzzerOnly.reduce((sum, bug) => sum + bug.count, 0);
  // every objective the replay does not reproduce while the fuzzer recorded it (also within confirmed bugs)
  const notReproducedWithRecord = bugs.filter(bug => bug.fuzzer).reduce((sum, bug) => sum + bug.notReproduced, 0);

  // VulnA/VulnB look for known bugs: finding them is expected, no 🎉
  const expected = ['vuln-a', 'vuln-b'].includes(report.job_type);
  // every real bug (recorded by the fuzzer or confirmed by a replay, CVEs set apart excluded), and how many a replay confirmed
  const realBugs = real.length;
  const alarm = newBugs.length ? `🚨 ${newBugs.length} NEW BUG${newBugs.length > 1 ? 'S' : ''} · ` : '';
  const title = alarm + (realBugs > 0 ? `${expected ? '' : '🎉 '}${realBugs} bug${realBugs > 1 ? 's' : ''} found${confirmed.length < realBugs ? ` (${confirmed.length} confirmed by replay)` : ''}`
      : found > 0 ? 'Objectives found, no bug confirmed' : 'No objective');
  document.title = `${title} · task ${report.task}`;
  const span = report.started && report.ended ? Duration(new Date(report.ended) - new Date(report.started)) : '';
  const scheduler = `${location.protocol}//${location.hostname}:10082`;
  const links = [
    report.task_url ? `<a href="${esc(report.task_url)}" target="_blank" rel="noopener">task on the board</a>` : '',
    `<a href="${location.protocol}//${location.hostname}:10083/files/tlspuffin" target="_blank" rel="noopener">results</a>`,
    report.live ? '' : `<a href="${scheduler}/api/task/${esc(report.task)}/artefacts">⬇️ artefacts (zip)</a>`,
    `<a href="${esc(source)}" target="_blank" rel="noopener">JSON</a>`,
  ].filter(Boolean).join(' · ')
    // tools of the page, left out of a saved copy
    + ` · <a href="/html/publisher/bugs.html" title="The expected bug of each configuration, the CVEs set apart (the file to edit) and the bugs found so far per library">🎯 bugs reference</a>`
    + `<span class="page-tools"> · <a href="#" id="save-offline" title="One HTML file of this page as shown, to keep or send: bugs fold and unfold, the links lead to the bench">💾 save offline</a>`
    + ` · <a href="#" id="print-page" title="Print, or save as PDF from the print dialog: every bug of the current filter unfolded">🖨 print / PDF</a></span>`;

  root.innerHTML = `
    <div class="top">
      <h1>${title} · <span id="commit-line"><span class="mono">${esc(String(report.commit ?? '').slice(0, 10))}</span></span></h1>
      <div class="meta">${esc(report.name)}${report.user ? ` · ${esc(report.user)}` : ''}
        ${report.started ? ` · ran ${esc(DateTime(report.started))}${report.ended ? ` → ${esc(DateTime(report.ended))}` : ''}${span ? ` (${span})` : ''}` : ''}
        ${report.cancelled ? ' · <span class="bad">cancelled</span>' : ''}
        ${report.live ? ` · <span class="live">● live · updated ${esc(report.updated)}</span>` : ''} · ${links}</div>
      <div class="tiles">
        ${ExpectedBanner(expectedRuns, report.libraries)}
        <div class="tile ${confirmed.length && !expected ? 'gold' : ''}"><b>${count(confirmed.length)}</b><span>distinct bug${confirmed.length === 1 ? '' : 's'} (confirmed)</span></div>
        ${uncategorised.total ? `<div class="tile warn uncat-tile" data-click-tip="${esc(UncategorisedText(uncategorised))}"><b>❓ ${count(uncategorised.total)}</b> without category</div>` : ''}
      ${uncategorised.pending ? `<div class="tile pending-tile" data-click-tip="${esc(UncategorisedText(uncategorised, null, true))}"><b>⏳ ${count(uncategorised.pending)}</b> not processed yet</div>` : ''}
      ${fuzzerOnly.length ? `<div class="tile warn" data-click-tip="Objectives whose replay does not reproduce what the fuzzer saw (crash or claim violation, from its logs)"><b>${count(fuzzerOnly.length)}</b><span>seen only by the fuzzer (${count(fuzzerOnlyObjectives)} objectives)</span></div>` : ''}
        ${notTargetBugs.length ? `<div class="tile" data-click-tip="Bugs that are not the CVE this job looks for (${esc([...new Set(notTargetBugs.map(b => b.notTarget))].join(', '))}): listed after the targeted ones, not counted in the configurations hit"><b>${count(notTargetBugs.length)}</b><span>not the target (${count(notTargetObjectives)} objectives)</span></div>` : ''}
        <div class="tile"><b>${count(found)}</b><span>objectives found</span></div>
        <div class="tile"><b>${count(replayed)}</b><span>replayed · ${count(reproduced)} reproduced</span></div>
        ${Object.keys(expectedRuns).length ? '' /* the 🎯 tile says it (bugs found by the fuzzer, confirmed by a replay or not) */
          : `<div class="tile" data-click-tip="${esc(`with a bug recorded by the fuzzer or confirmed by a replay: ${hit.join(', ') || 'none'}\nconfirmed by a replay: ${hitConfirmed.join(', ') || 'none'}`)}"><b>${hit.length} / ${libraries.length}</b><span>configurations with a bug${hit.length ? ` (${hitConfirmed.length} confirmed by replay)` : ''}</span></div>`}
      </div>
    </div>
    <div class="wrap">
      ${FailuresNote(report.libraries, expectedRuns)}
      ${report.live ? '<p class="note">Task running: objectives are replayed every few minutes on core 0, outside the fuzzing cores. The page reloads every minute.</p>' : ''}
      ${report.pending_final ? '<p class="note pending-final">⏳ The task ended: this is its last live page. The final report (every objective classified, the replays of the task) is being written and replaces it within minutes; the page reloads every minute.</p>' : ''}
      ${bugs.length ? `
      <div class="bar">
        <button type="button" class="chip" id="chip-all">All (${bugs.length})</button>
        <button type="button" class="chip on" data-kind="confirmed">confirmed bugs (${confirmed.length})</button>
        ${fuzzerOnly.length ? `<button type="button" class="chip on" data-kind="fuzzer">⚠ seen only by the fuzzer (${fuzzerOnly.length})</button>` : ''}
        ${notTargetBugs.length ? `<button type="button" class="chip on" data-kind="not-target">not the target (${notTargetBugs.length})</button>` : ''}
        <button type="button" class="chip ${confirmed.length || fuzzerOnly.length ? '' : 'on'}" data-kind="no-crash">not reproduced, no fuzzer record (${count(unconfirmedCount('no-crash'))})</button>
        <button type="button" class="chip ${confirmed.length || fuzzerOnly.length ? '' : 'on'}" data-kind="replay-error">replay errors (${count(unconfirmedCount('replay-error'))})</button>
        <span class="grow"></span>
        <button type="button" class="chip" id="toggle-all">unfold all</button>
      </div>
      <h2>Bugs, by number of objectives</h2>
      <div class="card" id="bugs">${bugs.map(bug => BugRow(bug, false)).join('')}</div>
      ` : ''}
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
          const failed = RunFailures(libEntry), outcomes = Object.keys(libEntry?.outcomes ?? {}).length;
          const succeeded = !outcomes ? ''
              : failed.length ? ` · <span class="runs-failed" data-click-tip="${esc(`${outcomes - failed.length} of ${outcomes} runs succeeded; not counted as succeeded:\n` + failed.map(f => `run ${f.attempt}: ${f.why}`).join('\n'))}">⚠ ${outcomes - failed.length} succeeded</span>`
              : ` · <span title="${esc(`succeeded\nruns: ended normally with their end-of-run summary, which saw what their job scripts looked for${expectedRuns[library]?.preTarget ? '\nbefore targets: the job scripts had no expected bug (before 2026-10-07), any objective' : ''}`)}">${outcomes} succeeded${expectedRuns[library]?.preTarget ? ' (before targets: any objective)' : ''}</span>`;
          return `<tr><td><b>${esc(library)}</b></td><td>${ExpectedCell(report, library, first)}</td><td>${esc(Build(first)) || '<span class="muted">?</span>'}</td><td>${Asan(first)}</td>
            <td>${ExpectedRunsChip(library, expectedRuns[library])}<span title="with objectives\nruns: that saved at least one objective (any bug) / runs">${total != null ? `${libRuns.length} with objectives / ${total}` : libRuns.length}</span>${succeeded}</td>
            <td>${libFound ? `${count(libFound)} (${count(libReproduced)} reproduced)` : '0'}</td>
            <td>${libBugs.map(bug => LetterBadge(bug) + (bug.expectedFor?.has(library) && report.targets?.[library]
                ? ` <span class="expected" data-click-tip="The bug this configuration is meant to find (vuln_targets.json): ${esc(report.targets[library].kind === 'claim' ? 'claim “' + report.targets[library].match + '”' : 'crash in ' + report.targets[library].match)}">🎯 expected · ${esc(report.targets[library].cve)}</span>` : '')).join(' ') || '—'}</td></tr>`;
        }).join('')}</table></div>
      ${UnconfirmedNote(found, replayed, bugs.reduce((sum, bug) => sum + (bug.replayType === 'no-crash' || bug.fuzzer ? bug.notReproduced : 0), 0), unconfirmedCount('replay-error'), confirmed.length, notReproducedWithRecord)}
    </div>`;

  // filters: the kinds of bugs shown
  const shown = new Set([...root.querySelectorAll('.chip.on[data-kind]')].map(chip => chip.dataset.kind));
  const apply = () => root.querySelectorAll('.bug').forEach(bug => { bug.hidden = !shown.has(bug.dataset.kind); });
  const kindChips = [...root.querySelectorAll('.chip[data-kind]')];
  const allChip = root.querySelector('#chip-all');
  const syncAll = () => allChip?.classList.toggle('on', kindChips.every(chip => chip.classList.contains('on')));
  // All: every kind shown; again: back to the confirmed bugs and those seen only by the fuzzer
  allChip?.addEventListener('click', () => {
    const all = !allChip.classList.contains('on');
    kindChips.forEach(chip => {
      const on = all || ['confirmed', 'fuzzer'].includes(chip.dataset.kind);
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
    const gitRestApi = `${location.protocol}//${location.hostname}:10081`;
    const desc = (await resolveCommits(gitRestApi, 'tlspuffin', [report.commit]).catch(() => null))?.get(report.commit);
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
