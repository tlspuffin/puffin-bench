#!/bin/bash
# inrun_confirm_test.sh <tlspuffin clone> <commit> <work dir> <buf trace> <cve-2024-5814 trace> <sig trace>: a custom
# benchmark's experiment looking for CVE-2022-39173 (BUF) on wolfssl:wolfssl540-asan-only-CVE-2022-39173, with the
# validation prepared before it (PrepareValidation) and three objectives, the fuzzer's records of them synthetic (in its
# format, FuzzerRecords replaced):
#   t0, a claim "Authentication bypass" (the SIG witness): not BUF's oracle, never validated;
#   t1, recorded as a crash with ASan stack-buffer-overflow, BUF's signature, but the CVE-2024-5814 trace: validation
#       must reject it (it reproduces on the build with every patch, as CVE-2024-5814), and the experiment go on;
#   t2, the BUF witness, recorded as such: validation confirms it, the experiment ends.
# Then ExperimentEnd's counts: one targeted objective, the time to find t2's (when the fuzzer saved it), t0 and t1
# unexpected; and ValidateObjectives keeps the verdicts of the monitor. Real builds (or <work dir>/cache: a validation
# binary of an earlier run, copied or linked there) and real executions.
set -uo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
clone="$1"; commit="$2"; work="$3"; buf="$4"; downgrade="$5"; sig="$6"
mkdir -p "${work}/out" "${work}/cache" "${work}/artefacts"
work=$( cd "${work}" && pwd )
[ -d "${work}/out/repo" ] || git clone -q "${clone}" "${work}/out/repo"
QueryCache() { [ "$1" == -q ] && shift; [ -f "${work}/cache/$1" ] || return 1; echo "${work}/cache/$1"; }
SetCache() { command cp -f "$2" "${work}/cache/$1"; echo "${work}/cache/$1"; }
CreateArtefact() { mkdir -p "${work}/artefacts/$( dirname "$2" )"; command cp -rf "$1" "${work}/artefacts/$2"; }
export THEJOB_OUT_PATH="${work}/out" THEJOB_STEP_ID=VulnC_BUF THEJOB_STEP_ATTEMPT_ID=0 THEJOB_NB_CORES="${THEJOB_NB_CORES:-1}"
COMMIT_ID=$( git -C "${work}/out/repo" rev-parse --verify "${commit}^{commit}" )
# shellcheck source=../PR_common.sh
source "${here}/../PR_common.sh"
# shellcheck source=../PR_validate.sh
source "${here}/../PR_validate.sh"
# shellcheck source=../PR_vulnerabilities.sh
source "${here}/../PR_vulnerabilities.sh"

# the experiment, as the launcher configures it
vendor=wolfssl:wolfssl540-asan-only-CVE-2022-39173 target_bug=CVE-2022-39173 catalogue_source=commit
target_oracle='{"kind":"crash","asan":"stack-buffer-overflow"}'
step="${work}/step"; rm -rf "${step}"; mkdir -p "${step}/experiments/test/objective"; cd "${step}" || exit 1
t0=20261110-075900000-cccc t1=20261110-080000100-aaaa t2=20261110-080500200-bbbb
command cp -f "${sig}" "experiments/test/objective/${t0}.trace"
command cp -f "${downgrade}" "experiments/test/objective/${t1}.trace"
command cp -f "${buf}" "experiments/test/objective/${t2}.trace"
printf 'LAUNCH_FLAGS=%q\nLAUNCH_NOASLR=%q\nLAUNCH_ASAN_SET=false\nLAUNCH_ASAN_OPTIONS=\n' "" "" > .currentlaunch
# the fuzzer's records (FuzzerRecords' format): t0 a claim, t1 and t2 crashes with their ASan reports
ms() { date -u -d "$( sed -E 's/^([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{3}).*/\1-\2-\3 \4:\5:\6.\7/' <<< "$1" )" +%s%3N; }
FuzzerRecords() {
  printf '%s\twarn\tAuthentication bypass\t\t%s\t\n' "$( ms "${t0}" )" 2026-11-10T07:59:00.000+00:00
  printf '%s\tcrash\tSIGABRT\tRefineSuites\t%s\tobjective/%s\n' "$(( $( ms "${t1}" ) - 80 ))" 2026-11-10T08:00:00.020+00:00 "${t1}"
  printf '%s\tasan\tstack-buffer-overflow\tRefineSuites\t%s\t\n' "$(( $( ms "${t1}" ) + 900 ))" 2026-11-10T08:00:01.000+00:00
  printf '%s\tcrash\tSIGABRT\tRefineSuites\t%s\tobjective/%s\n' "$(( $( ms "${t2}" ) - 80 ))" 2026-11-10T08:05:00.120+00:00 "${t2}"
  printf '%s\tasan\tstack-buffer-overflow\tRefineSuites\t%s\t\n' "$(( $( ms "${t2}" ) + 900 ))" 2026-11-10T08:05:01.100+00:00
}
FuzzerLogDir() { echo "$1"; }

fail=0
check() { if [ "$2" == "$3" ]; then echo "ok   $1: $2"; else echo "FAIL $1: got '$2', expected '$3'"; fail=1; fi; }

echo "=== PrepareValidation (before the experiment)"
PrepareValidation | grep -E '^Validation'
check 'validation prepared' "$( jq -r .status validation/state.json )" ready
check 'on the base preset' "$( jq -r '.lib + ":" + .preset' validation/state.json )" wolfssl:wolfssl540-asan

echo "=== the monitor, during the experiment"
declare -A verdicts=()
TargetedObjectiveFound verdicts 2> monitor.log; found=$?
sed 's/^/     /' monitor.log
check 'the experiment ends' "${found}" 0
check "t0 (a claim): not BUF's oracle" "${verdicts[${t0}]:-}" not-targeted
check 't1 (BUF signature, CVE-2024-5814 trace): rejected by validation' "${verdicts[${t1}]:-}" not-targeted
check 't2 (BUF): confirmed by validation' "${verdicts[${t2}]:-}" targeted
check 't0 was not validated' "$( [ -e "validation/verdicts/${t0}.json" ] && echo yes || echo no )" no
check 't1, validated during the attempt' "$( jq -r '.verdict + " " + (.known_unpatched | join(",")) + " " + (.during_attempt | tostring)' "validation/verdicts/${t1}.json" )" 'not-patched CVE-2024-5814 true'

echo "=== ExperimentEnd's counts"
read -r targeted excluded first unexpected <<< "$( ObjectiveCounts "${step}/experiments/test" )"
check 'targeted objectives' "${targeted}" 1
check 'unexpected objectives (t0, t1)' "${unexpected}" 2
check "the time to find: when the fuzzer saved t2" "${first}" "$( ms "${t2}" )"
check 'the targeted names' "$( TargetedNames "${step}/experiments/test" | tr '\n' ' ' )" "${t2} "

echo "=== ValidateObjectives (after the experiment)"
ValidateObjectives | grep -E '^Validation'
result="${THEJOB_OUT_PATH}/validation-VulnC_BUF-0.json"
check 't2 confirmed, during the attempt' "$( jq -r --arg t "${t2}" '.objectives[] | select(.trace == $t) | .verdict + " " + (.entries | join(",")) + " " + (.during_attempt | tostring)' "${result}" )" 'confirmed CVE-2022-39173 true'
check 't0 validated after' "$( jq -r --arg t "${t0}" '.objectives[] | select(.trace == $t) | .verdict + " " + (.during_attempt // false | tostring)' "${result}" )" 'inconclusive false'
check 'the checkout removed' "$( [ -d validation/tree ] && echo kept || echo removed )" removed
exit ${fail}
