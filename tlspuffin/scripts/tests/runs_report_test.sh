#!/bin/bash
# runs_report_test.sh: what tools/runs_report.py says of two tasks Results compares (regression: the warnings that make
# a library not comparable, ⚠ on Results) and the noise floors it measures, on task records made here (no archive, no
# git: the nearest ancestor is given):
#   - a CPU sharing recorded on one side only is not comparable, as two different ones; the same on both sides,
#     or none recorded on both, is;
#   - a task with a twin run is of major version 2, whatever its job scripts recorded: not comparable with 3-client
#     runs of major 1, on Results and on the Runs page (page_record);
#   - the floors are measured on pairs of tasks with the same CPU sharing only, also when one did not record it;
#   - a side of a comparison that ran before a compat rule its commit gets today: noted, listed to run again.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
PB_ROOT="${work}" python3 -I - "${here}/../tools/runs_report.py" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location('runs_report', sys.argv[1])
rr = importlib.util.module_from_spec(spec); spec.loader.exec_module(rr)
fail = 0
def check(ok, what):
    global fail
    print(('ok  ' if ok else 'FAIL') + ' ' + what)
    fail |= not ok

def task(tid, base, cpus=None, major=None):
    # a Perf task of one library A, 5 runs; cpus: its record (smt, shared), None: not recorded
    runs = [base + i for i in range(5)]
    return {'id': tid, 'start': int(tid), 'settings': {'timeout': [4200], 'cores': [3], 'compat': '', 'libafl': '0.15.4'},
            'jobscripts': {'commit': 'j' * 40}, 'builds': {'A': {'library': 'a', 'version': '1', 'harness': 'C', 'asan': False}},
            'load': {}, 'cpus': {'A': {'smt': cpus[0], 'shared': cpus[1], 'nodes': 1}} if cpus else {},
            'bench': {'commit': 'b' * 40, 'major': major} if major else {'commit': 'b' * 40},
            'metrics': {'A': {'runs': 5, 'runs_total': 5, 'per_run': {'coverage': runs, 'corpus': runs, 'execs': runs}}}}

def warnings(base_task, task_):
    rr.ancestors_with_data = lambda commits: {'c' * 40: ('a' * 40, 1)}
    out = rr.regression({('PR', 'Perf'): {'a' * 40: [base_task], 'c' * 40: [task_]}})
    entry = out['c' * 40]['PR/Perf']
    return entry['libs']['A']['warn'], entry

w, _ = warnings(task('1', 100), task('2', 50, ('pairs', False)))
check(any(x.startswith('CPU sharing not recorded') and x.endswith('→ pairs') for x in w), f'CPU sharing recorded on one side only: not comparable ({w})')
w, _ = warnings(task('1', 100, ('pairs', False)), task('2', 50, ('one', True)))
check(any(x == 'CPU sharing pairs → one, cores shared with others' for x in w), f'two CPU sharings: not comparable ({w})')
w, _ = warnings(task('1', 100), task('2', 50))
check(not w, f'none recorded on both sides: comparable ({w})')
w, _ = warnings(task('1', 100, ('pairs', False)), task('2', 50, ('pairs', False)))
check(not w, f'the same on both sides: comparable ({w})')
# commit 1425991's calibration task against dcf9ff4: twin runs, no major version recorded, against 3-client runs
w, entry = warnings(task('1', 100), task('2', 50, ('twin', True)))
check('puffin-bench major version 1 → 2' in w and entry['major'] == 2, f'twin runs without a recorded major version: major 2, not comparable with major 1 ({w})')
check(rr.major(task('2', 50, ('twin', True), major=1)) == 2 and rr.major(task('2', 50, ('pairs', False), major=2)) == 2
      and rr.major(task('2', 50)) == 1, 'major: recorded, else 1; 2 at least with a twin run')
page = rr.page_record({**task('2', 50, ('twin', True)), 'stamp': [1]})
check(page['bench']['major'] == 2 and 'stamp' not in page and page['bench']['commit'] == 'b' * 40,
      'the Runs page gets the major version its measurements count as (2 for twin runs)')
# the floors: 5 tasks of one commit with the same CPU sharing (10 pairs) and one more without record (its 5 pairs skipped)
same = [task(str(i), 100 + i, ('pairs', False)) for i in range(1, 6)]
floors = rr.measured_floors({('PR', 'Perf'): {'c' * 40: same + [task('9', 100)]}})
check(floors['pairs'].get('Perf/coverage') == 10, f"the floors: pairs of the same CPU sharing only ({floors['pairs'].get('Perf/coverage')} pairs, 10 expected)")
# a task that ran before a compat rule its commit gets today (rules_today: PR_compat.sh on the bench's clone, given here)
rr.rules_today = lambda commit: {'reservoir_sample_warn'} if commit == 'c' * 40 else set()
rr.STALE.clear()
w, entry = warnings(task('1', 100), task('2', 50))
check(any(n == f"run before compat rule reservoir_sample_warn: task 2 of {'c' * 7} (to run again)" for n in entry['notes'])
      and entry.get('stale_rules') == {'task': ['reservoir_sample_warn'], 'base': []}
      and [t['task'] for t in rr.STALE] == ['2'], f"a task run before a rule its commit gets today: noted, listed: {entry['notes']}")
withrule = task('2', 50); withrule['settings']['compat'] = 'reservoir_sample_warn'
w, entry = warnings(task('1', 100), withrule)
check(not any('run before' in n for n in entry['notes']) and 'stale_rules' not in entry, 'a task that ran with the rule: nothing noted')
sys.exit(fail)
PY
