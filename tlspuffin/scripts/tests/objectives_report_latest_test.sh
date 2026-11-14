#!/bin/bash
# objectives_report_latest_test.sh: a report whose commit has no catalogue is read against the latest one
# (objectives_report.sh LatestCatalogue, cached an hour: catalogue-cache/latest.txt); when the latest catalogue changes,
# --all makes that report again against it (else it would keep the catalogue of its last rewrite until another
# of the builder's files changed). The catalogues and the answer of git_restapi are given (cached files; git_restapi not asked).
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
qjs="${1:-/srv/puffin-bench/data/tools/qjs}"
[ -x "${qjs}" ] || { echo "SKIP: no qjs at ${qjs}"; exit 0; }
command -v unzip > /dev/null || { echo "SKIP: no unzip"; exit 0; }
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
root="${work}/root" task=1790000000003 old=$( printf 'd%.0s' {1..40} ) a=$( printf 'a%.0s' {1..40} ) b=$( printf 'b%.0s' {1..40} )
out="${root}/data/html/objectives" cache="${root}/data/catalogue-cache"
mkdir -p "${root}/data/exports" "${root}/data/tools" "${out}" "${root}/data/html/board/custom" "${cache}"
ln -s "${qjs}" "${root}/data/tools/qjs"
# the task's commit: no catalogue (git_restapi's answer, cached); two catalogues, the latest one A, then B
echo "{ \"commit\": \"${old}\", \"format\": \"none\" }" > "${cache}/${old}.json"
for c in "${a}" "${b}"; do
  jq -n --arg c "${c}" '{ commit: $c, format: "vulnerabilities.toml", vendors: { wolfssl: { entries: {
    "CVE-2022-42905": { alias: "HEAP", affected: "< 5.5.2", oracle: { kind: "crash", asan: "heap-buffer-overflow" },
                        top_frames: ["AddPacketInfo", "DoTls13HandShakeMsgType"] } } } } }' > "${cache}/${c}.json"
done
latest() { echo "$1" > "${cache}/latest.txt"; touch "${cache}/latest.txt" "${cache}/latest.checked"; }
python3 -I - "${root}/data/exports" "${task}" "${old}" <<'PY'
import json, sys, zipfile
d, task, commit = sys.argv[1], sys.argv[2], sys.argv[3]
cli = {'cputs': True, 'build': 'C harness, wolfssl540-asan', 'vendor': 'wolfssl:wolfssl540-asan', 'library': {'name': 'wolfssl', 'version': '540'}, 'asan': {'instrumented': True}}
steps = [{'name': 'ExperimentWithCargo', 'id': 'WolfSSL', 'attempt_id': 0, 'state': 'Done', 'time_points_ms': [1000, 2000], 'user_run_state': json.dumps(cli)},
         {'name': 'ExperimentEnd', 'id': 'WolfSSL', 'attempt_id': 0, 'state': 'Done', 'time_points_ms': [2000, 3000], 'executor_data': {'launcher_file': '/x/4-0-0-launcher'}}]
json.dump({'task': {'id': int(task), 'name': 'Perf old', 'user': 'u', 'job_type': 'perf', 'args': [{'key': 'COMMIT_ID', 'value': commit}], 'steps': steps}}, open(f'{d}/{task}.json', 'w'))
name = '20261111-000000001-aaaa'
asan = ('==1==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x1 at pc 0x2\n    #0 0x10 in AddPacketInfo /src/internal.c:1\n'
        '    #1 0x11 in DoTls13HandShakeMsgType /src/tls13.c:2\n    #2 0x12 in DoTls13HandShakeMsg /src/tls13.c:3\n\n'
        'SUMMARY: AddressSanitizer: heap-buffer-overflow /src/internal.c:1 in AddPacketInfo\n')
with zipfile.ZipFile(f'{d}/{task}.zip', 'w') as z:
    z.writestr('logs/stdout.4-0-0.txt', f'=== /x/{name}.trace ===\n'); z.writestr('logs/stderr.4-0-0.txt', '')
    z.writestr(f'artefacts/WolfSSL/0-objective/{name}.trace', 'trace')
    z.writestr(f'artefacts/WolfSSL/0-objective-reports/{name}.txt', asan)
    z.writestr('artefacts/summary.json', json.dumps({'libraries': {'WolfSSL': {'cli': cli, 'data': [{'id': 0, 'state': 'success'}]}}}))
PY
touch -d '-1 hour' "${root}/data/exports/${task}.json" "${root}/data/exports/${task}.zip"
all() { PB_ROOT="${root}" PB_GIT_RESTAPI=http://127.0.0.1:9 PB_PUBLIC_URL=http://h PB_BOARD_URL=http://h \
          bash "${here}/../tools/objectives_report.sh" --all > "${work}/all.log" 2>&1 || true; }
latest "${a}"; all
check 'a commit without catalogue: its report read against the latest one, A' \
  '[ "$( jq -r ".catalogue_digest | [.commit, .latest] | join(\" \")" "${out}/${task}.json" )" == "${a} true" ]'
all
page=$( stat -c %y "${out}/${task}.html" )
all
check 'the latest catalogue unchanged: the report not made again' '[ "$( stat -c %y "${out}/${task}.html" )" == "${page}" ]'
sleep 1; latest "${b}"; all
check 'the latest catalogue now B: --all makes the report again against it' \
  '[ "$( jq -r ".catalogue_digest | [.commit, .latest] | join(\" \")" "${out}/${task}.json" )" == "${b} true" ]'
exit "${fail}"
