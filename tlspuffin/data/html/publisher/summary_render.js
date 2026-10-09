import { OpenClickTip } from '../board/tips.js';
import { GraphOverview } from './summary_graphoverview.js';
import { GraphCompare } from './summary_graphcompare.js';
import { MetricsCampaign } from './summary_metricscampaign.js';
import { describeCommit, commitLineHTML } from '../common/commitinfo.js';

// open pull requests of the git_restapi history, for the PR of each commit (see SetPullRequests)
let pullRequests = [];
export function SetPullRequests(prs) {
  pullRequests = Array.isArray(prs) ? prs : [];
}

/*****************************************/

function DisableUI() {
  document.body.setAttribute('inert', '');
  document.body.setAttribute('aria-busy', 'true');
}

function EnableUI() {
  document.body.removeAttribute('inert');
  document.body.removeAttribute('aria-busy');
}

function CopyInClipboard(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "absolute";
  textArea.style.left = "-999999px";
  document.body.prepend(textArea);
  textArea.select();
  try {
    document.execCommand('copy');
  } catch (error) {
    console.error(error);
  } finally {
    textArea.remove();
  }
}

/*****************************************/

function GetPastilleClass(status) {
  const mapping = {
    'success': 'pastille-green',
    'fail': 'pastille-red',
    'mixed': 'pastille-yellow',
    'no run': 'pastille-gray'
  };
  return mapping[status] || 'pastille-gray';
}

// what the dot of a type of results says (its hover)
const PASTILLE_MEANING = { 'success': '🟢\nstatus: every run of every library succeeded', 'fail': '🔴\nstatus: no run succeeded',
    'mixed': '🟡\nstatus: some runs did not succeed', 'no run': '⚪\nstatus: no run' };

function GetPastilleIcon(status) {
  const icons = {
    'success': '🟢',
    'fail': '🔴',
    'mixed': '🟡',
    'no run': '⚪'
  };
  return icons[status] || '⚪';
}

function GetLibIcon(success, total) {
  if (success === total) return '✅';
  if (success > 0) return '⚠️';
  return '⛔';
}

// ASAN status of the binary (cli.asan, see DetectAsan); results older than the detection only
// tell whether ASAN was requested in the features/vendor, which is shown as unverified.
function GetAsanBadge(cli) {
  if ((typeof cli === 'object') && cli?.unsupported) {
    return `<span class="lib-asan asan-off" data-click-tip="${EscapeAttribute(cli.unsupported)}">ASAN unsupported</span>`;
  }
  const asan = (typeof cli === 'object') ? cli?.asan : undefined;
  if (asan?.instrumented === true) {
    return `<span class="lib-asan asan-on" data-click-tip="ASAN active (${EscapeAttribute(asan.runtime)} runtime, ${asan.asan_report_refs} instrumented checks)">ASAN✓</span>`;
  }
  if (asan?.instrumented === false) {
    return `<span class="lib-asan asan-off" data-click-tip="Built without ASAN${asan.requested ? ' although it was requested' : ''}">ASAN✗</span>`;
  }
  const requested = (typeof cli === 'object') &&
      ((`,${cli?.features ?? ''},`.includes(',asan,')) || (cli?.vendor ?? '').includes('-asan'));
  return `<span class="lib-asan asan-unknown" data-click-tip="ASAN not verified (older result); ${requested ? 'requested' : 'not requested'} in features/vendor">ASAN?</span>`;
}

// Compat rules not applied although the commit is in their declared range (cli.compat_warning, see CompatEvaluate)
function GetCompatWarningIcon(cli) {
  const warning = (typeof cli === 'object') ? cli?.compat_warning : null;
  if (!warning) return '';
  return `<span class="warn-icon warn-compat" data-click-tip="${EscapeAttribute(`Compat rules: ${warning}`)}">⚖️⚠️</span>`;
}

function GetLogWarningIcon(status) {
  const warnings = status?.log_warning ?? [];
  if (warnings.length === 0) return '';
  const title = warnings.map(item => `run ${item.id}: ${item.warning}`).join('\n');
  return `<span class="warn-icon warn-logs" data-click-tip="${EscapeAttribute(`Large or verbose logs (may slow the fuzzer):\n${title}`)}">📜⚠️</span>`;
}

// Button shown when objectives were found and replayed: opens the list of distinct bugs (see ObjectivesPanel)
// Replays that confirmed a bug (crash, security violation, panic): objectives.confirmed, or counted from the groups
// shown for results summarized before that field
function ConfirmedObjectives(objectives) {
  if (Number.isInteger(objectives?.confirmed)) return objectives.confirmed;
  return (objectives?.groups ?? []).filter(group => !['no-crash', 'replay-error', 'not-replayed'].includes(group.type))
                                   .reduce((sum, group) => sum + (group.count ?? 0), 0);
}

// 🐞 button: red when a replay confirmed a bug, orange when objectives were found but none was confirmed (not
// reproduced, or the replay timed out or could not run)
function GetObjectivesButton(status) {
  const objectives = status?.objectives;
  if (!objectives || !(objectives.total > 0)) return '';
  const distinct = objectives.distinct ?? objectives.groups?.length ?? 0;
  const confirmed = ConfirmedObjectives(objectives);
  const counts = `${objectives.total} objective(s), ${distinct} distinct`;
  const title = confirmed > 0
      ? `${counts}, ${confirmed} replay(s) confirmed a bug. Click to show them, grouped by bug`
      : `${counts}, none confirmed: no replay reproduced a bug (not reproduced, timed out or could not run). `
        + 'Click to show them';
  return `<button type="button" class="lib-objectives${confirmed > 0 ? '' : ' unconfirmed'}" title="${EscapeAttribute(title)}">`
       + `🐞 ${objectives.total} (${distinct})</button>`;
}

// taskID: task of the results, for the link to its full objectives page (objectives_report.sh)
function ObjectivesPanel(objectives, taskID = null) {
  const panel = document.createElement('div');
  panel.className = 'lib-objectives-panel';
  panel.hidden = true;
  const groups = objectives.groups ?? [];
  const shown = groups.length < (objectives.distinct ?? groups.length) ? ` (${groups.length} largest shown)` : '';
  const header = `<div class="lib-objectives-info">${objectives.total} objective(s) found, ${objectives.replayed} replayed, `
      + `${objectives.distinct ?? groups.length} distinct${shown}. `
      + (taskID ? `<a class="lib-objectives-report" href="${ObjectivesPageURL(taskID)}" target="_blank" rel="noopener" `
          + `title="All the objectives of the task, grouped by bug, with their reports (new tab)">Full report ↗</a> · ` : '')
      + `traces: artefacts <code>&lt;library&gt;/&lt;run&gt;-objective-reports</code> and <code>-objective</code>.</div>`;
  const rows = groups.map(group => {
    const frames = (group.frames ?? []).map(EscapeAttribute).join(' &lt; ') || '—';
    const attempts = (group.attempts ?? []).join(', ');
    return `<details class="lib-objective">
        <summary><b>${group.count} ×</b> <span class="objective-type objective-${EscapeAttribute(group.type)}">${EscapeAttribute(group.type)}</span>
          <span class="objective-frames">${frames}</span>
          <span class="objective-runs">runs ${EscapeAttribute(attempts)}</span></summary>
        <div class="objective-trace">first: run ${EscapeAttribute(group.first_attempt)}, ${EscapeAttribute(group.first_trace)}.trace</div>
        <pre>${EscapeAttribute(group.excerpt ?? '')}</pre>
      </details>`;
  }).join('');
  panel.innerHTML = header + rows;
  return panel;
}

// The bugs of a task as its objectives report shows them (same grouping and letters: objectives_page/bugs.js, next
// to the reports): taskID -> Promise of { bugs } or null when the task has no report yet
const reportBugs = new Map();
// the page each task's objectives come from: <task> (final report) or live-<task> (provisional)
const reportSource = new Map();
// the registry of the bugs found so far (🚨 new), read once
let knownBugs = null;

function ReportBugs(taskID) {
  if (!reportBugs.has(taskID)) {
    reportBugs.set(taskID, (async () => {
      try {
        const [module, finalResponse] = await Promise.all([import('/html/objectives/bugs.js'),
          fetch(`/html/objectives/${encodeURIComponent(taskID)}.json`, { cache: 'no-store' })]);
        // no final report yet (the task runs, or ended minutes ago): its live report, marked provisional
        let response = finalResponse, live = false;
        if (!response.ok) {
          response = await fetch(`/html/objectives/live-${encodeURIComponent(taskID)}.json`, { cache: 'no-store' });
          live = true;
          if (!response.ok) return null;
        }
        const report = await response.json();
        reportSource.set(taskID, live || report.pending_final ? `live-${taskID}` : String(taskID));
        const bugs = module.Bugs(report.runs ?? [], report.not_targeted, report.targets);
        // 🚨 new bugs (bugs.js NewBugs: per configuration with a target; in a plain version, none of its declared CVEs)
        // read once for the page (it was fetched again for every report)
        knownBugs ??= fetch('/html/objectives/known_bugs.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
        const known = await knownBugs;
        module.NewBugs?.(bugs, known, report.task, report);
        bugs.expectedRuns = module.ExpectedRuns?.(report.runs ?? [], report.targets, report.libraries) ?? {};
        // how the scheduler ended each run, per configuration (reports written from 2026-10-09 on)
        bugs.runEnds = Object.fromEntries((report.libraries ?? []).map(lib => [lib.library, lib.ends ?? null]));
        bugs.endErrors = Object.fromEntries((report.libraries ?? []).map(lib => [lib.library, lib.end_errors ?? null]));
        bugs.uncategorised = module.Uncategorised?.(report.runs ?? []) ?? null;
        bugs.forEach((bug, i) => { bug.letter = module.Letter(i); });
        bugs.cves = await module.LoadCves?.() ?? null;
        return { bugs, module };
      } catch (error) {
        return null;
      }
    })());
  }
  return reportBugs.get(taskID);
}

// The runs of a library without an end-of-run summary, in its failed-runs row: their attempts, and on click why (the
// error of the task's summary, then, once the objectives report is read, ExplainMissing: how each run ended)
function MissingSummaries(runs, errors) {
  const item = document.createElement('span');
  item.className = 'stat-item fail-missing';
  item.innerHTML = `<span class="stat-field">no end-of-run summary</span>&nbsp;run${runs.length > 1 ? 's' : ''} `
      + EscapeAttribute(runs.map(run => run.id).join(', '));
  item.dataset.runs = runs.map(run => run.id).join(',');
  item.dataset.clickTip = MissingTip(runs.map(run => [run.id,
      typeof errors?.[run.id] === 'string' ? errors[run.id] : 'summary missing']));
  return item;
}
const MissingTip = (lines) => `No end-of-run summary, so no metrics, for ${lines.length} run${lines.length > 1 ? 's' : ''}:\n`
    + lines.map(([attempt, why]) => `run ${attempt}: ${why}`).join('\n');

// The reasons of the runs without summary, from the objectives report: how the scheduler ended the run, and the error
// the end-of-run script recorded (e.g. "Error with stats.json"); neither: the task's logs say why
function ExplainMissing(item, ends, endErrors) {
  if (!item || item.dataset.explained || (!ends && !endErrors)) return;
  item.dataset.explained = '1';
  item.dataset.clickTip = MissingTip(item.dataset.runs.split(',').map(attempt => {
    const end = ends?.[attempt];
    const why = [(end && end !== 'Done') ? `the run ${RUN_END[end] ?? `ended ${end}`}` : null,
        endErrors?.[attempt] ? `end-of-run script: ${endErrors[attempt]}` : null].filter(Boolean);
    return [attempt, why.join('; ') || 'the end-of-run script recorded no error (the task\'s logs say why)'];
  }));
}

// how the scheduler ended a run, in words
const RUN_END = { TimedOut: 'ended by its timeout', Failed: 'failed', Cancelled: 'was cancelled' };

// Why a run that found the expected bug is not counted as succeeded (null: it is): its state in the summary of the row
// (success only when the run ended normally and its summary saw the bug), how the scheduler ended it, and the error its
// end-of-run script recorded (both from the objectives report)
function NotCountedReason(attempt, runs, ends, endErrors) {
  const run = runs?.find(r => Number(r.id) === Number(attempt));
  if (run?.state === 'success') return null;
  const end = ends?.[attempt];
  const ended = (end && end !== 'Done') ? (RUN_END[end] ?? `ended ${end}`) : null;
  return (run?.state == null)
      ? `no end-of-run summary${ended ? ` (the run ${ended})` : endErrors?.[attempt] ? ` (${endErrors[attempt]})` : ''}`
      : ended ?? (end === 'Done' ? 'its end-of-run summary did not see the bug'
          : 'its summary says it failed: the run did not end normally, or its summary did not see the bug');
}

// The runs that found the expected bug (🎯) but are not counted as succeeded: one line each, with the reason, on the
// click text of the status icon of the row (the n/m of the row counts the succeeded runs)
function ExplainUncounted(icon, expected, runs, ends, endErrors) {
  if (!icon || !runs || icon.dataset.uncounted) return;
  const lines = [...expected.found].sort((a, b) => a - b).flatMap(attempt => {
    const why = NotCountedReason(attempt, runs, ends, endErrors);
    return why ? [`run ${attempt}: ${why}`] : [];
  });
  if (!lines.length) return;
  icon.dataset.uncounted = '1';
  icon.dataset.clickTip += `\n🎯 ${expected.target.cve} found by these runs, not counted as succeeded:\n` + lines.join('\n');
}

// The panel and the 🐞 button of a library from the report of its task, when there is one: its bugs with the letters
// of the report, where they happened, how many objectives (and how many not reproduced), each linked to the report
async function ShowReportBugs(panel, button, taskID, library, status) {
  const result = await ReportBugs(taskID);
  if (!result) {
    // no objectives report yet (written within minutes of the end of the task): the chip shows the run's own counts,
    // without the expected bugs (🎯); say so
    if (button && !button.querySelector('.report-pending')) {
      button.insertAdjacentHTML('beforeend', ' <span class="report-pending">⏳</span>');
      button.title = 'The objectives report of this task is not written yet (within about 5 minutes of its end):\n'
          + 'these are the counts of the runs\' own summary, without the expected bugs (🎯), which come with the report';
    }
    return;
  }
  const { bugs, module } = result;
  ExplainMissing(button?.closest('table')?.querySelector(`.lib-fail-row[data-library="${CSS.escape(library)}"] .fail-missing`),
      bugs.runEnds?.[library], bugs.endErrors?.[library]);
  // 🚨🚨🚨 before the chip: a new bug of this configuration (bugs.js NewBugs)
  const fresh = bugs.filter(bug => bug.isNew?.includes(library));
  if (fresh.length && button && !button.previousElementSibling?.classList.contains('new-bug')) {
    const alarm = document.createElement('span');
    alarm.className = 'new-bug';
    alarm.textContent = '🚨🚨🚨';
    alarm.dataset.clickTip = `NEW BUG for ${library} (a configuration with a target: never seen there before this task; a plain version: none of the CVEs tlspuffin declares for its build) — ${fresh.map(b => `${module.BugName?.(b, bugs.cves) ?? 'Bug ' + b.letter}: ${b.type} ${(b.frames ?? [])[0] ?? b.summary ?? ''}`).join('; ')}. Click the chip for it`;
    button.parentNode.insertBefore(alarm, button);
  }
  // ❓ after the chip: objectives of this library without category (no replay, no record of the fuzzer, no location)
  const uncat = bugs.uncategorised?.libs?.[library];
  if (uncat?.count && button && !button.nextElementSibling?.classList.contains('uncat')) {
    const mark = document.createElement('span');
    mark.className = 'uncat';
    mark.textContent = `❓ ${uncat.count.toLocaleString('en-US')}`;
    mark.dataset.clickTip = module.UncategorisedText(bugs.uncategorised, library);
    button.after(mark);
  }
  // a provisional report (live page): its counts may still change, the final report replaces it within minutes
  const provisional = reportSource.get(taskID)?.startsWith('live-');
  const own = bugs.map(bug => {
    const runs = bug.runs.filter(run => run.library === library);
    const count = runs.reduce((sum, run) => sum + run.count, 0);
    const reproduced = runs.reduce((sum, run) => sum + run.reproduced, 0);
    return { bug, runs, count, reproduced };
  }).filter(entry => entry.count > 0);
  const expected = bugs.expectedRuns?.[library];
  // neither objectives nor an expected bug for this configuration: no chip (a placeholder chip of a row without
  // objectives, see RenderLibrariesTable, goes)
  if (!own.length && !expected) {
    if (button?.dataset.placeholder) button.remove();
    return;
  }
  const total = own.reduce((sum, entry) => sum + entry.count, 0);
  const notReproduced = own.reduce((sum, entry) => sum + entry.count - entry.reproduced, 0);
  const rows = own.map(({ bug, runs, count, reproduced }) => {
    const kind = bug.type;
    const where = (bug.frames ?? []).map(EscapeAttribute).join(' &lt; ') || EscapeAttribute(bug.summary || '—');
    const missing = count - reproduced;
    const badge = ((reproduced === 0 && bug.fuzzer) ? ' <span class="objective-warn" title="The fuzzer recorded it; no replay reproduces it">⚠ not reproduced</span>'
        : missing ? ` <span class="objective-warn">⚠ ${missing} not reproduced</span>` : '')
        + (bug.notTarget ? ` <span class="objective-not-target" title="Not the CVE this job looks for (another known CVE of the library); it does not end the experiment">not the target · ${EscapeAttribute(bug.notTarget)}</span>` : '');
    return `<div class="lib-objective lib-bug">
        <a class="objective-letter" href="${ObjectivesPageURL(taskID)}#bug-${bug.letter}" target="_blank" rel="noopener"
           title="${EscapeAttribute(module.BugName?.(bug, bugs.cves) ?? 'Bug ' + bug.letter)} of the objectives report (new tab)">${EscapeAttribute(module.BugName?.(bug, bugs.cves) ?? 'Bug ' + bug.letter)}</a>
        <b>${count} ×</b> <span class="objective-type objective-${EscapeAttribute(kind)}">${EscapeAttribute(module.TYPE_LABELS[kind] ?? kind)}</span>${badge}${bug.expected ? ` <span class="objective-expected">🎯 ${EscapeAttribute(bug.expected.join(', '))}</span>` : ''}${bug.isNew?.includes(library) ? ' <span class="objective-new">🚨 NEW BUG</span>' : ''}${bug.unexpected ? ' <span class="objective-warn">⚠ unexpected</span>' : ''}
        <span class="objective-frames">${where}${bug.framesFromFuzzer ? ' <span class="muted">(fuzzer\'s backtrace)</span>' : ''}</span>
        <span class="objective-runs">runs ${runs.map(run => EscapeAttribute(run.attempt)).join(', ')}</span>
      </div>`;
  }).join('');
  if (panel && own.length) panel.innerHTML = `<div class="lib-objectives-info">${total} objective(s), ${own.length} bug(s)`
      + (notReproduced ? `, ${notReproduced} not reproduced by their replay` : '') + ` — as in the `
      + `<a class="lib-objectives-report" href="${ObjectivesPageURL(taskID)}" target="_blank" rel="noopener">objectives report ↗</a>`
      + ` (a bug is what the fuzzer recorded; the report has the replays and the fuzzer's logs).</div>` + rows;
  // the expected bug of this configuration (vuln_targets.json): 🎯 runs that found it and succeeded / runs (bugs.js
  // ExpectedRuns, the count of the objectives report), +k failed the runs that found it without succeeding, then the others
  // counted with the run states of the summary this row shows (the same as the outcomes of the report, which a report
  // written before 2026-10-09 does not have): never more runs than the runs column
  if (expected && status?.runs?.length) {
    status.runs.forEach(run => expected.runs.add(Number(run.id)));
    module.CountRuns?.(expected, Object.fromEntries(status.runs.map(run => [Number(run.id), run.state])));
  }
  if (button && expected) {
    const notTarget = own.filter(e => e.bug.notTarget).reduce((s, e) => s + e.count, 0);
    const unexpected = own.filter(e => e.bug.unexpected).reduce((s, e) => s + e.count, 0);
    // "· no replay" inside the chip: the expected bug was not reproduced by a replay in every run that found it (the fuzzer's log
    // is the evidence there, e.g. CDOS's crash in the session cache, which depends on the fuzzer's in-process state)
    const notReproduced = expected.found.size - (expected.reproduced?.size ?? expected.found.size);
    const counted = expected.counted ?? expected.found, lost = expected.lost ?? [];
    button.innerHTML = `🎯 ${counted.size}/${expected.runs.size}`
        + (lost.length ? ` <span class="badge-lost">+${lost.length} failed</span>` : '')
        + (notReproduced > 0 ? ` <span class="badge-nr">· no replay</span>` : '')
        + (notTarget ? ` <span class="badge-nt">+${notTarget} ⦸</span>` : '')
        + (unexpected ? ` <span class="badge-ux">⚠ ${unexpected}</span>` : '');
    // green every run, amber not every run, red no run (the colours of the objectives report)
    button.classList.remove('unconfirmed', 'target-all', 'target-partial', 'target-none');
    button.classList.add(`target-${expected.level ?? (counted.size === 0 ? 'none' : counted.size < expected.runs.size ? 'partial' : 'all')}`);
    button.expected = expected;
    ExplainUncounted(button.closest('tr')?.querySelector('.lib-icon'), expected, status?.runs, bugs.runEnds?.[library],
        bugs.endErrors?.[library]);
    // the runs column counts the success of the job scripts of the task: without target then, any objective
    const icon = button.closest('tr')?.querySelector('.lib-icon');
    if (expected.preTarget && icon && !icon.dataset.preTarget) {
      icon.dataset.preTarget = '1';
      icon.dataset.clickTip += '\nbefore targets: the job scripts of this task had no expected bug (before 2026-10-07): a run '
          + `succeeded on its first objective, whatever the bug; 🎯 ${counted.size}/${expected.runs.size} counts the runs that found the expected bug`;
    }
    button.classList.add('target-chip');
    // one hover for the whole chip (its parts have none): one line per mark (bugs.js, as on the objectives report)
    button.title = (module.ExpectedChipTip?.(library, { ...expected, counted, lost }, {
        why: attempt => NotCountedReason(attempt, status?.runs, bugs.runEnds?.[library], bugs.endErrors?.[library]),
        notReproduced, notTarget, unexpected, alias: bugs.cves?.[expected.target.cve]?.alias ?? '' }) ?? `🎯 ${expected.target.cve}`)
        + (own.length ? '\nClick: the bugs of the configuration' : '\nno objective in any run of this configuration');
    delete button.dataset.placeholder;
  } else if (button) {
    button.textContent = `🐞 ${total} (${own.length})`;
    const confirmed = own.some(entry => entry.reproduced > 0);
    button.classList.toggle('unconfirmed', !confirmed);
    button.title = `${total} objective(s), ${own.length} bug(s) as in the objectives report` + (notReproduced ? `, ${notReproduced} not reproduced` : '') + '. Click to show them';
  }
  if (provisional && button) {
    button.insertAdjacentHTML('beforeend', ' <span class="report-pending">⏳</span>');
    button.title = `${button.title}\n⏳ from the live objectives page: the final report (every objective classified) replaces it within minutes of the end of the task`;
  }
}

// 🐞 at the end of the line of a type (run on … · bench … · vs …): the objectives report of its task, when it has one
async function AddReportBug(runInfo, taskID, libs = []) {
  const result = await ReportBugs(taskID);
  if (!result) return;
  const sep = document.createElement('span');
  sep.className = 'type-bugs-sep';
  sep.textContent = ' · ';
  const link = document.createElement('a');
  link.className = 'type-bugs';
  link.textContent = '🐞';
  link.href = ObjectivesPageURL(taskID);
  link.target = '_blank';
  link.rel = 'noopener';
  link.title = `Bug report of task ${taskID}${libs.length ? ` (${libs.join(', ')})` : ''}: its bugs, objectives, replays and traces (new tab)`;
  link.addEventListener('click', (event) => event.stopPropagation());
  runInfo.append(sep, link);
}

// Page written by scripts/tools/objectives_report.sh, served by the publisher
function ObjectivesPageURL(taskID) {
  if (reportSource.has(taskID)) return `/html/objectives/${encodeURIComponent(reportSource.get(taskID))}.html`;
  return `/html/objectives/${encodeURIComponent(taskID)}.html`;
}

async function AddObjectivesPageLink(element, taskID) {
  if (!element) return;
  try {
    // GET: the publisher answers 404 to HEAD even for an existing page
    const response = await fetch(ObjectivesPageURL(taskID), { cache: 'no-store' });
    if (!response.ok) return;
  } catch (error) {
    return;
  }
  const link = document.createElement('a');
  link.className = 'lib-objectives';
  link.href = ObjectivesPageURL(taskID);
  link.target = '_blank';
  link.rel = 'noopener';
  link.title = 'Objectives of this task, grouped by bug';
  link.textContent = '🐞 objectives';
  link.addEventListener('click', (event) => event.stopPropagation());
  element.appendChild(link);
}

function GetCrashWarningIcon(status) {
  const warnings = status?.crash_warning ?? [];
  if (warnings.length === 0) return '';
  const title = warnings.map(item => `run ${item.id}: ${item.warning}`).join('\n');
  return `<span class="warn-icon warn-crashes" data-click-tip="${EscapeAttribute(`Fuzzing clients crashed and restarted again and again (executions not comparable):\n${title}`)}">💥⚠️</span>`;
}

// What was built: cli.build (see BuildDescription in PR_common.sh), or the same text derived from the other cli
// fields for older results. The step arguments give both a vendor preset and fallback features.
function GetBuildDescription(cli) {
  if ((typeof cli !== 'object') || (cli === null)) return '';
  if (cli.build) return cli.build;
  const preset = (cli.vendor ?? '').split(':').pop();
  if (cli.cputs === true) return `C harness, ${preset}`;
  if (cli.cputs !== false) return '';
  const name = cli.library?.name;
  const built = (name && (name !== 'NA')) ? `${name}${cli.library?.version ?? ''}` : `features ${cli.features ?? ''}`;
  return `Rust harness, ${built}` + (preset ? ` (vendor ${preset} not available at this commit)` : '');
}

// Build cell of a library: harness and ASAN; the sources ("<preset>@<commit>", "+N" when there are more) only in
// the hover of the harness; a blue "--" when extra fuzzer flags were used (they change the experiment), its hover
// lists them. The hover of the harness gives the full build, features and every source (cli.vendor_sources, see DetectVendorSources: fork branches move over
// time, so the same tlspuffin commit can be built from different sources).
function GetBuildCell(cli) {
  const harness = cli?.cputs === true ? '⚙C' : cli?.cputs === false ? '🦀' : '❓';
  if ((typeof cli !== 'object') || (cli === null)) {
    return `<span class="lib-harnesskind" data-click-tip="no build information">${harness}</span>`;
  }
  const sources = Array.isArray(cli.vendor_sources) ? cli.vendor_sources : [];
  const sourceLines = sources.map(src => {
    const at = src.commit ?? (src.hash ? `archive ${src.hash}` : 'not resolved');
    return `source ${src.name}: ${src.repo ?? src.url ?? '?'} ${src.ref ?? ''} → ${at}`;
  });
  const title = [GetBuildDescription(cli), cli.features ? `features: ${cli.features}` : '', ...sourceLines,
                 cli.flags ? `flags: ${cli.flags}` : ''].filter(Boolean).join('\n');
  let token = '';
  if (sources.length > 0) {
    const src = sources[0];
    const at = src.commit ? src.commit.substring(0, 7) : (src.hash ? 'archive' : 'unresolved');
    token = `${String(src.name).replace(/-asan$/, '')}@${at}${sources.length > 1 ? ` +${sources.length - 1}` : ''}`;
  } else if (cli.cputs === false && cli.library?.name && cli.library.name !== 'NA') {
    token = `${cli.library.name}${cli.library.version ?? ''}`;
  } else {
    token = (cli.vendor ?? '').split(':').pop() || cli.features || '';
  }
  const flags = String(cli.flags ?? '').trim();
  const flagList = flags ? flags.split(/\s+(?=--)/) : [];
  const buildTitle = (token ? `${token}\n` : '') + title;
  return `<span class="lib-build"><span class="lib-harnesskind" data-click-tip="${EscapeAttribute(buildTitle)}">${harness}</span> ${GetAsanBadge(cli)}`
       + (flagList.length ? ` <span class="lib-flags-mark" data-click-tip="${EscapeAttribute(`Extra fuzzer options (${flagList.length}):\n${flagList.map(f => `- ${f}`).join('\n')}`)}">--</span>` : '')
       + `</span>`;
}

function EscapeAttribute(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function FormatStatsCompact(stats) {
  if (!stats) return '-';

  const formatNum = (num) => num < 10000 ? num.toFixed(2) : num.toExponential(2);

  if (stats.singleValue) {
    return `${formatNum(stats.mean)}`;
  }

  const meanStr = formatNum(stats.mean);
  const stddevStr = formatNum(stats.stddev);
  return `μ:${meanStr}(±${stddevStr})`;
}

function ComputeBasicStats(data) {
  if (data.length === 1) {
    const value = data[0];
    return { min: value, max: value, median: value, mean: value, stddev: 0, values: data, singleValue: true };
  }

  const sorted = [...data].sort((a, b) => a - b);
  const n = sorted.length;

  const min = sorted[0];
  const max = sorted[n - 1];
  if (min === max) {
    const value = data[0];
    return { min: value, max: value, median: value, mean: value, stddev: 0, values: data, singleValue: true };
  }

  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const mean = sum / n;

  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];

  const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / n;
  const stddev = Math.sqrt(variance);

  return { min, max, median, mean, stddev, values: data };
}

function CalculateStats(data) {
  if (!data || data.length === 0) return null;
  const result = {
    global: ComputeBasicStats(data.flat())
  }
  if (data.some((values => values.length > 1))) {
    result.perRun = ComputeBasicStats(data.map(run => run.reduce((a, b) => a + b, 0) / run.length));
  }
  return result;
}

/*****************************************/

// Short column names of the metrics (the full field name is in the column hover)
const METRIC_LABELS = {
  coverage: 'coverage', corpus_size: 'corpus', client_duration_s: 'duration s', durations_s: 'duration s',
  duration_s: 'duration s', total_execs: 'execs', objective_size: 'obj.', ratio_success_execution: 'success %',
};
// failed runs: several duration fields, so the labels say which one
const FAIL_METRIC_LABELS = {
  fail_client_duration_s: 'client duration s', fail_duration_s: 'run duration s', fail_total_execs: 'execs',
};
function MetricLabel(field) {
  if (FAIL_METRIC_LABELS[field]) return FAIL_METRIC_LABELS[field];
  const base = field.replace(/^fail_/, '');
  return METRIC_LABELS[base] ?? base.replace(/_/g, ' ');
}

// 2121 -> "2.12k", 182000 -> "182k", 0.5 -> "0.5" (the exact values are in the cell hover)
function FormatCompactNumber(num) {
  const abs = Math.abs(num);
  const units = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k']];
  for (const [value, unit] of units) {
    if (abs >= value) return `${Number((num / value).toPrecision(3))}${unit}`;
  }
  return `${Number(num.toPrecision(3))}`;
}

function FormatStatsCell(stats) {
  if (!stats) return '-';
  if (stats.singleValue) return FormatCompactNumber(stats.mean);
  return `${FormatCompactNumber(stats.mean)}<span class="stat-pm" title="± standard deviation\nover: the runs\nclick the value: all of them, range, median, mean">±${FormatCompactNumber(stats.stddev)}</span>`;
}

// Cell of a metric: mean ± standard deviation over all the values ("global") and, when attempts have several
// values (one per client), over the per-attempt means ("per run", switched by clicking the column header); the
// click gives the values, range and median (a small window, tips.js). Returns null when there is no data.
function CreateMetricCell(label, data, tag = 'td') {
  if (!data || data.length === 0) {
    return null;
  }
  const stats = CalculateStats(data);
  const cell = document.createElement(tag);
  cell.className = 'stat-item metric-cell';
  cell.innerHTML = `<span class="stat-value global">${FormatStatsCell(stats.global)}</span>`;
  if (stats?.perRun !== undefined) {
    cell.innerHTML += `<span class="stat-value perrun hidden">${FormatStatsCell(stats.perRun)}</span>`;
    cell.dataset.perRun = '1';
  }
  if (!stats.global.singleValue || (stats.perRun && !stats.perRun.singleValue)) {
    // on click, in the same panel as the details of a change (ShowRegressionDetails): plain lines, under the value; the
    // statistics shown (global or per run) follow the column's current mode
    cell.classList.add('has-stats');
    cell.addEventListener('click', (event) => {
      if (event.target.closest('.reg-delta')) return;
      event.stopPropagation();
      const perRun = stats.perRun !== undefined && cell.querySelector('.perrun:not(.hidden)') !== null;
      const d = perRun ? stats.perRun : stats.global;
      const f = (num) => num < 10000 ? num.toFixed(2) : num.toExponential(2);
      ShowRegressionDetails(cell.querySelector('.stat-value:not(.hidden)') ?? cell,
          `<div class="rd-title">${EscapeAttribute(MetricLabel(label))} <span class="rd-sub">${perRun ? 'per run' : 'every client of every run'} · ${d.values.length} values</span></div>`
          + `<div class="rd-change"><b>${f(d.mean)}</b> <span class="rd-sub">± ${f(d.stddev)} (mean ± sd)</span></div>`
          + `<div class="rd-grid"><span>median</span><span>${f(d.median)}</span><span>range</span><span>${f(d.min)} – ${f(d.max)}</span></div>`
          + `<div class="rd-values">${d.values.map(v => `<span>${f(v)}</span>`).join('')}</div>`);
    });
  } else {
    // a single value: its field and exact value (the cell shows it rounded)
    cell.title = `${label}: ${stats.global.mean}`;
  }
  return cell;
}

// Column header of a metric; a click switches its cells between global and per-run statistics
function CreateMetricHeader(field, table, column) {
  const th = document.createElement('th');
  th.className = 'metric-header';
  th.textContent = MetricLabel(field);
  th.title = `${field}: mean ±standard deviation over all values (global); click to switch to per run`;
  th.onclick = (event) => {
      event.stopPropagation();
      const cells = [...table.querySelectorAll(`[data-column="${column}"][data-per-run]`)];
      if (cells.length === 0) return;
      // the value and the hover sections of each cell, as the former per-metric switch did
      let perRun = false;
      cells.forEach(cell => {
          cell.querySelectorAll('.global').forEach(element => element.classList.toggle('hidden'));
          cell.querySelectorAll('.perrun').forEach(element => perRun = !element.classList.toggle('hidden'));
      });
      th.textContent = `${MetricLabel(field)}${perRun ? ' (per run)' : ''}`;
  };
  return th;
}

function GetReferencedTasks(typeData) {
  if ((typeData?.index === undefined) || (typeData.index?.files === undefined) || 
      (typeData.index?.references === undefined) || (typeData.index.references?.libraries === undefined) || 
      (typeData?.metrics === undefined)) 
    return [];

  // Collect unique details_id from all libs
  const detailsIds = new Set();
  const libPerTask = {};
  for (const lib of Object.keys(typeData.index.references.libraries)) {
    const index = typeData.index.references.libraries[lib];
    if (!libPerTask[index]) {
      libPerTask[index] = [];
    }
    libPerTask[index].push(lib);
    detailsIds.add(index);
  }

  // Get unique tasks at those indices, deduplicate by task_id
  const tasks = [];
  for (const index of detailsIds) {
    const task = typeData.index.files[index];
    if (task && task.file && task.task_id) {
      tasks.push( { task, libs: libPerTask[index] });
    }
  }
  return tasks;
}

// the drop-downs open over the libraries table: close them on any click outside
document.addEventListener('click', (e) => {
  document.querySelectorAll('.action-dropdown-menu.visible').forEach(menu => {
    if (!menu.parentElement.contains(e.target)) menu.classList.remove('visible');
  });
});

function CreateActionDropdown(label, btnClass, tasks, onclickBuilder) {
  const wrapper = document.createElement('div');
  wrapper.className = 'action-dropdown';

  const trigger = document.createElement('button');
  trigger.textContent = `${label}`;
  trigger.className = btnClass;
  trigger.title = `${label}\nchoose: one of the ${tasks.length} tasks of these results`;
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close any other open dropdown
    document.querySelectorAll('.action-dropdown-menu.visible').forEach(m => {
      if (m !== menu) m.classList.remove('visible');
    });
    menu.classList.toggle('visible');
  });

  const menu = document.createElement('div');
  menu.className = 'action-dropdown-menu';

  for (const task of tasks) {
    const item = document.createElement('button');
    item.className = `action-dropdown-item ${btnClass}`;
    const libs = task.libs || [];
    item.textContent = libs.join(', ');
    item.setAttribute('onclick', onclickBuilder(task.task));
    item.addEventListener('click', () => menu.classList.remove('visible'));
    menu.appendChild(item);
  }

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  return wrapper;
}

function CreateActionButtons(typeData, type) {
  const actions = document.createElement('div');
  actions.className = 'actions';

  const tasks = GetReferencedTasks(typeData);

  // Fallback: no tasks array or single task → direct buttons
  if (tasks.length <= 1) {
    const taskId = tasks.length === 1 ? tasks[0].task.task_id : '';
    actions.innerHTML = `
      <button class="btn-details" onclick="ShowDetails('${taskId}')" title="📊 Details\nopens: the task on the board, its steps, logs and artefacts (new tab)">📊 Details</button>
      <button class="btn-download" onclick="DownloadResults('${taskId}')" title="⬇️ Download\nfile: the artefacts of the task (.tgz)">⬇️ Download</button>
    `;
    return actions;
  }

  // Multiple tasks → dropdown for each button
  actions.appendChild(CreateActionDropdown('📊 Details', 'btn-details', tasks, (task) => `ShowDetails('${task.task_id}')`));
  actions.appendChild(CreateActionDropdown('⬇️ Download', 'btn-download', tasks, (task) => `DownloadResults('${task.task_id}')`));

  return actions;
}

/*****************************************/

function RenderTypeSection(config, project, type, typeData, label, allMetrics, comparaisonElement) {
  const section = document.createElement('div');
  section.className = 'type-section';

  typeData?.index?.files?.forEach(file => {
    const span = document.createElement('span');
    span.id = `${file.task_id}`
    span.className = 'result-anchor';
    section.appendChild(span);
  })

  const typeHeaders = document.createElement('div');
  typeHeaders.className = 'type-headers';

  const headerLabel = document.createElement('div');
  headerLabel.className = 'type-header';

  const permanentLink = document.createElement('h3');
  const taskID = typeData.index?.files[0]?.task_id;
  if (taskID) {
    permanentLink.textContent = `🔗`;
    permanentLink.title = '🔗 Link\nclick: copies the link to these results';
    permanentLink.onclick = (event) => {
        const url = new URL(window.location.href);
        url.hash = taskID;
        CopyInClipboard(url.toString());
    }
  }
  headerLabel.appendChild(permanentLink); 

  if (type == "Campaign") {
    const displayLabel = document.createElement('a');
    displayLabel.textContent = label;
    displayLabel.href = config.vis_comparator_campaign(project, typeData.user, typeData.campaign_id);
    headerLabel.appendChild(displayLabel);
  } else {
    const displayLabel = document.createElement('span');
    displayLabel.textContent = label;
    headerLabel.appendChild(displayLabel);
  }

  typeHeaders.appendChild(headerLabel);
  const runInfo = RunInfoElement(typeData);
  if (runInfo) typeHeaders.appendChild(runInfo);
  // the tasks the libraries of the block come from (the publisher keeps the newest task of each library)
  if (runInfo) {
    const byTask = new Map();
    for (const [lib, i] of Object.entries(typeData.index?.references?.libraries ?? {})) {
      const id = typeData.index?.files?.[i]?.task_id;
      if (id) byTask.set(id, [...(byTask.get(id) ?? []), lib]);
    }
    if (!byTask.size && taskID) byTask.set(taskID, []);
    // a report exists for every Vuln task and for the tasks with objectives: no request for the others (a Perf task
    // without objective has none, final or live)
    const withObjectives = Object.values(typeData.status ?? {}).some(s => (s?.objectives?.total ?? 0) > 0 || s?.flag_objective);
    if (type === 'Vuln' || withObjectives) {
      for (const [id, libs] of [...byTask.entries()].sort()) AddReportBug(runInfo, id, byTask.size > 1 ? libs : []);
    }
  }
  AddRunsChip(typeHeaders, typeData.commit_id, type);

  const headerActions = document.createElement('div');
  headerActions.className = 'type-header-actions';
  if ((type == 'Perf') || (type == 'Campaign')) {
    const btnAnalyze = document.createElement('button');
    btnAnalyze.className = 'type-header-action';
    btnAnalyze.textContent = '🔬 Analyze';
    btnAnalyze.title = '🔬 Analyze\nopens: the libraries of these results in the Analyzer, against the dev base (new tab)';
    let libs = [];
    Object.keys(typeData.metrics).forEach(lib => libs.push(lib));
    btnAnalyze.onclick = (event) => {
      window.open(config.vis_comparator_perf_multiple(project, typeData.commit_id, libs), "_blank");
    }
    headerActions.appendChild(btnAnalyze);
  }
  if (comparaisonElement && typeData.global_status != 'fail') {
    const baseCommitID = comparaisonElement.srcCommit?.base;
    const index = allMetrics.findIndex(metric => metric.HaveCommit(baseCommitID));
    if (index != -1) {
      const btnCompare = document.createElement('button');
      btnCompare.className = 'type-header-action';
      btnCompare.textContent = '📈 Compare';
      btnCompare.title = '📈 Compare\nshows: these results against the compared commit, as graphs';
      btnCompare.onclick = () => {
          if (index == 0) {
            new GraphOverview(config, project, allMetrics[0], comparaisonElement).Open(true, comparaisonElement.type);
          } else {
            new GraphCompare(config, project, comparaisonElement.type, 
              [ allMetrics[index].GetCommitMetrics(baseCommitID), comparaisonElement.dataPoints ], 
              [ allMetrics[index].GetCommit(baseCommitID), comparaisonElement.srcCommit ]).Open();
          }
      };
      headerActions.appendChild(btnCompare);
    }
  }
  if (type === 'Campaign') {
    const headerDelete = document.createElement('button');
    headerDelete.className = 'type-header-action';
    headerDelete.innerHTML = `<h3>💣👾</h3>`;
    headerDelete.title = '💣👾 Delete\ndeletes: this results file (asks first)';
    headerDelete.onclick = DeleteResults.bind(this, config, project, section, typeData.source);
    headerActions.appendChild(headerDelete);
  }
  // Details / Download (drop-downs when several tasks contributed)
  for (const button of [...CreateActionButtons(typeData, type).children]) {
    headerActions.appendChild(button);
  }
  typeHeaders.appendChild(headerActions);

  section.appendChild(typeHeaders);

  if (typeData.metrics && Object.keys(typeData.metrics).length > 0) {
    section.appendChild(RenderLibrariesTable(config, project, type, typeData));
  }

  return section;
}

// One row per library: status, name (and its warnings and objectives), build, runs, then one column per metric
// (fields starting with "fail_", measured on the failed runs, go to a red sub-row under the library).
function RenderLibrariesTable(config, project, type, typeData) {
  const table = document.createElement('table');
  table.className = 'libs-table';
  const libraries = Object.entries(typeData.metrics).sort((a, b) => a[0].localeCompare(b[0]));
  const columns = [...new Set(libraries.flatMap(([, metrics]) => Object.keys(metrics)
      .filter(field => !field.startsWith('fail_') && field !== 'ratio_success_execution' && (metrics[field]?.length ?? 0) > 0)))];

  const head = document.createElement('tr');
  head.innerHTML = '<th class="col-lib">library</th><th class="col-build">build</th><th class="col-runs">runs</th>';
  columns.forEach((field, column) => head.appendChild(CreateMetricHeader(field, table, column)));
  table.appendChild(head);
  const nbColumns = 3 + columns.length;

  for (const [libName, metrics] of libraries) {
    const status = typeData.status[libName];
    const successCount = status?.success ?? '?';
    const totalRuns = status?.state.length ?? '?';
    const icon = status?.unsupported ? '⛔' : GetLibIcon(successCount, totalRuns);
    // what the icon means, on click
    const iconTip = status?.unsupported ? `⛔ not run: ${status.unsupported}`
        : icon === '✅' ? `✅ all ${totalRuns} runs succeeded`
        : icon === '⚠️' ? `⚠️ ${successCount} of ${totalRuns} runs succeeded: the others failed (see the red row below, or the task's logs)`
        : `⛔ none of the ${totalRuns} runs succeeded (the task's logs say why)`;

    // runs with objectives (perf: objective_size), when objectives of this library are trusted
    const warnUser = [];
    if ((type !== 'Vuln') && (status?.trust_objective === 1)) {
      if (metrics?.objective_size) {
        metrics.objective_size.forEach((attempt, index) => {
            if ((attempt.length === 1) && (attempt[0] > 0)) warnUser.push(index);
        });
      }
    }

    const libNameLabel = (type == 'Perf')
        ? `<a href="${config.vis_comparator_perf(project, typeData.commit_id, libName)}">${EscapeAttribute(libName)}</a>`
        : EscapeAttribute(libName);

    const row = document.createElement('tr');
    row.className = 'lib-row';
    const ratio = metrics?.ratio_success_execution?.[0];
    row.innerHTML = `
        <td class="col-lib"><span class="lib-icon" data-click-tip="${EscapeAttribute(iconTip)}">${icon}</span> <span class="lib-name">${libNameLabel}</span>`
          + `${GetCompatWarningIcon(status?.cli)} ${GetLogWarningIcon(status)} ${GetCrashWarningIcon(status)} ${GetObjectivesButton(status)}</td>
        <td class="col-build">${GetBuildCell(status?.cli)}</td>
        <td class="col-runs lib-stats" data-click-tip="${ratio !== undefined ? `${Number(ratio.toFixed(1))}% of the runs succeeded` : ''}">`
          + `${status?.unsupported ? 'not run' : `${successCount}/${totalRuns}`}</td>`;
    columns.forEach((field, column) => {
        const cell = CreateMetricCell(field, metrics[field]) ?? document.createElement('td');
        cell.dataset.column = column;
        cell.dataset.field = field;
        row.appendChild(cell);
    });
    row.dataset.library = libName;
    table.appendChild(row);

    // results without replayed objectives (older script): link to the page of objectives_report.sh when it exists
    const libTaskID = typeData.index?.files?.[typeData.index?.references?.libraries?.[libName]]?.task_id;
    if (!status?.objectives && ((warnUser.length > 0) || status?.flag_objective) && libTaskID) {
      AddObjectivesPageLink(row.querySelector('.lib-name'), libTaskID);
    }

    // failed runs: their metrics under the library, and the runs without an end-of-run summary (so without metrics)
    const failFields = Object.keys(metrics).filter(field => field.startsWith('fail_') && (metrics[field]?.length ?? 0) > 0);
    const missing = (status?.runs ?? []).filter(run => run.state == null);
    if ((failFields.length > 0) || (missing.length > 0)) {
      const failRow = document.createElement('tr');
      failRow.className = 'lib-fail-row';
      failRow.dataset.library = libName;
      const label = document.createElement('td');
      label.colSpan = 3;
      label.textContent = 'failed runs';
      failRow.appendChild(label);
      const cell = document.createElement('td');
      cell.colSpan = Math.max(1, columns.length);
      failFields.forEach(field => {
          const item = CreateMetricCell(field, metrics[field], 'span');
          if (item === null) return;
          item.insertAdjacentHTML('afterbegin', `<span class="stat-field">${EscapeAttribute(MetricLabel(field))}</span> `);
          // no column header here: a click on the item switches it between global and per run
          if (item.dataset.perRun) {
            item.onclick = (event) => {
                event.stopPropagation();
                item.querySelectorAll('.global').forEach(element => element.classList.toggle('hidden'));
                let perRun = false;
                item.querySelectorAll('.perrun').forEach(element => perRun = !element.classList.toggle('hidden'));
                item.querySelector('.stat-field').textContent = `${MetricLabel(field)}${perRun ? ' (per run)' : ''}`;
            };
          }
          cell.appendChild(item);
      });
      if (missing.length > 0) cell.appendChild(MissingSummaries(missing, typeData.errors?.[libName]));
      failRow.appendChild(cell);
      table.appendChild(failRow);
    }

    // objectives grouped by bug: a full-width row under the library, opened by its 🐞 button
    const objectivesButton = row.querySelector('.lib-objectives');
    if ((objectivesButton !== null) && (objectivesButton.tagName === 'BUTTON')) {
      const panel = ObjectivesPanel(status.objectives, libTaskID);
      panel.hidden = false;
      if (ConfirmedObjectives(status.objectives) === 0) panel.classList.add('unconfirmed');
      // the same bugs as the objectives report of the task, when it exists (else the groups of the summary above)
      if (libTaskID) ShowReportBugs(panel, objectivesButton, libTaskID, libName, status);
      const panelRow = document.createElement('tr');
      panelRow.className = 'lib-panel-row';
      panelRow.hidden = true;
      const panelCell = document.createElement('td');
      panelCell.colSpan = nbColumns;
      panelCell.appendChild(panel);
      panelRow.appendChild(panelCell);
      table.appendChild(panelRow);
      objectivesButton.addEventListener('click', (event) => {
        event.stopPropagation();
        panelRow.hidden = !panelRow.hidden;
      });
    } else if ((type === 'Vuln') && libTaskID && !status?.unsupported) {
      // no objective in any run: the 🎯 of the configuration all the same (0/n, red), from the report of its task;
      // the placeholder goes when the configuration has no expected bug
      const chip = document.createElement('span');
      chip.className = 'lib-objectives';
      chip.dataset.placeholder = '1';
      chip.textContent = '🎯 …';
      chip.title = 'The expected bug of this configuration: from the objectives report of its task';
      row.querySelector('.col-lib')?.appendChild(chip);
      ShowReportBugs(null, chip, libTaskID, libName, status);
    }
  }
  ApplyRegression(table, typeData.commit_id, type);
  return table;
}

// ── Comparison with the nearest ancestor (regression / improvement) ─────────────────────────────────────────
// /html/runs/regression.json (scripts/tools/runs_report.py): each commit's latest task against the latest task of its
// nearest git ancestor with results; regression_floors.json (editable): the rule and the noise floors. A change is
// flagged (coloured) when p <= rule.p_max and |change| > its floor; else it is shown faint. ⚠: the two sides are not
// comparable (build, monitor, machine load), the hover says why.
const REGRESSION_FIELDS = {
  Perf: { coverage: 'coverage', corpus: 'corpus_size', execs: 'total_execs' },
  Vuln: { execs_to_find: 'total_execs', time_to_find: 'durations_s' },
};
// lower is better for these
const LOWER_IS_BETTER = new Set(['execs_to_find', 'time_to_find']);
let regressionData = null;
function RegressionData() {
  regressionData ??= Promise.all([
    fetch('/html/runs/regression.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('/html/publisher/regression_floors.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  return regressionData;
}
function RegressionFloor(floors, machine, type, library, metric) {
  const m = floors?.per_machine?.[machine]?.[type]?.[metric];
  if (typeof m === 'number') return [m, `${machine}`];
  const l = floors?.per_library?.[type]?.[library]?.[metric];
  if (typeof l === 'number') return [l, `${library}`];
  const d = floors?.floors?.[type]?.[metric];
  return typeof d === 'number' ? [d, 'default'] : [null, 'none'];
}
// the details of a change or a value: the small window of the bench (tips.js: closed by a click elsewhere, Esc, or
// another click on it), with the colours of the details of Results
function ShowRegressionDetails(anchor, text) {
  OpenClickTip(anchor, text, 'reg-details');
}

async function ApplyRegression(table, commit, type) {
  if (!commit || !REGRESSION_FIELDS[type]) return;
  const [data, floors] = await RegressionData();
  const entry = data?.commits?.[commit]?.[`PR/${type}`];
  if (!entry || !floors) return;
  const pMax = floors.rule?.p_max ?? 0.016;
  const fields = REGRESSION_FIELDS[type];
  let up = 0, down = 0, warned = 0;
  const changes = [], warnings = [];  // for the hover of the line: what was flagged, what is not comparable
  for (const row of table.querySelectorAll('tr.lib-row')) {
    const lib = entry.libs?.[row.dataset.library];
    if (!lib) continue;
    const warn = lib.warn ?? [];
    if (warn.length) {
      warned++;
      warnings.push([row.dataset.library, warn]);
      row.querySelector('.col-lib')?.insertAdjacentHTML('beforeend', ` <span class="reg-warn" data-click-tip="${EscapeAttribute('Not comparable with ' + entry.base.slice(0, 7) + ': ' + warn.join('; '))}">⚠</span>`);
    }
    for (const [metric, field] of Object.entries(fields)) {
      const m = lib.metrics?.[metric];
      const cell = row.querySelector(`td[data-field="${field}"]`);
      if (!m || !cell) continue;
      const [floor, from] = RegressionFloor(floors, data.machine, type, row.dataset.library, metric);
      const flagged = m.p !== null && m.p <= pMax && floor !== null && Math.abs(m.delta) > floor;
      const better = LOWER_IS_BETTER.has(metric) ? m.delta < 0 : m.delta > 0;
      if (flagged) better ? up++ : down++;
      if (flagged) changes.push({ lib: row.dataset.library, metric, delta: m.delta, better, p: m.p });
      const fmt = (x) => Math.abs(x) >= 1000 ? `${(x / 1000).toFixed(x >= 1e6 ? 0 : 1)}k` : Number(x.toPrecision(4)).toString();
      // the details: structured, with the colours of the page (green better, red worse, grey not flagged, orange ⚠)
      const E = EscapeAttribute;
      const pass = { p: m.p !== null && m.p <= pMax, floor: floor !== null && Math.abs(m.delta) > floor };
      const verdict = flagged
          ? `<span class="${better ? 'reg-better' : 'reg-worse'}">${better ? '▲ improvement' : '▼ regression'}</span>`
          : `<span class="reg-faint">not flagged: ${!pass.p ? `p = ${m.p === null ? '—' : m.p.toFixed(3)} &gt; ${pMax}` : ''}${!pass.p && !pass.floor ? ' and ' : ''}${!pass.floor ? `|${Math.abs(m.delta).toFixed(1)} %| ≤ floor ${floor ?? '—'} %` : ''}</span>`;
      const label = metric.replace(/_/g, ' ');
      const title = `<div class="rd-title">${E(label)} <span class="rd-sub">vs ${E(entry.base.slice(0, 7))} · ${entry.gap} commits earlier</span></div>`
          + `<div class="rd-change">${E(fmt(m.base))} → <b>${E(fmt(m.value))}</b> <span class="${flagged ? (better ? 'reg-better' : 'reg-worse') : 'reg-faint'}">${m.delta >= 0 ? '+' : ''}${m.delta.toFixed(1)} %</span></div>`
          + `<div class="rd-grid">`
          + `<span>verdict</span><span>${verdict}</span>`
          + `<span>Mann-Whitney</span><span class="${pass.p ? '' : 'reg-faint'}">p = ${m.p === null ? '—' : m.p.toFixed(3)} <span class="rd-sub">(${m.n} vs ${m.n_base} runs, needs ≤ ${pMax})</span></span>`
          + `<span>noise floor</span><span class="${pass.floor ? '' : 'reg-faint'}">${floor ?? '—'} % <span class="rd-sub">(${E(from)})</span></span>`
          + `<span>better is</span><span class="rd-sub">${LOWER_IS_BETTER.has(metric) ? 'lower' : 'higher'}</span>`
          + `</div>`
          + (warn.length ? `<div class="rd-warn">⚠ not comparable<ul>${warn.map(w => `<li>${E(w)}</li>`).join('')}</ul></div>` : '')
          + (type === 'Vuln' && metric === 'execs_to_find' ? '<div class="rd-note">execs to find: the total execs when the objective was saved</div>' : '');
      // the details on click (a panel that stays), not on hover: less moving around
      const span = document.createElement('button');
      span.type = 'button';
      span.className = `reg-delta ${flagged ? (better ? 'reg-better' : 'reg-worse') : 'reg-faint'}`;
      span.addEventListener('click', (event) => { event.stopPropagation(); ShowRegressionDetails(span, title); });
      span.textContent = `${m.delta >= 0 ? '+' : ''}${Math.abs(m.delta) >= 10 ? m.delta.toFixed(0) : m.delta.toFixed(1)}%${warn.length ? '⚠' : ''}`;
      cell.appendChild(span);
    }
  }
  // short line: "vs 1957fba: 1 ▲ · 5 ⚠ · 4 ⚙"; a click gives the details, formatted
  const E = EscapeAttribute;
  const notes = entry.notes ?? [];
  const head = document.createElement('div');
  head.className = 'reg-head';
  head.innerHTML = `vs <span class="mono">${E(entry.base.slice(0, 7))}</span>: `
      + (up || down ? `${up ? `<b class="reg-better">${up} ▲</b>` : ''}${up && down ? ' ' : ''}${down ? `<b class="reg-worse">${down} ▼</b>` : ''}` : '<span class="reg-faint">≈</span>')
      + (warned ? ` · <span class="reg-warn">${warned} ⚠</span>` : '')
      + (notes.length ? ` · <span class="reg-notes">${notes.length} ⚙</span>` : '');
  const metricName = (metric) => metric.replace(/_/g, ' ');
  const details = `<div class="rd-title">vs ${E(entry.base.slice(0, 7))} <span class="rd-sub">nearest ancestor with ${E(type)} results · ${entry.gap} commits earlier · task ${E(entry.task)} vs ${E(entry.base_task)}</span></div>`
      + `<div class="rd-section">${changes.length ? `${changes.length} flagged change${changes.length > 1 ? 's' : ''} <span class="rd-sub">(▲ better, ▼ worse)</span>` : '≈ nothing flagged'} <span class="rd-sub">(p ≤ ${pMax} and beyond the noise floor)</span></div>`
      + (changes.length ? `<div class="rd-grid">${changes.map(c => `<span>${E(c.lib)}</span><span><span class="${c.better ? 'reg-better' : 'reg-worse'}">${c.better ? '▲' : '▼'} ${E(metricName(c.metric))} ${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(1)} %</span> <span class="rd-sub">p = ${c.p.toFixed(3)}</span></span>`).join('')}</div>` : '')
      + (warnings.length ? `<div class="rd-section reg-warn">⚠ ${warnings.length} not comparable</div><div class="rd-grid">${warnings.map(([lib, w]) => `<span>${E(lib)}</span><span class="rd-warn-text">${w.map(E).join('<br>')}</span>`).join('')}</div>` : '')
      + (notes.length ? `<div class="rd-section reg-notes">⚙ ${notes.length} setting${notes.length > 1 ? 's' : ''} differ${notes.length > 1 ? '' : 's'} <span class="rd-sub">(a change may come from the bench)</span></div><ul class="rd-list">${notes.map(n => `<li>${E(n)}</li>`).join('')}</ul>` : '')
      + `<div class="rd-note">Click a % for its details.</div>`;
  // its details on click only (tips.js: the small windows of the bench)
  head.addEventListener('click', (event) => { event.stopPropagation(); OpenClickTip(head, details, 'reg-details'); });
  // in the header line, after "run on … · bench …" (else above the table)
  const runInfo = table.closest('.type-section')?.querySelector('.type-headers .type-run');
  if (runInfo) {
    // before the 🐞 of the line (AddReportBug), which stays last
    const bug = runInfo.querySelector('.type-bugs-sep');
    runInfo.insertBefore(document.createTextNode(' · '), bug);
    runInfo.insertBefore(head, bug);
  } else {
    table.parentNode?.insertBefore(head, table);
  }
}

/*****************************************/

// Commit line of a card: "<sha> #<PR> <message>" (see commitinfo.js), then the branch and the date on the right
// "run on 06/10 16:06 · bench d10↗": when the results of a type last ran, and the puffin-bench version(s) that produced
// them (several when its libraries come from different tasks), each linked to its commit
// "🕘 N runs": the commit has several tasks of this type kept by the publisher (Results shows the latest); opens the
// page of all of them (scripts/tools/runs_report.py, /html/runs/)
let runsIndex = null;
async function AddRunsChip(parent, commit, type) {
  if (!commit) return;
  runsIndex ??= fetch('/html/runs/index.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
  const entries = Object.entries((await runsIndex)[commit] ?? {}).filter(([key]) => key.endsWith(`/${type}`));
  if (!entries.length) return;
  const [key, count] = entries.find(([k]) => k.startsWith('PR/')) ?? entries[0];
  if (count < 2) return;
  const chip = document.createElement('a');
  chip.className = 'type-runs';
  // a fragment: the publisher answers 404 to a URL with a query string
  chip.href = `/html/runs/runs.html#commit=${encodeURIComponent(commit)}&tab=${encodeURIComponent(key)}`;
  chip.target = '_blank';
  chip.rel = 'noopener';
  chip.textContent = `🕘 ${count} runs`;
  chip.title = `${count} tasks of this commit kept by the publisher (this card shows the latest): compare them, with the puffin-bench version of each (new tab)`;
  chip.addEventListener('click', (event) => event.stopPropagation());
  parent.appendChild(chip);
}

function RunInfoElement(typeData) {
  if (!typeData?.ran) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const ran = new Date(typeData.ran * 1000);
  const span = document.createElement('span');
  span.className = 'type-run';
  const when = document.createElement('span');
  when.dataset.clickTip = `last run ended ${ran.toLocaleString('en-GB')}`;
  when.textContent = `run on ${pad(ran.getDate())}/${pad(ran.getMonth() + 1)} ${pad(ran.getHours())}:${pad(ran.getMinutes())}`;
  span.appendChild(when);
  for (const [i, bench] of (typeData.benches ?? []).entries()) {
    span.append(i === 0 ? ' · bench ' : ', ');
    const link = document.createElement('a');
    link.textContent = `${String(bench.commit).slice(0, 3)}↗`;
    link.href = `${bench.repository || 'https://github.com/tlspuffin/puffin-bench'}/commit/${bench.commit}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = `puffin-bench ${String(bench.commit).slice(0, 10)}${bench.branch ? ` on ${bench.branch}` : ''}${bench.deployed ? `, deployed ${bench.deployed}` : ''}`;
    span.appendChild(link);
  }
  return span;
}

function CommitInfoElement(commit, withBranch) {
  const desc = describeCommit(commit, pullRequests);
  const info = document.createElement('div');
  info.className = 'commit-info';
  // commit, PR and message, then 🌿 branch · date
  info.innerHTML = `<span class="commit-id">${commitLineHTML(desc, { max: 90 })}</span>`
      + `<span class="commit-where" title="${withBranch ? '🌿 branch · date\nbranch: of the commit\ndate: of the commit' : 'date\ndate: of the commit'}">${withBranch ? `🌿 ${EscapeAttribute(commit?.branch ?? '')} · ` : ''}`
      + `<span class="date">${EscapeAttribute(commit.date || 'no date')}</span></span>`;
  return info;
}

// What the search box matches: the full sha, the PR numbers ("#453") and the message
function CommitSearchText(commit) {
  const desc = describeCommit(commit, pullRequests);
  return [commit.id, ...desc.prs.map(pr => `#${pr.number}`), desc.subject].join(' ').toLowerCase();
}

/*****************************************/

// When the commit last ran: the latest end of a fuzzing run among its results (seconds since the epoch, recorded by
// BuildDataSet as 'ran'), 0 without result
export function RunDate(commit) {
  let latest = 0;
  commit.infos?.forEach(typeData => {
    for (const data of (Array.isArray(typeData) ? typeData : [typeData])) {
      if ((data?.ran ?? 0) > latest) latest = data.ran;
    }
  });
  return latest;
}

export function RenderCommit(config, project, availableTypes, commit, allMetrics, container, srcMetrics) {
  const commitDiv = document.createElement('div');
  commitDiv.className = 'commit';
  commitDiv.dataset.commitId = commit.id;
  // the order of the commits: as listed (commit date) or by run date (see ApplyOrder in summary.js)
  commitDiv.dataset.order = container.querySelectorAll(':scope > .commit').length;
  commitDiv.dataset.run = RunDate(commit);

  const statuses = [];
  for (const type of availableTypes) {
    if (commit.infos?.has(type)) {
      statuses.push(commit.infos.get(type).global_status);
    } else {
      statuses.push('no run');
    }
  }
  commitDiv.dataset.statuses = JSON.stringify(statuses);

  const header = document.createElement('div');
  header.className = 'commit-header';

  const pastillesDiv = document.createElement('div');
  pastillesDiv.className = 'pastilles';

  for (const type of availableTypes) {
    const typeData = commit.infos?.get(type);
    if (typeData) {
      const pastille = document.createElement('div');
      pastille.className = 'pastille-item';
      pastille.innerHTML = `
        <span class="pastille ${GetPastilleClass(typeData.global_status)}" title="${EscapeAttribute(`${type} ${PASTILLE_MEANING[typeData.global_status] ?? '⚪\nstatus: no run'}`)}">
          ${GetPastilleIcon(typeData.global_status)}
        </span>
        <span class="pastille-label">${type}</span>
      `;
      pastillesDiv.appendChild(pastille);
    }
  }

  // commit line, branch and date, then the status of each result type
  header.appendChild(CommitInfoElement(commit, true));
  header.appendChild(pastillesDiv);
  commitDiv.appendChild(header);
  commitDiv.dataset.search = CommitSearchText(commit);

  // one column per result type on wide screens (summary.css .type-columns): Perf on the left, Vuln on the right
  const sections = document.createElement('div');
  sections.className = 'type-sections type-columns';
  sections.dataset.types = availableTypes.length;
  sections.style.setProperty('--types', availableTypes.length);
  commitDiv.appendChild(sections);

  let hasSections = false;
  for (const [column, type] of availableTypes.entries()) {
    const typeData = commit.infos?.get(type);
    if (!typeData) {
      // a click: the launcher of the Scheduler, pre-filled with this commit and the job type (board.js #launch=)
      const job = type === 'Perf' ? 'perf' : type === 'Vuln' ? 'vuln-a' : null;
      const board = config?.taskInfoURL?.replace(/task\.html$/, 'board.html');
      const slot = document.createElement(job && board && commit?.id ? 'a' : 'div');
      slot.className = 'type-slot-empty';
      slot.style.gridColumn = column + 1;
      slot.textContent = `no ${type} run`;
      if (slot.tagName === 'A') {
        slot.href = `${board}#launch=${encodeURIComponent(project ?? 'tlspuffin')}&job=${job}&commit=${commit.id}`;
        slot.target = '_blank';
        slot.rel = 'noopener';
        slot.title = `Launch ${type === 'Vuln' ? 'VulnA' : type} on ${commit.id.slice(0, 7)}: the launcher of the Scheduler, pre-filled (new tab)`;
        slot.insertAdjacentHTML('beforeend', ' <span class="slot-launch">▶ launch</span>');
      }
      sections.appendChild(slot);
    }
    if (typeData) {
      let comparaisonElement = null;
      if ((srcMetrics != null) && (commit?.base) && (commit.base != commit.id)) {
        comparaisonElement = {
            type: type,
            highlights: [commit.base, commit.id],
            srcCommit: commit,
            dataPoints: srcMetrics.GetCommitMetrics(commit.id)
        };
      }
      const typeSection = RenderTypeSection(config, project, type, typeData, type, allMetrics, comparaisonElement);
      typeSection.dataset.type = type;
      typeSection.style.gridColumn = column + 1;
      sections.appendChild(typeSection);
      hasSections = true;
    }
  }

  if (!hasSections) {
    // a click: the launcher of the Scheduler, pre-filled with this commit and the PR job (VulnA and Perf)
    const board = config?.taskInfoURL?.replace(/task\.html$/, 'board.html');
    const noResultsDiv = document.createElement(board && commit?.id ? 'a' : 'div');
    noResultsDiv.className = 'no-run';
    noResultsDiv.textContent = 'No results for this commit';
    if (noResultsDiv.tagName === 'A') {
      noResultsDiv.href = `${board}#launch=${encodeURIComponent(project ?? 'tlspuffin')}&job=evaluate-pr&commit=${commit.id}`;
      noResultsDiv.target = '_blank';
      noResultsDiv.rel = 'noopener';
      noResultsDiv.title = `Launch a PR task (VulnA and Perf) on ${commit.id.slice(0, 7)}: the launcher of the Scheduler, pre-filled (new tab)`;
      noResultsDiv.insertAdjacentHTML('beforeend', ' <span class="no-run-launch">▶ launch PR</span>');
    }
    // on the commit line, after the branch and date: a commit without results takes one line
    const info = commitDiv.querySelector('.commit-header .commit-info');
    if (info) {
      noResultsDiv.classList.add('no-run-inline');
      info.appendChild(noResultsDiv);
      sections.remove();
    } else {
      sections.replaceWith(noResultsDiv);
    }
  }

  if (commit?.state) {
    commitDiv.dataset.state = commit.state;
  }

  container.appendChild(commitDiv);
}

export function RenderCampaigns(config, project, commit, allMetrics, container) {
  const campaignList = commit.infos?.get('Campaign');
  if (!campaignList || campaignList.length === 0) return;

  const campaignDiv = document.createElement('div');
  campaignDiv.className = 'commit';
  campaignDiv.dataset.commitId = commit.id;
  // the order (see ApplyOrder in summary.js): as listed, or by the latest end of a campaign run, else its launch
  // (the time at the end of its campaign id)
  campaignDiv.dataset.order = container.querySelectorAll(':scope > .commit').length;
  campaignDiv.dataset.run = Math.max(RunDate(commit),
      ...campaignList.map(c => Math.floor((Number(String(c.campaign_id ?? '').split('-').pop()) || 0) / 1000)));

  const header = document.createElement('div');
  header.className = 'commit-header';

  header.appendChild(CommitInfoElement(commit, false));
  campaignDiv.appendChild(header);
  campaignDiv.dataset.search = CommitSearchText(commit);

  const sections = document.createElement('div');
  sections.className = 'type-sections';
  campaignDiv.appendChild(sections);

  for (const campaign of campaignList) {
    const timestamp = Number(campaign.campaign_id.split('-').pop());
    let date = '';
    if (timestamp) {
      date = ' / [' + new Date(timestamp).toLocaleString(navigator.languages, {
          month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false}) + ']';
    }

    let comparaisonElement = null;
    if ((commit?.base) && (commit.base != commit.id)) {
      comparaisonElement = {
          type: 'Perf', 
          highlights: [commit.base, commit.id],
          srcCommit: commit,
          dataPoints: MetricsCampaign.GetMetrics(campaign)
      };
    }

    const typeSection = RenderTypeSection(
        config, project, 
        'Campaign', 
        campaign, `👤 ${campaign.user} / ${campaign.campaign_id}${date}`,
        allMetrics, 
        comparaisonElement
    );
    typeSection.dataset.user = campaign.user;
    typeSection.dataset.campaignId = campaign.campaign_id;
    typeSection.dataset.status = campaign.global_status ?? 'no run';
    sections.appendChild(typeSection);
  }
  container.appendChild(campaignDiv);
}

/*****************************************/

export function ShowDetails(config, taskID) {
  window.open(`${config.taskInfoURL}?id=${taskID}`);
}

export function DownloadResults(config, taskID) {
  const a = document.createElement('a');
  a.href = config.artefactURL(taskID);
  a.download = `${taskID}-artefacts.tgz`;
  a.click();
}

async function DeleteResults(config, project, div, data, event) {
  if (!confirm(`Delete results file:\n\t${data} ?`)) return;

  DisableUI();
  try {
    const response = await fetch(`${config.urlData(project)}/${data}`, { method: 'DELETE' });
    const json = await response.json();
    if (json.success) {
      const commitDiv = div.parentElement;
      div.remove();
      if (commitDiv && !commitDiv.querySelector('.type-section')) {
        commitDiv.remove();
      }
    } else {
      alert(`Server denied deletion of: ${data}\n${json.error ?? ''}`);
    }
  } catch(e) {
    alert('Fatal error while trying remove results: ' + e.name + ' : ' + e.message);
  }
  EnableUI();
}
