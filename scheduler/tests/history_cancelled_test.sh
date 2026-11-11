#!/bin/bash
# history_cancelled_test.sh <scheduler binary>: a task cancelled before its first step stays in the history, on a
# throwaway scheduler (one core, core 0, its own folders; a cgroup root under user.slice and a fake sudo, so that it
# never touches the CPU reservation of a real scheduler):
#   - a task holds the only core; a second one waits; the second is cancelled before it starts;
#   - the history lists it, cancelled, with its steps; its record and archive are in exports/Canceled;
#   - its task page answers (final state), and Delete removes it.
set -euo pipefail
binary=$( realpath "${1:?usage: history_cancelled_test.sh <scheduler binary>}" )
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
      "logsSize": 1048576, "cgroupPath": "/sys/fs/cgroup/user.slice/history-cancelled-test-none", "cpuMaxLoad": 100, "memMinimumRatio": 0.0 } },
    "publisher": { "default": { "base_url": "http://127.0.0.1:1", "notify_endpoint": "/api/notify", "view_endpoint": "/x",
      "storage": "${work}/publisher" } } },
  "cache": { "storagePath": "${work}/cache", "mappingFile": "cache.json" } }
EOF
cd "${work}"
export PATH="${work}/bin:${PATH}"
taskset -c 0 nice -n 19 "${binary}" --only-install --force-install config.json > install.log 2>&1 || true
taskset -c 0 nice -n 19 "${binary}" config.json > run.log 2>&1 & pid=$!
api="http://127.0.0.1:${port}/api"
for _ in $( seq 1 100 ); do curl -sf "${api}/health" > /dev/null 2>&1 && break; sleep 0.1; done

printf 'Hold() { sleep 60; }\n' > job.sh
printf '{ "name": "t", "flow": [ { "step": "Hold", "configuration": { "nb_cores": 1 } } ] }\n' > flow.json
Submit() { curl -sS -X POST "${api}/task/new" -F "config=@flow.json" -F "script=@job.sh" -F "name=$1" -F user=tester -F job_type=test |
  jq -r '.task_id // empty'; }
first=$( Submit holder ); second=$( Submit waiter )
check 'two tasks submitted' '[ -n "${first}" ] && [ -n "${second}" ]'
sleep 2
curl -sS -X DELETE "${api}/task/${second}" > /dev/null
history() { curl -sS "${api}/user/tester/test/tasks"; }
for _ in $( seq 1 50 ); do [ -s "exports/Canceled/${second}.zip" ] && break; sleep 0.2; done
check 'the cancelled task: its record and archive in exports/Canceled' '[ -s "exports/Canceled/${second}.json" ] && [ -s "exports/Canceled/${second}.zip" ]'
entry=$( history | jq -c --arg id "${second}" '.data[] | select((.id | tostring) == $id)' )
check 'the history lists it, cancelled, its step cancelled' 'jq -e ".cancelled == true and .running == false and .summary.steps.cancelled == 1" <<< "${entry}" > /dev/null'
entry=$( history | jq -c --arg id "${second}" '.data[] | select((.id | tostring) == $id)' )
check 'it stays there on the next look' '[ -n "${entry}" ]'
check 'its task page answers' 'curl -sSf "${api}/task/${second}/final_state" | jq -e ".success != false" > /dev/null'
curl -sS -X DELETE "${api}/task/${second}" > /dev/null
check 'Delete removes it' '[ ! -e "exports/Canceled/${second}.zip" ] && [ -z "$( history | jq -r --arg id "${second}" ".data[]? | select((.id | tostring) == \$id) | .id" )" ]'
curl -sS -X DELETE "${api}/task/${first}" > /dev/null
exit "${fail}"
