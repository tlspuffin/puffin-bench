#!/bin/bash
# vital_check_test.sh: the vital check of a run (PR_common.sh ExperimentCheckAllThreadsRunning) does not end it on a
# timeout of the fuzzer, since 2026-11-17: the fuzzer restarts the client and goes on, and the objective it saved is
# replayed and judged. (The check ended a run whose live error.log had "Timeout in fuzz run", so by chance: a run with
# --with-bit rolls that file within a second.) A fuzzer that died still ends it.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
source <( sed -n '/^ExperimentCheckAllThreadsRunning()/,/^}/p' "${here}/../PR_common.sh" )
cd "${work}"
# no stats yet (the first check of a run): the check gives up on them without the tools of the job
THEJOB_TOOLS_PATH="${work}/tools"
mkdir -p exp/log
printf '2026-11-17T05:03:40.249426383+01:00\tERROR\tTimeout in fuzz run.\n' > exp/log/error.log
sleep 30 & fuzzer=$!
size=0; last=0; problems=''
rc=0; ExperimentCheckAllThreadsRunning "${fuzzer}" size last "${work}/exp/log/stats.json" 1 problems 2> "${work}/err" || rc=$?
check 'a timeout of the fuzzer in the live error.log: the run goes on' '[ "${rc}" == 0 ] && ! grep -q "Timeout found" "${work}/err"'
kill "${fuzzer}"; wait "${fuzzer}" 2> /dev/null || true
rc=0; ExperimentCheckAllThreadsRunning "${fuzzer}" size last "${work}/exp/log/stats.json" 1 problems 2> /dev/null || rc=$?
check 'a fuzzer that died: the run ends' '[ "${rc}" == 1 ]'
exit "${fail}"
