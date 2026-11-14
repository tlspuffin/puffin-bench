#!/bin/bash
# objectives_report_many_test.sh: tools/objectives_report.sh on a task whose first run has many objectives none of which
# was replayed (one link per objective in the builder's temporary folder) and whose second run has objectives without
# any kept replay report: the second run's objectives are read, the report is written (removing the first
# run's links in one command would exceed the size of a command line, and the second run would meet a link left over,
# block.empty, which ends the whole script under set -u). The temporary folder has a long path (TMPDIR), so that 1,000 objectives are enough:
# under cron's /tmp the limit is about 52,000.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
qjs="${1:-/srv/puffin-bench/data/tools/qjs}"
[ -x "${qjs}" ] || { echo "SKIP: no qjs at ${qjs}"; exit 0; }
command -v unzip > /dev/null || { echo "SKIP: no unzip"; exit 0; }
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
root="${work}/root" task=1790000000002
out="${root}/data/html/objectives"
mkdir -p "${root}/data/exports" "${root}/data/tools" "${out}" "${root}/data/html/board/custom"
ln -s "${qjs}" "${root}/data/tools/qjs"
# a temporary folder of about 3,000 characters (components of 200)
long="${work}"; for _ in $( seq 1 15 ); do long="${long}/$( printf 'd%.0s' $( seq 1 200 ) )"; done; mkdir -p "${long}"
python3 -I - "${root}/data/exports" "${task}" <<'PY'
import json, sys, zipfile
d, task = sys.argv[1], sys.argv[2]
cli = {'cputs': True, 'build': 'C harness, wolfssl540-asan', 'vendor': 'wolfssl:wolfssl540-asan', 'library': {'name': 'wolfssl', 'version': '540'}, 'asan': {'instrumented': True}}
steps = []
for a in (0, 1):
    steps += [{'name': 'ExperimentWithCargo', 'id': 'WolfSSL', 'attempt_id': a, 'state': 'Done', 'time_points_ms': [1000, 2000], 'user_run_state': json.dumps(cli)},
              {'name': 'ExperimentEnd', 'id': 'WolfSSL', 'attempt_id': a, 'state': 'Done', 'time_points_ms': [2000, 3000],
               'executor_data': {'launcher_file': f'/x/4-0-{a}-launcher'}}]
json.dump({'task': {'id': int(task), 'name': 'Perf many', 'user': 'u', 'job_type': 'perf', 'args': [{'key': 'COMMIT_ID', 'value': 'c' * 40}], 'steps': steps}},
          open(f'{d}/{task}.json', 'w'))
with zipfile.ZipFile(f'{d}/{task}.zip', 'w') as z:
    for a, n in ((0, 1000), (1, 3)):
        z.writestr(f'logs/stdout.4-0-{a}.txt', ''); z.writestr(f'logs/stderr.4-0-{a}.txt', '')
        for i in range(n):
            z.writestr(f'artefacts/WolfSSL/{a}-objective/20261111-0000{i // 1000:02d}{i % 1000:03d}-{a}{i:05d}.trace', 'trace')
    z.writestr('artefacts/summary.json', json.dumps({'libraries': {'WolfSSL': {'cli': cli, 'data': [{'id': 0, 'state': 'success'}, {'id': 1, 'state': 'success'}]}}}))
PY
status=0
TMPDIR="${long}" PB_ROOT="${root}" PB_GIT_RESTAPI=http://127.0.0.1:9 PB_PUBLIC_URL=http://h PB_BOARD_URL=http://h \
  bash "${here}/../tools/objectives_report.sh" "${task}" > "${work}/build.log" 2>&1 || status=$?
check 'the report is made (no error of the builder)' '[ "${status}" -eq 0 ] && [ -s "${out}/${task}.json" ]' || sed 's/^/     /' "${work}/build.log" | tail -5
check 'both runs, their objectives all there: 1,000 and 3, not replayed' \
  '[ "$( jq -c "[.runs[] | [.attempt, .found, ([.groups[] | select(.type == \"not-replayed\") | .count] | add)]]" "${out}/${task}.json" 2> /dev/null )" == "[[0,1000,1000],[1,3,3]]" ]'
exit "${fail}"
