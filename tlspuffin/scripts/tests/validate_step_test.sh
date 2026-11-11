#!/bin/bash
# validate_step_test.sh <tlspuffin clone> <commit> <work dir> <vendor> <trace>=<expected verdict>[:<entry>]...
#
# Runs the ValidateObjectives step (PR_validate.sh) outside the scheduler, on a simulated task: <work dir>/out/repo is
# a clone of <tlspuffin clone>, the step's directory holds an experiment whose objectives are the given trace files,
# and the scheduler's cache (a directory of the work dir) and artefact functions are stubbed. The validation set of
# <vendor> is really built (with ASan) and every objective really executed. Checks the verdict of each trace, e.g.
#   seeds/seed_cve_2022_39173_minimized.trace=confirmed:CVE-2022-39173
#   seeds/seed_cve_2024_5814.trace=not-patched:CVE-2024-5814   (the entry named as a known bug without patch)
#   seeds/seed_successful13.trace=inconclusive
# and that the controls (the witnesses on the -only- and -fix-all builds) passed. Then runs the step again from another
# directory (attempt 1, the binary from the cache, run outside the checkout it was built in) on VALIDATION_TEST_VENDOR2
# (default <vendor>; e.g. wolfssl:CVE-2022-39173, a derived build validated on the set of its base preset): same
# checks, nothing built; and a third time (attempt 2) with VALIDATION_BUDGET=0: every objective "not-validated".
# Set VALIDATION_CATALOGUE=commit for a clone without origin/dev catalogue. Takes long: vendor builds and a release
# build of tlspuffin.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
clone="$1"; commit="$2"; work="$3"; vendor="$4"; shift 4
mkdir -p "${work}/out" "${work}/step/experiments/test/objective" "${work}/artefacts" "${work}/cache"
vendor2="${VALIDATION_TEST_VENDOR2:-${vendor}}"
work=$( cd "${work}" && pwd )
[ -d "${work}/out/repo" ] || git clone -q "${clone}" "${work}/out/repo"
sha=$( git -C "${work}/out/repo" rev-parse --verify "${commit}^{commit}" )

declare -A expected=()
for spec in "$@"; do
  trace="${spec%%=*}"; want="${spec#*=}"
  name=$( basename "${trace}" .trace )
  command cp -f "${trace}" "${work}/step/experiments/test/objective/${name}.trace"
  expected["${name}"]="${want}"
done

# the scheduler's helpers: a cache in <work dir>/cache (QueryCache [-q] <id>: the path of the cached file)
QueryCache() { [ "$1" == -q ] && shift; [ -f "${work}/cache/$1" ] || return 1; echo "${work}/cache/$1"; }
SetCache() { command cp -f "$2" "${work}/cache/$1"; echo "${work}/cache/$1"; }
CreateArtefact() { mkdir -p "${work}/artefacts/$( dirname "$2" )"; command cp -rf "$1" "${work}/artefacts/$2"; }
export THEJOB_OUT_PATH="${work}/out" THEJOB_STEP_ID=test THEJOB_STEP_ATTEMPT_ID=0 THEJOB_NB_CORES="${THEJOB_NB_CORES:-1}"
COMMIT_ID="${sha}"
# shellcheck source=../PR_validate.sh
source "${here}/../PR_validate.sh"

# Pass <attempt> <directory> <vendor> [<budget>]: the step in <directory> (a copy of the experiment)
fail=0
Pass() {
  local attempt="$1" dir="$2" passVendor="$3" budget="${4:-}"
  mkdir -p "${work}/${dir}"
  [ "${dir}" == step ] || command cp -rf "${work}/step/experiments" "${work}/${dir}/"
  cd "${work}/${dir}"
  printf 'LAUNCH_FLAGS=%q\nLAUNCH_NOASLR=%q\nLAUNCH_ASAN_SET=false\nLAUNCH_ASAN_OPTIONS=\n' "" "" > .currentlaunch
  export THEJOB_STEP_ATTEMPT_ID="${attempt}"
  local log
  log=$( vendor="${passVendor}" VALIDATION_BUDGET="${budget:-${VALIDATION_BUDGET:-1800}}" ValidateObjectives 2>&1 ) || { echo "FAIL: pass ${attempt}: ${log}"; exit 1; }
  lastLog="${log}"
  grep -E '^Validation' <<< "${log}"
  result="${THEJOB_OUT_PATH}/validation-test-${attempt}.json"
  [ -s "${result}" ] || { echo "FAIL: pass ${attempt}: no result"; tail -20 <<< "${log}"; exit 1; }
  echo "--- ${result}"
  jq -c '{ unsupported, error, vendor, build: .build.name, derived: .build.derived, validated_on, builds, controls_ok, controls }' "${result}"
}
Verdicts() {
  [ "$( jq -r '.unsupported // .error // empty' "${result}" )" == "" ] || { echo "FAIL: $( jq -r '.unsupported // .error' "${result}" )"; exit 1; }
  [ "$( jq -r .controls_ok "${result}" )" == true ] && [ "$( jq '[.controls[] | select(.ok == null)] | length' "${result}" )" == 0 ] &&
    echo "ok   controls (every candidate's witness ran)" || { echo "FAIL: controls"; fail=1; }
  for name in "${!expected[@]}"; do
    want="${expected[${name}]}"; verdict="${want%%:*}"; entry="${want#*:}"; [ "${entry}" == "${want}" ] && entry=''
    got=$( jq -c --arg t "${name}" '.objectives[] | select(.trace == $t) | { verdict, entries, known_unpatched }' "${result}" )
    ok=true
    [ "$( jq -r .verdict <<< "${got:-null}" )" == "${verdict}" ] || ok=false
    if [ -n "${entry}" ]; then
      jq -e --arg e "${entry}" '((.entries // []) + (.known_unpatched // [])) | index($e) != null' <<< "${got:-null}" > /dev/null || ok=false
    fi
    if ${ok}; then echo "ok   ${name}: ${got}"; else echo "FAIL ${name}: expected ${want}, got ${got:-nothing}"; fail=1; fi
  done
}

echo "=== pass 0: ${vendor}"
Pass 0 step "${vendor}"
Verdicts
[ -d "${work}/artefacts/test/0-validation" ] || { echo "FAIL: no artefact of the executions"; fail=1; }

echo "=== pass 1: ${vendor2}, from another directory, the binary from the cache"
Pass 1 step2 "${vendor2}"
Verdicts
grep -q "(binary ${work}/cache/validation-" <<< "${lastLog}" && echo "ok   the binary from the cache" || { echo "FAIL: pass 1 did not use the cache"; fail=1; }
[ "$( jq -r '.builds | length' "${result}" )" -gt 0 ] && echo "ok   the validation set of $( jq -r .validated_on "${result}" )" || { echo "FAIL: empty validation set"; fail=1; }
[ ! -d "${work}/step2/validation/vendor" ] || [ -z "$( ls -A "${work}/step2/validation/vendor" 2> /dev/null )" ] &&
  echo "ok   nothing built (cache)" || { echo "FAIL: pass 1 built vendors"; fail=1; }

echo "=== pass 2: no budget"
Pass 2 step3 "${vendor}" 0
[ "$( jq -r '[.objectives[].verdict] | unique | join(",")' "${result}" )" == not-validated ] &&
  [ "$( jq -r '.objectives | length' "${result}" )" == "${#expected[@]}" ] &&
  echo "ok   every objective not-validated (budget 0)" || { echo "FAIL pass 2 verdicts: $( jq -c '[.objectives[].verdict]' "${result}" )"; fail=1; }
exit ${fail}
