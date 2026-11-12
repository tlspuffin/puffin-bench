// report_verdicts.js <report json>: the verdicts of objectives_page/bugs.js written into an objectives report, for the
// tools that do not run bugs.js: the Runs page (runs_report.py) and the 🐞 🎯 of the scheduler's history page
// (objectives_report.sh TaskLinks). The pages compute them again from the same report with the same code, so that every
// page and tool tells the same: which runs found the expected bug (counted), which of them did not end normally (untimed:
// no time to find), the conclusion of the task.
// Run by objectives_report.sh after each report, with the qjs of the bench: qjs --std -m report_verdicts.js <file>
// [<catalogue json>]: the catalogue the report's validation used (git_restapi's, as the page loads it): the top frames
// that make a signature verdict strong
//
// Added to the report:
//   verdicts: { conclusion: ExpectedConclusion (null without a configuration with a target),
//               libraries: { <configuration>: { cve, runs, found, counted, untimed: [{ attempt, why }], level,
//                            pre_target (its job scripts had no target),
//                            first_expected: { <attempt>: <name of its first objective of the expected bug> },
//                            script_disagrees: [{ attempt, script, report }] } },
//               bugs: { count, objectives, confirmed },
//               headline: BugsHeadline (the title of the report: { real, confirmed, new, allKnown, level,
//                         nothingExpected, text }),
//               history: { level, title }: the 🐞 of the history page, its colour (the level: new, unexpected,
//                        warning for nothing reproduced; plain for known bugs) and its hover, in the words of ../../data/html/common/verdicts.js }
// The bugs get the validation's verdicts first (BugValidation, without the catalogue: the names and signatures of the
// bugs are in the report's validation), as on the page: the same new bugs, the same level.
//   new: the bugs of NewBugs, with the registry next to the report (known_bugs.json) as the page reads it
//   script_disagrees: the runs whose job scripts (their summary: nb_objective_targeted, ObjectiveCounts in
//   PR_vulnerabilities.sh) and bugs.js disagree on the expected bug, for the runs whose job scripts had the target

import { ExpectedConclusion, RunFailures, IsExpected, VerdictOf, AnalyseReport, VendorOfRun } from './objectives_page/bugs.js';
import { LEVELS } from './common/verdicts.js';

const file = scriptArgs[1];
let catalogue = null;
try { catalogue = scriptArgs[2] ? JSON.parse(std.loadFile(scriptArgs[2])) : null; } catch (error) { catalogue = null; }
if (catalogue?.format !== 'vulnerabilities.toml') catalogue = null;
// the stacks of the witnesses of the bugs without top frames, computed once for the reports validated before validation
// recorded them (tools/witness_stacks.py: PB_WITNESS_FRAMES, { ID: { frames } })
let witnessFrames = {};
try { witnessFrames = std.getenv('PB_WITNESS_FRAMES') ? JSON.parse(std.loadFile(std.getenv('PB_WITNESS_FRAMES'))) ?? {} : {}; } catch (error) { witnessFrames = {}; }
// whether each bug given by commits (a bug of tlspuffin's harness: affected_commits) is in the report's commit, from git
// (objectives_report.sh Verdicts: PB_COMMIT_AFFECTED, { ID: true when the commit lacks its fix })
let affectedAtCommit = {};
try { affectedAtCommit = JSON.parse(std.getenv('PB_COMMIT_AFFECTED') || '{}') ?? {}; } catch (error) { affectedAtCommit = {}; }
// the catalogue's flags the readers of the report need without it (the objectives pages, Results): whether a bug's
// objectives replay, its top frames (the strength of a signature verdict), into the validation's record of each entry
const enrich = (report) => {
  if (!catalogue) return;
  // and the catalogue's entries of the libraries of the report in brief (catalogue_digest: alias, oracle, replayable, top
  // frames), for a report whose validation has no entries (older ones, unsupported): AnalyseReport's catalogue when the
  // reader has none
  const vendors = new Set((report.runs ?? []).map(run => VendorOfRun(run)).filter(Boolean));
  // into the catalogue's entries, which the analysis below reads, as the digest gives them to the pages: one set of data
  for (const v of Object.values(catalogue.vendors ?? {})) {
    for (const [id, e] of Object.entries(v.entries ?? {})) {
      if (!e.witness_frames?.length && witnessFrames[id]?.frames?.length) e.witness_frames = witnessFrames[id].frames;
      if (typeof affectedAtCommit[id] === 'boolean') e.affected_at_commit = affectedAtCommit[id];
    }
  }
  // latest: the report's commit has no catalogue, this is the newest one (PB_CATALOGUE_LATEST): it names the bugs by their
  // signature with their stack, without validation
  report.catalogue_digest = { format: catalogue.format, commit: catalogue.commit ?? null, latest: !!std.getenv('PB_CATALOGUE_LATEST'), vendors: Object.fromEntries(
      [...vendors].filter(v => catalogue.vendors?.[v]).map(v => [v, { entries: Object.fromEntries(Object.entries(catalogue.vendors[v].entries ?? {})
          .map(([id, e]) => [id, { alias: e.alias ?? null, oracle: e.oracle ?? null, replayable: e.replayable ?? null, top_frames: e.top_frames ?? null,
                                   affected: e.affected ?? null, affected_commits: e.affected_commits ?? null,
                                   affected_at_commit: e.affected_at_commit ?? null, witness_frames: e.witness_frames ?? null }])) }])) };
  for (const lib of report.libraries ?? []) {
    for (const [id, entry] of Object.entries(lib.validation?.entries ?? {})) {
      const known = Object.values(catalogue.vendors ?? {}).map(v => v.entries?.[id]).find(Boolean);
      if (!known || !entry) continue;
      if (entry.replayable == null && known.replayable != null) entry.replayable = known.replayable;
      if (!entry.top_frames && known.top_frames?.length) entry.top_frames = known.top_frames;
      // (witness_frames_once: from the stacks computed once, not from this validation)
      if (!entry.witness_frames && witnessFrames[id]?.frames?.length) { entry.witness_frames = witnessFrames[id].frames; entry.witness_frames_once = true; }
    }
  }
};
let report;
try {
  report = JSON.parse(std.loadFile(file));
} catch (error) {
  std.err.puts(`${file}: not a report (${error})\n`);
  std.exit(1);
}

enrich(report);
const runs = report.runs ?? [];
const libraries = report.libraries ?? [];
// the page's analysis (bugs.js AnalyseReport), with the registry next to the report (known_bugs.json) and the catalogue
// of its validation, as the page reads them (the names and signatures of the bugs are in the report's validation; the
// catalogue adds the top frames that make a signature verdict strong)
let known = null;
try { known = JSON.parse(std.loadFile(file.replace(/[^/]*$/, '') + 'known_bugs.json') ?? 'null'); } catch (error) {}
const analysis = AnalyseReport(report, known, catalogue);
const expected = analysis.expectedRuns;
const out = {};
for (const [library, o] of Object.entries(expected)) {
  const lib = libraries.find(l => l.library === library);
  const why = Object.fromEntries(RunFailures(lib, report.job_type).map(f => [f.attempt, f.why]));
  // the first objective of the expected bug of each run (names start with their UTC time: the smallest is the first)
  const firstExpected = {};
  for (const run of runs.filter(r => r.library === library)) {
    const verdictOf = VerdictOf(libraries, library, run.attempt);
    const names = (run.groups ?? []).filter(g => IsExpected(o.target, g, verdictOf)).map(g => g.first).filter(Boolean).sort();
    if (names.length) firstExpected[run.attempt] = names[0];
  }
  // the job scripts' verdict (with the same target only: earlier job scripts had none, any objective ended a run)
  const disagrees = [];
  for (const [attempt, s] of Object.entries(lib?.script ?? {})) {
    if (s?.cve !== o.target.cve || typeof s.targeted !== 'number') continue;
    const script = s.targeted > 0, found = o.found.has(Number(attempt));
    if (script !== found) disagrees.push({ attempt: Number(attempt), script, report: found });
  }
  out[library] = { cve: o.target.cve, runs: [...o.runs].sort((a, b) => a - b), found: [...o.found].sort((a, b) => a - b),
                   counted: [...o.counted].sort((a, b) => a - b),
                   untimed: o.untimed.map(attempt => ({ attempt, why: why[attempt] ?? null })), level: o.level,
                   provisional: o.provisional, pre_target: o.preTarget, first_expected: firstExpected, script_disagrees: disagrees };
}
// the bugs of the task as the page lists them (reproduced by a replay, or recorded by the fuzzer)
const all = analysis.bugs;
const bugs = all.filter(bug => bug.reproduced > 0 || bug.fuzzer);
const { alarm, found, ...headline } = analysis.headline;
const counts = { count: bugs.length, objectives: runs.reduce((sum, run) => sum + (run.found ?? 0), 0),
                 confirmed: bugs.reduce((sum, bug) => sum + (bug.reproduced ?? 0), 0) };
// the 🐞 of the history page: its colour from the level (new: 🚨, unexpected: gold, nothing reproduced: warning, outlined;
// known bugs: plain), its hover
const level = headline.level ? LEVELS[headline.level] : null;
const history = {
  level: ['new', 'unexpected'].includes(headline.level) ? headline.level : headline.level === 'unclear' ? 'warning' : null,
  title: [
    `🐞 ${counts.objectives} objective${counts.objectives === 1 ? '' : 's'}, ${counts.count} bug${counts.count === 1 ? '' : 's'}, ${counts.confirmed} objective${counts.confirmed === 1 ? '' : 's'} reproduced by a replay`,
    level ? `${level.mark ? `${level.mark} ` : ''}${level.word}: ${level.tip}` : '',
    headline.new ? `${alarm}: ${all.filter(bug => bug.isNew).map(bug => bug.frames?.[0] ?? bug.key).slice(0, 3).join(', ')}` : '',
    headline.nothingExpected?.length ? `no known bug expected in ${headline.nothingExpected.join(', ')}` : '',
    'Click: the objectives report, grouped by bug (new tab)',
  ].filter(Boolean).join('\n'),
};
report.verdicts = {
  conclusion: ExpectedConclusion(expected),
  libraries: out,
  bugs: counts,
  headline,
  history
};
const tmp = `${file}.verdicts.tmp`;
const f = std.open(tmp, 'w');
if (!f) { std.err.puts(`${tmp}: cannot write\n`); std.exit(1); }
f.puts(JSON.stringify(report));
f.close();
if (os.rename(tmp, file) !== 0) { std.err.puts(`${file}: cannot replace\n`); std.exit(1); }
