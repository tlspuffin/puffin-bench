#!/bin/bash
# ab_scripts_test.sh: the A/B scripts of the test machine (test_machine/ab_submit.sh, ab_report.py) on the flow of
# today's Perf (twin runs): the flow submitted has one attempt in its group of runs, the build untouched; the report
# compares the mean of each task's runs, not its last one (since the twin flow the script set the build's group, a
# pair had 20 runs per library, of which the report kept the last). Nothing is submitted (the API is not there).
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
mkdir -p "${work}/root/data/html/jobsscripts/tlspuffin" "${work}/home"
command cp -f "${here}/../../data/html/jobsscripts/tlspuffin/PR_perf_cargo.json" "${work}/root/data/html/jobsscripts/tlspuffin/"
HOME="${work}/home" PB_ROOT="${work}/root" PB_API=http://127.0.0.1:9/api bash "${here}/../test_machine/ab_submit.sh" 0123456789abcdef 1 > /dev/null 2>&1 || true
flow="${work}/home/ab-012345678/PR_perf_ab.json"
check 'the A/B flow: one attempt in the group of the runs (TwinExperiment), the build untouched' \
  '[ "$( jq -c "[.flow[] | select(type == \"array\") | [([.[] | .step? // empty] | join(\",\")), .[0].configuration.nb_retry]]" "${flow}" )" == "$( jq -c "[.flow[] | select(type == \"array\") | [([.[] | .step? // empty] | join(\",\")), (if any(.[]; .step? == \"TwinExperiment\") then 1 else .[0].configuration.nb_retry end)]]" "${here}/../../data/html/jobsscripts/tlspuffin/PR_perf_cargo.json" )" ] &&
   [ "$( jq -r ".publish.storage" "${flow}" )" == "\${PACKAGE}/AB/\${COMMIT_ID}/Perf/" ]'
# the report: tasks of two runs each (a twin attempt), A 100 and 300, B 100 and 100: A/B = 2.000 (the last runs: 3.000)
python3 -I - "${work}/exports" <<'PY'
import json, os, sys, zipfile
d = sys.argv[1]; os.makedirs(d)
run = lambda i, execs: {'id': i, 'state': 'success', 'global': [{'tEnd': {'total_execs': execs}}]}
for tid, runs in (('1', [100, 300]), ('2', [100, 100])):
    open(f'{d}/{tid}.json', 'w').write('{}')
    with zipfile.ZipFile(f'{d}/{tid}.zip', 'w') as z:
        z.writestr('artefacts/summary.json', json.dumps({'libraries': {'X': {'data': [run(i, e) for i, e in enumerate(runs)]}}}))
PY
printf 'A 1 1\nB 1 2\n' > "${work}/tasks.txt"
out=$( python3 -I "${here}/../test_machine/ab_report.py" "${work}/tasks.txt" "${work}/exports" )
check 'the report: the mean of the runs of each task (A 200, B 100, ratio 2.000), not the last ones' 'grep -q "X: pairs=1 A(rules)=200 B(no rules)=100 ratio=2.000" <<< "${out}"' || echo "     ${out}"
exit "${fail}"
