#!/bin/bash
# validation_choice_test.sh: which objectives of a run the validation takes (ValidationChoice, PR_validate.sh), at most
# VALIDATION_MAX: the targeted ones first, then the first of each bug by the fuzzer's record (its claim, or the top
# frame of its crash), then the others by time. A run of 30 objectives of one bug and one each of two others, with a
# limit of 5: the three bugs are validated. The fuzzer's records are stand-ins (FuzzerRecords, FuzzerVerdicts).
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
exit "${fail}"
