#!/bin/bash
# perf_objectives_test.sh: Perf's objectives after all its runs (PerfObjectives, PR_perf.sh), on a task folder laid out
# as the scheduler leaves it once the twin runs ended (their folders gone): the archived objectives and fuzzer logs of
# runs 0, 1 and 3 (run 1 without objective), the shared build, the launch records of TwinLaunch. The replays and the
# validation are stand-ins that record what they get:
#   - each run set up again in run-<n>: its objectives, its fuzzer logs, its launch record, the shared build linked;
#   - replays only for a run with objectives, under its run number; the validation of every run (one without objective
#     writes "no objective" by itself), its checkout kept between runs;
#   - the validation prepared once, by the first run with objectives alone: the next runs take its state and controls,
#     THEJOB_NB_CORES at once; the checkout removed once, at the end;
#   - one budget for the step (PERF_OBJECTIVES_BUDGET): past it, no replay and no validation time;
#   - the live pages skip these folders (.after_runs);
#   - and the twin runs' ExperimentEnd leaves the replays to it (OBJECTIVES_AFTER_RUNS).
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
source <( sed -n '/^SharedBuildDir()/p; /^TwinRunDir()/,/^}/p; /^PerfObjectives()/,/^}/p; /^PerfObjectivesRun()/,/^}/p' "${here}/../PR_perf.sh" )

export THEJOB_OUT_PATH="${work}/out" THEJOB_ARTEFACTS_PATH="${work}/artefacts" THEJOB_STEP_ID=WolfSSL THEJOB_NB_CORES=2
build="${THEJOB_OUT_PATH}/build-WolfSSL"
mkdir -p "${build}/target/release" "${build}/seeds" && printf '#!/bin/sh\n' > "${build}/target/release/tlspuffin" && chmod +x "${build}/target/release/tlspuffin"
for run in 0 1 3; do
  mkdir -p "${THEJOB_ARTEFACTS_PATH}/WolfSSL/${run}-objective" "${THEJOB_ARTEFACTS_PATH}/WolfSSL/${run}-log" "${THEJOB_OUT_PATH}/launch-WolfSSL-${run}"
  echo "exec ./target/release/tlspuffin" > "${THEJOB_OUT_PATH}/launch-WolfSSL-${run}/.currentcmd"
  echo "LAUNCH_FLAGS=--run${run}" > "${THEJOB_OUT_PATH}/launch-WolfSSL-${run}/.currentlaunch"
  touch "${THEJOB_ARTEFACTS_PATH}/WolfSSL/${run}-log/error.log"
done
touch "${THEJOB_ARTEFACTS_PATH}/WolfSSL/0-objective/"{a,b}.trace "${THEJOB_ARTEFACTS_PATH}/WolfSSL/3-objective/c.trace" \
  "${THEJOB_ARTEFACTS_PATH}/WolfSSL/0-objective/.hidden.trace"
calls="${work}/calls"
ExperimentReplayObjectives() {
  echo "replay ${THEJOB_STEP_ATTEMPT_ID} $( find "$1/objective" -name '*.trace' ! -name '.*' | wc -l ) $( [ -x ./target/release/tlspuffin ] && cat .currentcmd ) max $2" >> "${calls}"
}
ValidateObjectives() {
  local prepared=fresh; [ -s validation/state.json ] && prepared=reused
  # (what ValidateObjectives reads of the preparation: the state, the listings of the validation set)
  [ "${prepared}" == fresh ] || { [ -s validation/list.json ] && [ -s validation/list-build.json ]; } || prepared=incomplete
  echo "validate ${THEJOB_STEP_ATTEMPT_ID} ${VALIDATION_KEEP_CHECKOUT:-} ${prepared} $( source .currentlaunch; echo "${LAUNCH_FLAGS}" ) $( [ -e experiments/perf/log/error.log ] && echo log ) left $(( ${VALIDATION_DEADLINE:-0} - SECONDS > 0 ? 1 : 0 )) $( ls validation/runs 2> /dev/null | tr '\n' ' ' )" >> "${calls}"
  [ "${prepared}" == fresh ] && mkdir -p validation/runs && echo '{"status":"ready"}' > validation/state.json &&
    echo '{}' > validation/list.json && echo '{}' > validation/list-build.json && touch validation/runs/control-CVE-1-F.json
  return 0
}
ValidationCleanup() { echo "cleanup $( basename "${PWD}" )" >> "${calls}"; }
step="${work}/step"; mkdir -p "${step}"
# a budget whose replay cap is the fixed one (min(100, seconds left / 120)): with the default 7200 s it is 60, or 59 once
# a second has gone, which a loaded core 0 made the test see now and then
( cd "${step}" && PERF_OBJECTIVES_BUDGET=100000 PerfObjectives > /dev/null )

check 'each run set up again: objectives, fuzzer logs, launch record, the shared build' \
  '[ -e "${step}/run-3/experiments/perf/objective/c.trace" ] && [ -L "${step}/run-3/experiments/perf/log" ] && [ -s "${step}/run-3/.currentlaunch" ] && [ -L "${step}/run-3/target" ]'
check 'replays for the runs with objectives only, under their run numbers, with their launch' \
  '[ "$( grep ^replay "${calls}" | sort | tr "\n" ";" )" == "replay 0 2 exec ./target/release/tlspuffin max 100;replay 3 1 exec ./target/release/tlspuffin max 100;" ]'
check 'the validation of every run, its own launch flags and logs, the checkout kept, before the deadline' \
  '[ "$( grep ^validate "${calls}" | cut -d" " -f1-8 | sort | tr "\n" ";" )" == "validate 0 1 fresh --run0 log left 1;validate 1 1 reused --run1 log left 1;validate 3 1 reused --run3 log left 1;" ]'
check 'the first run prepares alone, the next take its preparation and controls' \
  '[ "$( grep ^validate "${calls}" | head -1 | cut -d" " -f2,4 )" == "0 fresh" ] && grep -q "^validate 3 1 reused --run3 log left 1 control-CVE-1-F.json" "${calls}"'
check 'the checkout removed once, at the end' '[ "$( grep -c ^cleanup "${calls}" )" == 1 ] && [ "$( tail -1 "${calls}" )" == "cleanup run-0" ]'
check 'the live pages skip these folders' '[ -e "${step}/run-0/.after_runs" ]'
check 'each run its status' '[ "$( cat "${step}"/run-{0,1,3}/.status | tr -d "\n" )" == 000 ]'
# a small budget: the replay cap follows it (1200 s: at most 10 replays a run, 9 once a second has gone)
: > "${calls}"; rm -rf "${step}"; mkdir -p "${step}"
( cd "${step}" && PERF_OBJECTIVES_BUDGET=1200 PerfObjectives > /dev/null )
check 'the replay cap follows the budget left (min(100, s / 120))' \
  '[ "$( grep ^replay "${calls}" | grep -cE " max (9|10)$" )" == 2 ]'
# the budget spent: no replay, no validation time (the objectives recorded as not validated)
: > "${calls}"; rm -rf "${step}"; mkdir -p "${step}"
( cd "${step}" && PERF_OBJECTIVES_BUDGET=0 PerfObjectives > /dev/null )
check 'past the budget: no replay, no validation time (the deadline passed)' '! grep -q ^replay "${calls}" && [ "$( grep -c " left 0" "${calls}" )" == 3 ]'
check "the twin runs' ExperimentEnd leaves the replays to it" \
  'grep -q "OBJECTIVES_AFTER_RUNS=1 TwinEach ExperimentEnd" "${here}/../PR_perf.sh" && grep -q "OBJECTIVES_AFTER_RUNS:-}\" \] && return 0" "${here}/../PR_perf.sh"'
exit "${fail}"
