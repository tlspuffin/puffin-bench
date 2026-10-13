// known_bugs.js <objectives dir>: the registry of the bugs found so far, per library, for the "🚨 new bug" alerts
// (objectives_page/bugs.js NewBugs): "<library>|<signature>" (BugSignature: the claim, or the top function of the crash) -> { task, started, what } of the first task that had it,
// from every final report (<task>.json) of the objectives pages, oldest first. Run by objectives_report.sh --all with
// the qjs of the bench: qjs --std -m known_bugs.js <dir>
import { Bugs, BugSignature } from './objectives_page/bugs.js';

const dir = scriptArgs[1];
const [names, err] = os.readdir(dir);
if (err) { std.err.puts(`cannot read ${dir}\n`); std.exit(1); }
const reports = [];
for (const name of names) {
  if (!/^[0-9]+\.json$/.test(name)) continue;
  try {
    const r = JSON.parse(std.loadFile(`${dir}/${name}`));
    if (r?.runs?.length) reports.push(r);
  } catch (error) { /* a report being written */ }
}
// oldest first: the start of the task, else its id (a timestamp)
reports.sort((a, b) => (Date.parse(a.started ?? '') || Number(a.task)) - (Date.parse(b.started ?? '') || Number(b.task)));
const known = {};
for (const r of reports) {
  for (const bug of Bugs(r.runs, r.not_targeted, r.targets)) {
    if (!(bug.reproduced > 0 || bug.fuzzer)) continue;
    const sig = BugSignature(bug);
    if (!sig) continue;  // a crash without location: not comparable across tasks
    for (const lib of new Set(bug.runs.map(run => run.library))) {
      known[`${lib}|${sig}`] ??= { task: String(r.task), started: r.started ?? null,
        what: `${bug.type}: ${(bug.frames ?? []).join(' < ') || bug.summary || ''}`.slice(0, 200) };
    }
  }
}
const out = `${dir}/known_bugs.json`;
const f = std.open(`${out}.tmp`, 'w');
f.puts(JSON.stringify(known));
f.close();
os.rename(`${out}.tmp`, out);
std.out.puts(`${Object.keys(known).length} bug signatures from ${reports.length} reports\n`);
