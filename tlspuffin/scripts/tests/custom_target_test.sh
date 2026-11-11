#!/bin/bash
# custom_target_test.sh <tlspuffin clone with the catalogue (pr/vuln-catalogue)>: the experiments of custom benchmarks
# in the job scripts (PR_common.sh), on synthetic records in the fuzzer's own format:
#   - OracleMatches: a catalogue entry's oracle against a fuzzer's record (claim message; crash signal and ASan report
#     type) and against a replay ("ASan <type>");
#   - ExpectedTarget: the experiment's target (target_bug, target_oracle) first, else the preset's (VULN_TARGETS);
#     TargetMatches on both, the frame rule of VulnA unchanged;
#   - ObjectiveTargeted from fuzzer records (FuzzerRecords lines -> FuzzerVerdict): the expected bug, another bug;
#   - KnownVendorBuild: presets and builds derived from the catalogue, with the clone's presets.toml and
#     vulnerabilities.toml;
#   - CustomExperimentJSON: what cli-<step>.json records (null for Vuln group A and B, which name their bug too).
set -uo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
clone="${1:?usage: custom_target_test.sh <tlspuffin clone>}"
# shellcheck source=../PR_common.sh
source "${here}/../PR_common.sh"

fail=0
expect() { # expect <description> <0|1> <command...>
  local what="$1" want="$2"; shift 2
  "$@" > /dev/null 2>&1; local got=$(( $? == 0 ? 0 : 1 ))
  if (( got == want )); then echo "ok   ${what}"; else echo "FAIL ${what} (status ${got}, expected ${want})"; fail=1; fi
}
same() { # same <description> <got> <want>
  if [ "$2" == "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$2', expected '$3'"; fail=1; fi
}

BUF='{"kind":"crash","asan":"stack-buffer-overflow"}'
SEGV='{"kind":"crash","asan":"SEGV"}'
AUTH='{"kind":"claim","violation":"Authentication bypass"}'
SIGNAL='{"kind":"crash","signal":"SIGSEGV"}'
echo "--- OracleMatches"
expect 'crash with its ASan report type'                 0 OracleMatches "${BUF}" crash 'SIGABRT · ASan stack-buffer-overflow'
expect 'crash with another ASan report type'             1 OracleMatches "${BUF}" crash 'SIGABRT · ASan heap-buffer-overflow'
expect 'crash without ASan report (record incomplete)'   1 OracleMatches "${BUF}" crash 'SIGABRT'
expect 'ASan SEGV'                                       0 OracleMatches "${SEGV}" crash 'SIGSEGV · ASan SEGV'
expect 'a replay ("ASan <type>")'                        0 OracleMatches "${BUF}" crash 'ASan stack-buffer-overflow'
expect 'claim with its message'                          0 OracleMatches "${AUTH}" claim 'Authentication bypass'
expect 'claim with another message'                      1 OracleMatches "${AUTH}" claim "Negotiated cipher is not in agent's configured ciphers list"
expect 'a crash is not a claim'                          1 OracleMatches "${AUTH}" crash 'SIGABRT · ASan stack-buffer-overflow'
expect 'signal oracle'                                   0 OracleMatches "${SIGNAL}" crash 'SIGSEGV · ASan SEGV'
expect 'signal oracle, other signal'                     1 OracleMatches "${SIGNAL}" crash 'SIGABRT'
expect 'no oracle'                                       1 OracleMatches 'null' crash 'SIGABRT'

echo "--- ExpectedTarget, TargetMatches"
declare -gA VULN_TARGETS=( ['wolfssl:wolfssl540-buf']='CVE-2022-39173|crash|RefineSuites' )
same 'a VulnA preset: its target' "$( ExpectedTarget wolfssl:wolfssl540-buf )" 'CVE-2022-39173|crash|RefineSuites'
expect 'VulnA frame rule, unchanged by the detail' 0 TargetMatches 'CVE-2022-39173|crash|RefineSuites' crash 'ASan stack-buffer-overflow' 'RefineSuites < DoTls13ClientHello'
expect 'VulnA frame rule, another frame'         1 TargetMatches 'CVE-2022-39173|crash|RefineSuites' crash '' 'AddPacketInfo < DoTls13HandShakeMsgType'
target_bug=CVE-2022-39173; target_oracle="${BUF}"
same 'a custom experiment: its catalogue entry' "$( ExpectedTarget wolfssl:CVE-2022-39173 )" 'CVE-2022-39173|oracle|'
expect 'oracle target, matching record'          0 TargetMatches "$( ExpectedTarget x )" crash 'SIGABRT · ASan stack-buffer-overflow' 'RefineSuites'
expect 'oracle target, another bug'              1 TargetMatches "$( ExpectedTarget x )" crash 'SIGSEGV · ASan heap-buffer-overflow' 'AddPacketInfo'

echo "--- ObjectiveTargeted, from the fuzzer's records"
# an objective saved at 2026-11-10 08:00:00.100 UTC (its name), the crash logged 80 ms before with its ASan report
records=$( printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
  1794297600020 crash SIGABRT 'RefineSuites < DoTls13ClientHello' '2026-11-10T08:00:00.020+00:00' 'objective/20261110-080000100-abcdef' \
  1794297601000 asan stack-buffer-overflow 'RefineSuites < DoTls13ClientHello' '2026-11-10T08:00:01.000+00:00' '' \
  1794297700000 warn 'Authentication bypass' '' '2026-11-10T08:01:40.000+00:00' '' )
same 'the fuzzer verdict of the crash' "$( FuzzerVerdict "${records}" 20261110-080000100-abcdef | cut -f1,2 )" "$( printf 'crash\tSIGABRT · ASan stack-buffer-overflow' )"
expect 'BUF experiment: the objective is its bug'   0 ObjectiveTargeted "${records}" 20261110-080000100-abcdef "$( ExpectedTarget x )"
target_bug=CVE-2021-3336; target_oracle="${AUTH}"
expect '3336 experiment: the claim is its oracle'   0 ObjectiveTargeted "${records}" 20261110-080140000-123456 "$( ExpectedTarget x )"
ObjectiveTargeted "${records}" 20261110-080000100-abcdef "$( ExpectedTarget x )"; rc=$?
same '3336 experiment: the crash is another bug (3)' "${rc}" 3
unset target_bug target_oracle

echo "--- KnownVendorBuild"
THEJOB_OUT_PATH=$( mktemp -d ); trap 'rm -rf "${THEJOB_OUT_PATH}"' EXIT
mkdir -p "${THEJOB_OUT_PATH}/repo/puffin-build/vendors/wolfssl"
# the clone's head, and the commit before presets.toml format 2 when the head has it
v2=$( git -C "${clone}" log -1 --format=%H -G'^format = 2' -- puffin-build/vendors/wolfssl/presets.toml )
for ref in HEAD ${v2:+${v2}^}; do
  for f in presets.toml vulnerabilities.toml; do
    git -C "${clone}" show "${ref}:puffin-build/vendors/wolfssl/${f}" > "${THEJOB_OUT_PATH}/repo/puffin-build/vendors/wolfssl/${f}" || { echo "FAIL: ${clone} has no ${f}"; exit 1; }
  done
  format=$( grep -E -q '^format = 2' "${THEJOB_OUT_PATH}/repo/puffin-build/vendors/wolfssl/presets.toml" && echo 2 || echo 1 )
  echo "    (presets.toml format ${format}, ${ref})"
  expect 'a preset'                                0 KnownVendorBuild wolfssl wolfssl540-asan
  expect 'a preset, not the prefix of another'     0 KnownVendorBuild wolfssl wolfssl540
  expect 'a preset of a benchmark'                 0 KnownVendorBuild wolfssl wolfssl540-heap
  expect 'an entry of the catalogue'               0 KnownVendorBuild wolfssl CVE-2022-39173
  expect '<preset>-only-<ID>'                      0 KnownVendorBuild wolfssl wolfssl540-asan-only-CVE-2022-39173
  expect '<preset>-fix-all'                        0 KnownVendorBuild wolfssl wolfssl540-asan-fix-all
  expect 'no such entry'                           1 KnownVendorBuild wolfssl CVE-2099-0001
  expect 'no such preset under -only-'             1 KnownVendorBuild wolfssl wolfssl999-only-CVE-2022-39173
  expect 'no such library'                         1 KnownVendorBuild nosuchlib CVE-2022-39173
  if [ "${format}" == 2 ]; then
    expect 'format 2: a name with modifiers'       0 KnownVendorBuild wolfssl wolfssl540-asan-no-postauth
    expect 'format 2: the comma form'              0 KnownVendorBuild wolfssl 5.4.0,asan,only-BUF
    expect 'format 2: no such version'             1 KnownVendorBuild wolfssl wolfssl999-asan
  fi
done

echo "--- Vuln group A and B: their bug named, their rule kept"
unset benchmark target_oracle; target_bug=CVE-2022-39173
same 'a VulnA configuration naming its bug: the frame rule of its preset' "$( ExpectedTarget wolfssl:wolfssl540-buf )" 'CVE-2022-39173|crash|RefineSuites'
same 'it is not a custom experiment' "$( CustomExperimentJSON )" null
unset target_bug

echo "--- CustomExperimentJSON"
same 'not a custom experiment' "$( CustomExperimentJSON )" null
benchmark=VulnC target_bug=CVE-2022-38152 target_oracle="${SEGV}" catalogue_source=commit
same 'a custom experiment' "$( CustomExperimentJSON )" '{"benchmark":"VulnC","target":"CVE-2022-38152","oracle":{"kind":"crash","asan":"SEGV"},"catalogue":"commit"}'
exit ${fail}
