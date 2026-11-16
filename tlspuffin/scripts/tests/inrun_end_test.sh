#!/bin/bash
# inrun_end_test.sh: how the in-run monitor of an experiment naming its bug ends a run, and what its summary records of
# it (PR_vulnerabilities.sh TargetedObjectiveFound, RunConfirmation: confirmed_by), with stand-ins for validation
# (ConfirmObjective) and the fuzzer's records (no build, no execution; inrun_confirm_test.sh runs the real ones):
#   - validation confirms the find: the run ends, its summary says confirmed_by validation;
#   - validation cannot tell (a bug that does not replay, a build that could not run it): the fuzzer's record ends the
#     run, and its summary does not say validation;
#   - validation rejects it: the run goes on;
#   - validation cannot tell and the target's place is known: the fuzzer's record ends the run at that place only, a
#     crash of its type elsewhere being another bug;
#   - a Vuln A target recognised by its place, the bench's tools without the pages' module (has_place.js cannot load
#     common/signatures.js): the objective is left pending, said, never another bug; the end-of-run counts say it could
#     not be checked.
set -uo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
export THEJOB_OUT_PATH="${work}/out" THEJOB_STEP_ID=VulnC_BUF THEJOB_STEP_ATTEMPT_ID=0 THEJOB_NB_CORES=1
mkdir -p "${THEJOB_OUT_PATH}"
# shellcheck source=../PR_common.sh
source "${here}/../PR_common.sh"
# shellcheck source=../PR_validate.sh
source "${here}/../PR_validate.sh"
# shellcheck source=../PR_vulnerabilities.sh
source "${here}/../PR_vulnerabilities.sh"
fail=0
check() { if [ "$2" == "$3" ]; then echo "ok   $1: $2"; else echo "FAIL $1: got '$2', expected '$3'"; fail=1; fi; }
# the experiment, as the launcher configures it: a custom benchmark of BUF
vendor=wolfssl:wolfssl540-asan-only-CVE-2022-39173 target_bug=CVE-2022-39173 catalogue_source=commit
target_oracle='{"kind":"crash","asan":"stack-buffer-overflow"}'
objective=20261110-080500200-bbbb  # (not "t": a local of ObjectiveCounts)
ms() { date -u -d "$( sed -E 's/^([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{3}).*/\1-\2-\3 \4:\5:\6.\7/' <<< "$1" )" +%s%3N; }
# the fuzzer's record of the objective: a crash with BUF's ASan type (FuzzerRecords' format)
FuzzerRecords() {
  printf '%s\tcrash\tSIGABRT\tRefineSuites\t%s\tobjective/%s\n' "$(( $( ms "${objective}" ) - 80 ))" 2026-11-10T08:05:00.120+00:00 "${objective}"
  printf '%s\tasan\tstack-buffer-overflow\tRefineSuites\t%s\t\n' "$(( $( ms "${objective}" ) + 900 ))" 2026-11-10T08:05:01.100+00:00
}
FuzzerLogDir() { echo "$1"; }
# Attempt <ConfirmObjective's answer>: a fresh attempt folder, its validation prepared, the monitor's pass on it
Attempt() {
  local answer="$1" dir="${work}/attempt-$1";
  mkdir -p "${dir}/experiments/test/objective" "${dir}/validation" && cd "${dir}" || exit 1;
  echo '{ "status": "ready" }' > validation/state.json;
  echo trace > "experiments/test/objective/${objective}.trace";
  eval "ConfirmObjective() { echo 'stand-in'; return ${answer}; }";
  declare -gA verdicts=();
  TargetedObjectiveFound verdicts 2> monitor.log; found=$?;
}
Attempt 0
check 'validation confirms the find: the run ends' "${found}" 0
check 'its summary: confirmed_by validation' "$( RunConfirmation )" validation
Attempt 2
check 'validation cannot tell: the fuzzer'"'"'s record ends the run' "${found}" 0
check 'its summary: not confirmed by validation' "$( RunConfirmation )" ''
Attempt 1
check 'validation rejects the find: the run goes on' "${found}" 1
check 'its summary: not confirmed by validation' "$( RunConfirmation )" ''

# validation cannot tell, the target's place known (its witness's stack recorded when the validation was prepared): the
# fuzzer's record ends the run only at that place; a crash of its type elsewhere is another bug, the run goes on (F1 of
# the audit of 2026-11-16, as the report counts it)
qjs="${QJS:-/srv/puffin-bench/data/tools/qjs}"
if [ -x "${qjs}" ]; then
  mkdir -p "${work}/full/tools" "${work}/full/html/common" && ln -s "${qjs}" "${work}/full/tools/qjs" &&
    command cp -r "${here}/../../data/tools/js" "${work}/full/tools/js" && command cp -f "${here}/../../data/html/common/signatures.js" "${work}/full/html/common/"
  export THEJOB_TOOLS_PATH="${work}/full/tools"
  # the record as the fuzzer's crash handler writes it: its first 3 frames (all 853 crash records of the stored reports)
  FuzzerRecords() {
    printf '%s\tcrash\tSIGABRT\tRefineSuites < CheckPreSharedKeys < DoTls13ClientHello\t%s\tobjective/%s\n' "$(( $( ms "${objective}" ) - 80 ))" 2026-11-10T08:05:00.120+00:00 "${objective}"
    printf '%s\tasan\tstack-buffer-overflow\tRefineSuites < CheckPreSharedKeys < DoTls13ClientHello\t%s\t\n' "$(( $( ms "${objective}" ) + 900 ))" 2026-11-10T08:05:01.100+00:00
  }
  WitnessAttempt() { # <name> <witness's stack (JSON)>: the place of BUF known, validation cannot tell
    local dir="${work}/attempt-$1";
    mkdir -p "${dir}/experiments/test/objective" "${dir}/validation" && cd "${dir}" || exit 1;
    jq -n --argjson w "$2" '{ status: "ready", controls: [{ entry: "CVE-2022-39173", ok: true, witness_frames: $w }] }' > validation/state.json;
    echo trace > "experiments/test/objective/${objective}.trace";
    eval "ConfirmObjective() { echo 'stand-in'; return 2; }";
    declare -gA verdicts=();
    TargetedObjectiveFound verdicts 2> monitor.log; found=$?;
  }
  WitnessAttempt atplace '["RefineSuites", "CheckPreSharedKeys", "DoTls13ClientHello"]'
  check "validation cannot tell, the fuzzer's record at the target's place: the run ends" "${found}" 0
  WitnessAttempt elsewhere '["MatchSuite", "DoTls13ClientHello", "DoTls13HandShakeMsgType"]'
  check "validation cannot tell, the fuzzer's record of its type elsewhere: another bug, the run goes on" "${found}" 1
  check 'the monitor says why' "$( grep -c 'not at the place of CVE-2022-39173' monitor.log )" 1
  unset THEJOB_TOOLS_PATH
fi

# Vuln group A: BUF recognised by its place (vuln_targets.json), the tools without html/common beside them
qjs="${QJS:-/srv/puffin-bench/data/tools/qjs}"
if [ -x "${qjs}" ]; then
  mkdir -p "${work}/lone/tools" && ln -s "${qjs}" "${work}/lone/tools/qjs" && command cp -r "${here}/../../data/tools/js" "${work}/lone/tools/js"
  export THEJOB_TOOLS_PATH="${work}/lone/tools"
  declare -gA VULN_TARGETS=( ['wolfssl:wolfssl540-buf']='CVE-2022-39173|crash|RefineSuites < CheckPreSharedKeys < DoTls13ClientHello' )
  vendor=wolfssl:wolfssl540-buf target_bug='' target_oracle=''
  dir="${work}/vulna"; mkdir -p "${dir}/experiments/test/objective" && cd "${dir}" || exit 1
  echo trace > "experiments/test/objective/${objective}.trace"
  declare -gA verdicts=()
  TargetedObjectiveFound verdicts 2> monitor.log; found=$?
  check 'its place cannot be checked: the run does not end on it' "${found}" 1
  check 'the objective left pending, neither the target nor another bug' "${verdicts[${objective}]:-pending}" pending
  check 'the monitor says why' "$( grep -c 'could not be checked' monitor.log )" 1
  check 'the end-of-run counts: 1 objective whose place could not be checked, not "unexpected"' \
    "$( ObjectiveCounts "${dir}/experiments/test" 2> /dev/null )" '0 0 - 0 1'
fi
exit "${fail}"
