// report_verdicts.js <report json>: the verdicts of objectives_page/bugs.js written into an objectives report, for the
// tools that do not run bugs.js: the Runs page (runs_report.py) and the 🐞 🎯 of the scheduler's history page
// (objectives_report.sh TaskLinks). The pages compute them again from the same report with the same code, so that every
// page and tool tells the same: which runs found the expected bug (counted), which of them did not end normally (untimed:
// no time to find), the conclusion of the task.
// Run by objectives_report.sh after each report, with the qjs of the bench: qjs --std -m report_verdicts.js <file>
//
// Added to the report:
//   verdicts: { conclusion: ExpectedConclusion (null without a configuration with a target),
//               libraries: { <configuration>: { cve, runs, found, counted, untimed: [{ attempt, why }], level,
//                            pre_target (its job scripts had no target),
//                            first_expected: { <attempt>: <name of its first objective of the expected bug> },
//                            script_disagrees: [{ attempt, script, report }] } },
//               bugs: { count, objectives, confirmed },
//               headline: BugsHeadline (the title of the report: { real, confirmed, new, allKnown, celebrate, text }) }
//   new: the bugs of NewBugs, with the registry next to the report (known_bugs.json) as the page reads it
//   script_disagrees: the runs whose job scripts (their summary: nb_objective_targeted, ObjectiveCounts in
//   PR_vulnerabilities.sh) and bugs.js disagree on the expected bug, for the runs whose job scripts had the target

import { Bugs, ExpectedRuns, ExpectedConclusion, RunFailures, IsExpected, NewBugs, BugsHeadline } from './objectives_page/bugs.js';

const file = scriptArgs[1];
let report;
try {
  report = JSON.parse(std.loadFile(file));
} catch (error) {
  std.err.puts(`${file}: not a report (${error})\n`);
  std.exit(1);
}

const runs = report.runs ?? [];
const libraries = report.libraries ?? [];
const expected = ExpectedRuns(runs, report.targets ?? {}, libraries);
const out = {};
for (const [library, o] of Object.entries(expected)) {
  const lib = libraries.find(l => l.library === library);
  const why = Object.fromEntries(RunFailures(lib, report.job_type).map(f => [f.attempt, f.why]));
  // the first objective of the expected bug of each run (names start with their UTC time: the smallest is the first)
  const firstExpected = {};
  for (const run of runs.filter(r => r.library === library)) {
    const names = (run.groups ?? []).filter(g => IsExpected(o.target, g)).map(g => g.first).filter(Boolean).sort();
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
// the bugs of the task as the page lists them (confirmed by a replay, or recorded by the fuzzer)
const all = Bugs(runs, report.not_targeted, report.targets);
const bugs = all.filter(bug => bug.reproduced > 0 || bug.fuzzer);
// the title of the page: its new bugs (the registry of the bugs found so far, next to the report) and real bugs
let known = null;
try { known = JSON.parse(std.loadFile(file.replace(/[^/]*$/, '') + 'known_bugs.json') ?? 'null'); } catch (error) {}
const { alarm, found, ...headline } = BugsHeadline(all, NewBugs(all, known, report.task, report), report);
report.verdicts = {
  conclusion: ExpectedConclusion(expected),
  libraries: out,
  bugs: { count: bugs.length, objectives: runs.reduce((sum, run) => sum + (run.found ?? 0), 0),
          confirmed: bugs.reduce((sum, bug) => sum + (bug.reproduced ?? 0), 0) },
  headline
};
const tmp = `${file}.verdicts.tmp`;
const f = std.open(tmp, 'w');
if (!f) { std.err.puts(`${tmp}: cannot write\n`); std.exit(1); }
f.puts(JSON.stringify(report));
f.close();
if (os.rename(tmp, file) !== 0) { std.err.puts(`${file}: cannot replace\n`); std.exit(1); }
