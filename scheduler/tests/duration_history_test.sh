#!/bin/bash
# duration_history_test.sh <scheduler binary>: the durations the scheduler learns its estimates from (DurationHistory,
# the end times of the board) are those of runs that ended or timed out, not of failed ones. Before, the campaigns of
# 2026-11-15 whose build failed ended their experiments in a minute, and the next campaign of each configuration, running
# for 5 hours, showed "ends ~… (in 1 min)" for its whole run. On a throwaway scheduler (one core, core 0, its own folders,
# a fake sudo), its history seeded with failed runs of a step:
#   - a history file of a former format (durations of failed runs among them): seeded again from the log of the
#     finished steps, without the failed runs (the runs that ended and timed out kept);
#   - a running step of that kind: expected at its timeout, not a minute from now;
#   - a step that fails: not learned; one that ends: learned.
set -euo pipefail
binary=$( realpath -m "${1:?usage: duration_history_test.sh <scheduler binary>}" )
[ -x "${binary}" ] || { echo "SKIP: no scheduler binary at ${binary} (build the scheduler target)"; exit 0; }
work=$( mktemp -d ); pid=
trap '[ -n "${pid}" ] && kill "${pid}" 2> /dev/null; wait 2> /dev/null; rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

port=$( python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])' )
mkdir -p "${work}/"{html,runs,users,exports,tools,scripts,cache,publisher,bin}
printf '#!/bin/sh\necho "fake sudo refused: $*" >&2\nexit 1\n' > "${work}/bin/sudo"; chmod +x "${work}/bin/sudo"
excluded=$( seq -s, 1 "$(( $( nproc --all ) - 1 ))" )
cat > "${work}/config.json" <<EOF
{ "logs_level": 15,
  "server": { "secure": false, "hostname": "localhost", "port": ${port}, "html": "${work}/html" },
  "schedule": { "toolsPath": "${work}/tools", "runPath": "${work}/runs", "userPath": "${work}/users", "exportPath": "${work}/exports",
    "executors": { "local": { "name": "local", "type": 1, "nbCores": 1, "excludeCores": [ ${excluded} ], "scriptPath": "${work}/scripts",
      "logsSize": 1048576, "cgroupPath": "/sys/fs/cgroup/user.slice/duration-history-test-none", "cpuMaxLoad": 100, "memMinimumRatio": 0.0 } },
    "publisher": { "default": { "base_url": "http://127.0.0.1:1", "notify_endpoint": "/api/notify", "view_endpoint": "/x",
      "storage": "${work}/publisher" } } },
  "cache": { "storagePath": "${work}/cache", "mappingFile": "cache.json" } }
EOF
# the log of the finished steps: two failed runs of Hold (30 s), a run of Quick that ended (2 min) and one that timed out
now=$( date +%s%3N )
line() { printf '{"task":{"id":%s,"job_type":"test","args":[{"key":"COMMIT_ID","value":"c1"}]},"name":"%s","id":".","state":"%s","exit_code":%s,"time_points_ms":[%s,%s]}\n' "$@"; }
{ line 1 Hold Done 1 $(( now - 900000 )) $(( now - 870000 )); line 2 Hold Done 1 $(( now - 800000 )) $(( now - 770000 ))
  line 3 Quick Done 0 $(( now - 700000 )) $(( now - 580000 )); line 4 Quick TimedOut 512 $(( now - 500000 )) $(( now - 140000 )); } \
  > "${work}/exports/steps_done.json"
# a history of the former format (no "#format"): the failed runs of Hold among its durations, under the key of the
# Hold step below (a step without arguments: the first 16 hex digits of the MD5 of an empty text)
hold="test|Hold|$( printf '' | md5sum | cut -c1-16 )"
printf '{"%s":[{"ms":30000,"context":"","nb_cores":1,"timed_out":false},{"ms":30000,"context":"","nb_cores":1,"timed_out":false}]}\n' \
  "${hold}" > "${work}/exports/duration_history.json"
cd "${work}"
export PATH="${work}/bin:${PATH}"
taskset -c 0 nice -n 19 "${binary}" --only-install --force-install config.json > install.log 2>&1 || true
taskset -c 0 nice -n 19 "${binary}" config.json > run.log 2>&1 & pid=$!
api="http://127.0.0.1:${port}/api"
for _ in $( seq 1 100 ); do curl -sf "${api}/health" > /dev/null 2>&1 && break; sleep 0.1; done
durations() { jq -c "$1" exports/duration_history.json 2> /dev/null; }
# the samples of a kind of step: "<job type>|<name>|<digest of its arguments>"
samples() { durations "[to_entries[] | select(.key | startswith(\"$1|\")) | .value[]]"; }
check 'a history of a former format: seeded again from the log, without the failed runs' \
  '[ "$( durations ".[\"#format\"]" )" == 2 ] && [ "$( samples test\|Hold | jq length )" == 0 ] &&
   [ "$( samples test\|Quick | jq -c "[.[].timed_out]" )" == "[false,true]" ]'

# a task: a running Hold (its kind only failed so far), timeout 60 min: expected at its timeout
printf 'Hold() { sleep 60; }\nQuick() { sleep 1; }\nFail() { sleep 1; exit 3; }\n' > job.sh
printf '{ "name": "t", "flow": [ { "step": "Hold", "configuration": { "nb_cores": 1, "timeout": "60m" } } ] }\n' > hold.json
Submit() { curl -sS -X POST "${api}/task/new" -F "config=@$1" -F "script=@job.sh" -F "name=$2" -F user=tester -F job_type=test |
  jq -r '.task_id // empty'; }
held=$( Submit hold.json holder )
end=''
for _ in $( seq 1 50 ); do
  end=$( curl -sS "${api}/task/${held}/state" | jq -r '(.data // .) | (.task // .) | .estimated_end_time // 0' )
  [ "${end:-0}" -gt 0 ] && break; sleep 0.2
done
check 'a running step whose kind only failed before: expected at its timeout (60 min), not in a minute' \
  '[ "${end:-0}" -gt $(( $( date +%s%3N ) + 50 * 60000 )) ]'
curl -sS -X DELETE "${api}/task/${held}" > /dev/null
# a failed step is not learned, one that ended is
printf '{ "name": "q", "flow": [ { "step": "Quick", "configuration": { "nb_cores": 1 } }, { "step": "Fail", "configuration": { "nb_cores": 1 } } ] }\n' > quick.json
ran=$( Submit quick.json quickfail )
for _ in $( seq 1 100 ); do
  [ "$( curl -sS "${api}/task/${ran}/state" | jq -r '[(.data // .) | (.task // .) | .steps[] | select(.state == "Done")] | length' )" == 2 ] && break
  sleep 0.2
done
sleep 1
check 'a step that fails: not learned; one that ends: learned' \
  '[ "$( samples test\|Fail | jq length )" == 0 ] && [ "$( samples test\|Quick | jq length )" == 3 ]'
exit "${fail}"
