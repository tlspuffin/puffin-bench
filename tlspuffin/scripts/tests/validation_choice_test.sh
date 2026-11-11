#!/bin/bash
# validation_choice_test.sh: which objectives of a run the validation takes (ValidationChoice, PR_validate.sh), at most
# VALIDATION_MAX: the targeted ones first, then the first of each bug by the fuzzer's record (its claim, or the top
# frame of its crash), then the others by time. A run of 30 objectives of one bug and one each of two others, with a
# limit of 5: the three bugs are validated. The fuzzer's records are stand-ins (FuzzerRecords, FuzzerVerdicts).
# Then a twin step of Perf (TwinValidateObjectives, PR_perf.sh): each of its two runs validated in its folder, under its
# run number.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
# shellcheck source=../PR_validate.sh
source "${here}/../PR_validate.sh"
exp="${work}/experiments/run/"; mkdir -p "${exp}objective"
# 30 objectives of a claim (the oldest), then a crash in RefineSuites, then a crash in AddPacketInfo
for i in $( seq -w 1 30 ); do touch -d "2026-11-10 10:00:${i}" "${exp}objective/20261110-0900${i}000-a${i}.trace"; done
touch -d '2026-11-10 10:01:00' "${exp}objective/20261110-090100000-buf.trace"
touch -d '2026-11-10 10:02:00' "${exp}objective/20261110-090200000-heap.trace"
FuzzerLogDir() { echo "${work}/logs"; }
FuzzerRecords() { echo records; }
FuzzerVerdicts() {
  while read -r name; do
    case "${name}" in
      *-a*) printf '%s\tclaim\tAuthentication bypass\t\t1\n' "${name}";;
      *-buf) printf '%s\tcrash\tSIGSEGV\tRefineSuites < CheckPreSharedKeys\t1\n' "${name}";;
      *-heap) printf '%s\tcrash\tSIGSEGV\tAddPacketInfo < DoTls13HandShakeMsgType\t1\n' "${name}";;
    esac
  done
}
chosen=$( VALIDATION_MAX=5 ValidationChoice "${exp}" | sed 's#.*/##' )
check 'at most VALIDATION_MAX' '[ "$( wc -l <<< "${chosen}" )" == 5 ]'
check 'each bug among them' 'grep -q -- "-a01.trace" <<< "${chosen}" && grep -q -- "-buf.trace" <<< "${chosen}" && grep -q -- "-heap.trace" <<< "${chosen}"'
check 'the first of each bug first, by time' '[ "$( head -3 <<< "${chosen}" | tr "\n" " " )" == "20261110-090001000-a01.trace 20261110-090100000-buf.trace 20261110-090200000-heap.trace " ]'
check 'then the others by time' '[ "$( tail -2 <<< "${chosen}" | tr "\n" " " )" == "20261110-090002000-a02.trace 20261110-090003000-a03.trace " ]'
echo 20261110-090025000-a25 > "${exp}.targeted-names"
chosen=$( VALIDATION_MAX=5 ValidationChoice "${exp}" | sed 's#.*/##' )
check 'the targeted ones before all' '[ "$( head -1 <<< "${chosen}" )" == "20261110-090025000-a25.trace" ]'
unset -f FuzzerVerdicts
chosen=$( VALIDATION_MAX=3 ValidationChoice "${exp}" | sed 's#.*/##' )
check 'without the fuzzer records: targeted, then by time' '[ "$( tr "\n" " " <<< "${chosen}" )" == "20261110-090025000-a25.trace 20261110-090001000-a01.trace 20261110-090002000-a02.trace " ]'

# a twin step: its two runs (twin0, twin1: runs 2 and 3 of attempt 1), each validated in its folder under its run
source <( sed -n '/^TwinValidateObjectives()/,/^}/p' "${here}/../PR_perf.sh" )
ValidateObjectives() { echo "$( basename "${PWD}" ) ${THEJOB_STEP_ATTEMPT_ID}" >> "${work}/validated"; }
mkdir -p "${work}/step/twin0" "${work}/step/twin1" && echo "2 1" > "${work}/step/twin0/.step_run" && echo "3 1" > "${work}/step/twin1/.step_run"
( cd "${work}/step" && THEJOB_STEP_ATTEMPT_ID=1 TwinValidateObjectives )
check 'a twin step: both runs, each in its folder under its run number' '[ "$( tr "\n" " " < "${work}/validated" )" == "twin0 2 twin1 3 " ]'
exit "${fail}"
