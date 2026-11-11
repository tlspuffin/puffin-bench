#!/bin/bash
# results_regression_test.sh: what Results shows of the comparison with the nearest ancestor (publisher/summary_render.js
# ApplyRegression, on runs_report.py's regression.json and regression_floors.json), under node with the page's own code
# (results_page.mjs):
#   - a change beyond its floor with p <= p_max is coloured (▼ worse, ▲ better) and counted in the line "vs <base>";
#   - a library marked ⚠ not comparable (another build, CPU sharing, major version): its changes are shown faint, never
#     ▲/▼, not counted, and its details say "not comparable" (F14);
#   - the Runs page (runs_page/runs.js): between two tasks of a commit, the significant differences, but where the two
#     do not compare (another major version of the measurements; a CPU sharing recorded by one of them only, or
#     two different ones): then none is called significant.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
command -v node > /dev/null || { echo "SKIP: no node"; exit 0; }
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
command cp -f "${here}/results_page.mjs" "${work}/results_page.mjs"
cat > "${work}/test.mjs" <<'JS'
import { Prepare, InstallShims, WriteFixture, RegressionTable, Shown } from './results_page.mjs';
const root = process.env.WORK, repo = process.env.REPO;
let fail = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail = 1; };
const page = Prepare(root, repo);
InstallShims(root);
const metric = (delta, p) => ({ value: 100 + delta, base: 100, delta, p, n: 5, n_base: 5 });
WriteFixture(root, 'publisher/regression_floors.json', { rule: { p_max: 0.016 }, floors: { Perf: { coverage: 1, corpus: 5, execs: 5 } } });
WriteFixture(root, 'runs/regression.json', { machine: 'm', commits: {
  // A: comparable, worse beyond its floor; B: not comparable, worse by far; C: comparable, within its floor
  c1: { 'PR/Perf': { base: 'b0b0b0b0', gap: 2, task: '2', base_task: '1', notes: [], libs: {
    A: { warn: [], metrics: { coverage: metric(-5, 0.001) } },
    B: { warn: ['CPU sharing: twin vs pairs'], metrics: { coverage: metric(-20, 0.0001) } },
    C: { warn: [], metrics: { coverage: metric(-0.5, 0.001) } } } } },
} });
const { ApplyRegression } = await import(page);
const table = RegressionTable(['A', 'B', 'C'], ['coverage']);
await ApplyRegression(table, 'c1', 'Perf');
const s = Shown(table, 'coverage');
check(s.rows.A.cls.includes('reg-worse') && /regression/.test(s.rows.A.details), 'a comparable change beyond its floor: ▼, red');
check(s.rows.C.cls.includes('reg-faint'), 'a change within its floor: faint');
check(s.rows.B.warn && s.rows.B.text.endsWith('⚠'), 'a library not comparable: ⚠ beside its name and its %');
check(s.rows.B.cls.includes('reg-faint') && !s.rows.B.cls.includes('reg-worse'), 'a library not comparable: its change faint, never ▼');
check(/not comparable/.test(s.rows.B.details) && !/regression/.test(s.rows.B.details), 'its details: not comparable, no verdict of regression');
check(/1 ▼/.test(s.head) && !/2 ▼/.test(s.head) && /1 ⚠/.test(s.head), `the line counts the comparable change only: "${s.head}"`);
check(/^1 flagged change/m.test(s.headDetails.replace(/<[^>]*>/g, '\n')) && !/>B</.test(s.headDetails.split('not comparable')[0]),
  'its details list the comparable change only, the other under "not comparable"');

// the Runs page: between two tasks of a commit, the differences tested (Mann-Whitney, p < 0.05), unless the two do not
// compare (another major version of the measurements): then none is called significant
const { RunsPage } = await import('./results_page.mjs');
const perRun = (base) => Object.fromEntries(['coverage', 'coverage_10min', 'corpus', 'execs', 'execs_s', 'success']
  .map(k => [k, [0, 1, 2, 3, 4].map(i => base + i * 0.1)]));
const task = (id, start, base, major, cpus = null) => ({ id, name: `PR@abc-Perf ${id}`, user: 'u', job_type: 'perf', start, end: start + 60, cpus: cpus ? { A: cpus } : {},
  settings: { timeout: [4200], cores: [3], compat: '', libafl: '0.15.4' }, jobscript_md5: 'm', jobscripts: { commit: 'j'.repeat(40), from: 'recorded' },
  bench: major ? { major } : {}, metrics: { A: { runs: 5, runs_total: 5, ...perRun(base), per_run: perRun(base) } } });
const commit = 'c'.repeat(40);
WriteFixture(root, 'runs/index.json', { [commit]: { 'PR/Perf': 4 } });
WriteFixture(root, `runs/${commit}-PR-Perf.json`, { tasks: [task('1', 1000, 10, null), task('2', 2000, 20, null), task('3', 3000, 30, 2),
                                                           task('4', 4000, 40, 2, { smt: 'pairs', shared: false, nodes: 1 })] });
const runs = await RunsPage(root, repo, `#commit=${commit}&tab=PR/Perf`);
const lines = [...runs.matchAll(/<tr class="sep[^"]*"><td[^>]*>(.*?)<\/td><\/tr>/g)].map(m => m[1]);
check(lines.length === 3, `the Runs page: a line between each two tasks (${lines.length})`);
check(/significant: A coverage at the end ↑ p=0\.008/.test(lines[0] ?? ''), 'two tasks that compare: their significant differences listed');
check(/major version 1 → 2 \(not comparable\)/.test(lines[1] ?? '') && !/significant:/.test(lines[1] ?? '')
  && /differences not tested \(not comparable\)/.test(lines[1] ?? ''), 'two tasks that do not compare: no difference called significant');
check(/CPU sharing not recorded \(logical CPUs\) → pairs \(not comparable\)/.test(lines[2] ?? '') && !/significant:/.test(lines[2] ?? ''),
  'a CPU sharing recorded by one task only: noted, not comparable');
process.exit(fail);
JS
WORK="${work}" REPO="$( cd "${here}/../../.." && pwd )" node "${work}/test.mjs"
