#!/bin/bash
# objectives_report_test.sh [<qjs>]: tools/objectives_report.sh, the cron's report builder (Report), on a task made here
# (its export and archive under a scratch PB_ROOT; git_restapi not asked: no catalogue):
#   - the report: a run with its objectives grouped by signature (an ASan crash, a claim), its traces next to the page,
#     its verdicts (report_verdicts.js, the pages' code), its page;
#   - objectives beyond the replays, classified by the fuzzer's record: a claim record (no frames) keeps its fields
#     (an empty field collapsing, the time would become the frames, each objective its own group);
#   - made aside and published in one rename: while its verdicts are computed, the page still reads the previous
#     report whole, with its verdicts, and the task's traces; nothing is left beside them;
#   - a bug's place from the stacks the Bugs reference has (witness_frames.json, published by --all: the newest
#     validation's), not only those computed once; --all replaces that file only when a stack changes, and makes
#     the reports again when it does.
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
# the export of a Vuln task with one run of WolfSSL: 2 objectives replayed, a heap overflow and a claim, and 2 beyond
# the replays whose fuzzer recorded a claim
python3 -I - "${root}/data/exports" "${task}" <<'PY'
import json, sys, zipfile
d, task = sys.argv[1], sys.argv[2]
cli = {'cputs': True, 'build': 'C harness, wolfssl540-asan', 'vendor': 'wolfssl:wolfssl540-asan', 'features': 'cputs',
       'library': {'name': 'wolfssl', 'version': '540'}, 'asan': {'instrumented': True}}
# its run state: a line that is no JSON, then two records of what it built, the first one kept (jq 1.6 gave both)
steps = [{'name': 'ExperimentWithCargo', 'id': 'WolfSSL', 'attempt_id': 0, 'state': 'Done', 'time_points_ms': [1000, 2000],
          'user_run_state': '\n'.join(['launched', json.dumps(cli), json.dumps({**cli, 'build': 'a later record'})])},
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
    # beyond the replays: the fuzzer's records of their claims (warn.log, its local time; the names are UTC)
    for name in ('20261111-000000003-cccc', '20261111-000001004-dddd'):
        z.writestr(f'artefacts/WolfSSL/0-objective/{name}.trace', 'trace')
    z.writestr('artefacts/WolfSSL/0-log/warn.log', '2026-11-11T01:00:00.002000000+01:00\tWARN\tSome claim\n'
                                                   '2026-11-11T01:00:01.003000000+01:00\tWARN\tSome claim\n')
    z.writestr('artefacts/summary.json', json.dumps({'libraries': {'WolfSSL': {'cli': cli, 'data': [{'id': 0, 'state': 'success'}]}}}))
PY
# the catalogue of the task's commit (as git_restapi gives it, cached), HEAP with its 2 top frames; its witness's stack
# as a validation recorded it, published (3 frames), none computed once
mkdir -p "${root}/data/catalogue-cache"
jq -n '{ commit: "cccccccccccccccccccccccccccccccccccccccc", format: "vulnerabilities.toml", vendors: { wolfssl: { entries: {
  "CVE-2022-42905": { alias: "HEAP", affected: "< 5.5.2", oracle: { kind: "crash", asan: "heap-buffer-overflow" },
                      top_frames: ["AddPacketInfo", "DoTls13HandShakeMsgType"] } } } } }' > "${root}/data/catalogue-cache/$( printf 'c%.0s' {1..40} ).json"
echo '{}' > "${root}/data/catalogue-cache/witness_frames.json"
place='["AddPacketInfo","DoTls13HandShakeMsgType","DoTls13HandShakeMsg"]'
jq -n --argjson f "${place}" '{ "CVE-2022-42905": { frames: ($f + ["ProcessReplyEx"]), from: "the validation of task 1" } }' > "${out}/witness_frames.json"
build() { PATH="${work}/bin:${PATH}" PB_ROOT="${root}" PB_GIT_RESTAPI=http://127.0.0.1:9 PB_PUBLIC_URL=http://h PB_BOARD_URL=http://h \
            bash "${here}/../tools/objectives_report.sh" "${task}" > "${work}/build.log" 2>&1; }
build || { echo "FAIL the report could not be made:"; cat "${work}/build.log"; exit 1; }
report="${out}/${task}.json"
check 'the report: one run, its 4 objectives in 3 groups (an ASan crash, a claim, 2 beyond the replays)' \
  '[ "$( jq -c "[.runs[0].found, ([.runs[0].groups[].type] | sort)]" "${report}" )" == "[4,[\"heap-buffer-overflow\",\"not-replayed\",\"security-violation\"]]" ]'
check 'the 2 beyond the replays: one group, their claim as the fuzzer recorded it, no frames' \
  '[ "$( jq -c "[.runs[0].groups[] | select(.type == \"not-replayed\") | [.count, .fuzzer.kind, .fuzzer.detail, .fuzzer.frames]]" "${report}" )" == "[[2,\"claim\",\"Some claim\",[]]]" ]'
check 'what the run built: the first record of its run state, once, also under jq 1.6' \
  '[ "$( jq -c "[.runs[0].cli.build, .libraries[0].cli.build]" "${report}" )" == "[\"C harness, wolfssl540-asan\",\"C harness, wolfssl540-asan\"]" ]'
check 'its traces next to the page, named in the report' \
  '[ "$( find "${out}/${task}-traces/WolfSSL/0" -name "*.trace" | wc -l )" -eq 4 ] && [ "$( jq "[.runs[0].groups[].traces[]] | length" "${report}" )" -eq 4 ]'
check 'its verdicts (report_verdicts.js) and its page' 'jq -e ".verdicts.headline" "${report}" > /dev/null && grep -q "data-json=\"${task}.json\"" "${out}/${task}.html"'
check "HEAP's place from the stack the Bugs reference has, its 3 frames, not the catalogue's 2" \
  '[ "$( jq -c ".catalogue_digest.vendors.wolfssl.entries[\"CVE-2022-42905\"].witness_frames[0:3]" "${report}" )" == "${place}" ]'
# made again (an update of the tools): meanwhile a page reads the previous report, whole, with its verdicts
: > "${work}/seen"; : > "${work}/seen-unzip"
build || { echo "FAIL the report could not be made again:"; cat "${work}/build.log"; exit 1; }
check 'while the verdicts are computed, a page reads the previous report whole, with its verdicts' \
  '[ "$( head -n 1 "${work}/seen" )" == "{\"verdicts\":true,\"groups\":3}" ]'
check 'and the task'"'"'s traces, all of them, also while the new ones are extracted' \
  '[ "$( sed -n 2p "${work}/seen" )" -eq 4 ] && [ -s "${work}/seen-unzip" ] && [ "$( sort -n "${work}/seen-unzip" | head -n 1 )" -eq 4 ]'
check 'the new report published whole: verdicts, groups, traces; nothing left beside it' \
  'jq -e ".verdicts.headline and (.runs[0].groups | length) == 3" "${report}" > /dev/null && [ "$( find "${out}/${task}-traces" -name "*.trace" | wc -l )" -eq 4 ] &&
   [ -z "$( find "${out}" -maxdepth 1 \( -name "*.tmp" -o -name "*.new" -o -name "*.old" \) )" ]'
# --all: witness_frames.json replaced only when a stack changes, and the reports made again when it does (the export,
# the data, dated before; the page is newer than all it is made from)
all() { PATH="${work}/bin:${PATH}" PB_ROOT="${root}" PB_GIT_RESTAPI=http://127.0.0.1:9 PB_PUBLIC_URL=http://h PB_BOARD_URL=http://h \
          bash "${here}/../tools/objectives_report.sh" --all > "${work}/all.log" 2>&1; }
touch -d '-1 hour' "${root}/data/exports/${task}.json" "${root}/data/exports/${task}.zip"
all
touch -d '-10 minutes' "${out}/witness_frames.json"
page=$( stat -c %y "${out}/${task}.html" ) frames=$( stat -c %y "${out}/witness_frames.json" )
all
check '--all: no stack changed, witness_frames.json kept, the report not made again' \
  '[ "$( stat -c %y "${out}/witness_frames.json" )" == "${frames}" ] && [ "$( stat -c %y "${out}/${task}.html" )" == "${page}" ]'
jq --argjson f "${place}" '. + { "CVE-2022-42905": { frames: $f, put: "wolfssl540-asan" } }' "${root}/data/catalogue-cache/witness_frames.json" > "${work}/once" &&
  mv "${work}/once" "${root}/data/catalogue-cache/witness_frames.json"
all; all
check '--all: a stack changed, witness_frames.json replaced, the report made again with it' \
  '[ "$( stat -c %y "${out}/witness_frames.json" )" != "${frames}" ] && [ "${out}/${task}.html" -nt "${out}/witness_frames.json" ] &&
   jq -e ".[\"CVE-2022-42905\"].from | test(\"run once\")" "${out}/witness_frames.json" > /dev/null'
# --all: only what recorded a stack changed (a newer validation of the same bug: its "from"), not the stack:
# witness_frames.json kept, so the reports are not made again
jq '.["CVE-2022-42905"].from = "the validation of task 0"' "${out}/witness_frames.json" > "${work}/frames" &&
  mv "${work}/frames" "${out}/witness_frames.json"
touch -d '-10 minutes' "${out}/witness_frames.json"
page=$( stat -c %y "${out}/${task}.html" ) frames=$( stat -c %y "${out}/witness_frames.json" )
all; all
check '--all: only the task that recorded a stack changed: witness_frames.json kept, the report not made again' \
  '[ "$( stat -c %y "${out}/witness_frames.json" )" == "${frames}" ] && [ "$( stat -c %y "${out}/${task}.html" )" == "${page}" ]'
exit "${fail}"
