#!/bin/bash
# objectives_report_test.sh [<qjs>]: tools/objectives_report.sh, the cron's report builder (Report), on a task made here
# (its export and archive under a scratch PB_ROOT; git_restapi not asked: no catalogue):
#   - the report: a run with its objectives grouped by signature (an ASan crash, a claim), its traces next to the page,
#     its verdicts (report_verdicts.js, the pages' code), its page;
#   - made aside and published in one rename (F30): while its verdicts are computed, the page still reads the previous
#     report whole, with its verdicts, and the task's traces; nothing is left beside them.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
qjs="${1:-/srv/puffin-bench/data/tools/qjs}"
[ -x "${qjs}" ] || { echo "SKIP: no qjs at ${qjs}"; exit 0; }
command -v unzip > /dev/null || { echo "SKIP: no unzip"; exit 0; }
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
root="${work}/root" task=1790000000001
out="${root}/data/html/objectives"
mkdir -p "${root}/data/exports" "${root}/data/tools" "${out}" "${root}/data/html/board/custom"
# the bench's qjs, through a stand-in that records what a page would read while the verdicts are computed: whether the
# published report is whole and has its verdicts, and how many traces the task's folder has
cat > "${root}/data/tools/qjs" <<STANDIN
#!/bin/bash
case " \$* " in *report_verdicts.js*)
  { jq -c '{ verdicts: (.verdicts != null), groups: ([.runs[].groups[]] | length) }' "${out}/${task}.json" 2> /dev/null || echo '"unreadable"';
    find "${out}/${task}-traces" -name '*.trace' 2> /dev/null | wc -l; } >> "${work}/seen";;
esac
exec "${qjs}" "\$@"
STANDIN
chmod +x "${root}/data/tools/qjs"
# unzip through a stand-in too: how many traces the task's folder has while each trace is extracted
mkdir -p "${work}/bin"
cat > "${work}/bin/unzip" <<STANDIN
#!/bin/bash
case " \$* " in *-objective/*.trace*) find "${out}/${task}-traces" -name '*.trace' 2> /dev/null | wc -l >> "${work}/seen-unzip";; esac
exec "$( command -v unzip )" "\$@"
STANDIN
chmod +x "${work}/bin/unzip"
# the export of a Vuln task with one run of WolfSSL: 2 objectives, a heap overflow and a claim, both replayed
python3 -I - "${root}/data/exports" "${task}" <<'PY'
import json, sys, zipfile
d, task = sys.argv[1], sys.argv[2]
cli = {'cputs': True, 'build': 'C harness, wolfssl540-asan', 'vendor': 'wolfssl:wolfssl540-asan', 'features': 'cputs',
       'library': {'name': 'wolfssl', 'version': '540'}, 'asan': {'instrumented': True}}
steps = [{'name': 'ExperimentWithCargo', 'id': 'WolfSSL', 'attempt_id': 0, 'state': 'Done', 'time_points_ms': [1000, 2000],
          'user_run_state': json.dumps(cli)},
         {'name': 'ExperimentEnd', 'id': 'WolfSSL', 'attempt_id': 0, 'state': 'Done', 'time_points_ms': [2000, 3000],
          'executor_data': {'launcher_file': '/x/4-0-0-launcher'}}]
json.dump({'task': {'id': int(task), 'name': 'Vuln test', 'user': 'u', 'job_type': 'vuln-a',
                    'args': [{'key': 'COMMIT_ID', 'value': 'c' * 40}], 'steps': steps}}, open(f'{d}/{task}.json', 'w'))
heap, claim = '20261111-000000001-aaaa', '20261111-000000002-bbbb'
asan = ('==1==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x1 at pc 0x2\n'
        '    #0 0x10 in AddPacketInfo /src/internal.c:1\n    #1 0x11 in DoTls13HandShakeMsgType /src/tls13.c:2\n'
        '    #2 0x12 in DoTls13HandShakeMsg /src/tls13.c:3\n\nSUMMARY: AddressSanitizer: heap-buffer-overflow /src/internal.c:1 in AddPacketInfo\n')
with zipfile.ZipFile(f'{d}/{task}.zip', 'w') as z:
    z.writestr('logs/stdout.4-0-0.txt', f'=== /x/{heap}.trace ===\n=== /x/{claim}.trace ===\n')
    z.writestr('logs/stderr.4-0-0.txt', '')
    for name in (heap, claim):
        z.writestr(f'artefacts/WolfSSL/0-objective/{name}.trace', 'trace')
    z.writestr(f'artefacts/WolfSSL/0-objective-reports/{heap}.txt', asan)
    z.writestr(f'artefacts/WolfSSL/0-objective-reports/{claim}.txt', 'error because a security violation occurred. msg: Authentication bypass\n')
    z.writestr('artefacts/summary.json', json.dumps({'libraries': {'WolfSSL': {'cli': cli, 'data': [{'id': 0, 'state': 'success'}]}}}))
PY
build() { PATH="${work}/bin:${PATH}" PB_ROOT="${root}" PB_GIT_RESTAPI=http://127.0.0.1:9 PB_PUBLIC_URL=http://h PB_BOARD_URL=http://h \
            bash "${here}/../tools/objectives_report.sh" "${task}" > "${work}/build.log" 2>&1; }
build || { echo "FAIL the report could not be made:"; cat "${work}/build.log"; exit 1; }
report="${out}/${task}.json"
check 'the report: one run, its 2 objectives in 2 groups (an ASan crash, a claim)' \
  '[ "$( jq -c "[.runs[0].found, ([.runs[0].groups[].type] | sort)]" "${report}" )" == "[2,[\"heap-buffer-overflow\",\"security-violation\"]]" ]'
check 'its traces next to the page, named in the report' \
  '[ "$( find "${out}/${task}-traces/WolfSSL/0" -name "*.trace" | wc -l )" -eq 2 ] && [ "$( jq "[.runs[0].groups[].traces[]] | length" "${report}" )" -eq 2 ]'
check 'its verdicts (report_verdicts.js) and its page' 'jq -e ".verdicts.headline" "${report}" > /dev/null && grep -q "data-json=\"${task}.json\"" "${out}/${task}.html"'
# made again (an update of the tools): meanwhile a page reads the previous report, whole, with its verdicts
: > "${work}/seen"; : > "${work}/seen-unzip"
build || { echo "FAIL the report could not be made again:"; cat "${work}/build.log"; exit 1; }
check 'while the verdicts are computed, a page reads the previous report whole, with its verdicts' \
  '[ "$( head -n 1 "${work}/seen" )" == "{\"verdicts\":true,\"groups\":2}" ]'
check 'and the task'"'"'s traces, all of them, also while the new ones are extracted' \
  '[ "$( sed -n 2p "${work}/seen" )" -eq 2 ] && [ -s "${work}/seen-unzip" ] && [ "$( sort -n "${work}/seen-unzip" | head -n 1 )" -eq 2 ]'
check 'the new report published whole: verdicts, groups, traces; nothing left beside it' \
  'jq -e ".verdicts.headline and (.runs[0].groups | length) == 2" "${report}" > /dev/null && [ "$( find "${out}/${task}-traces" -name "*.trace" | wc -l )" -eq 2 ] &&
   [ -z "$( find "${out}" -maxdepth 1 \( -name "*.tmp" -o -name "*.new" -o -name "*.old" \) )" ]'
exit "${fail}"
