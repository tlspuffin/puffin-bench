#!/bin/bash
# custom_target_test.sh <tlspuffin clone> [<commit with the catalogue> (default HEAD)]: the experiments of custom benchmarks
# in the job scripts (PR_common.sh), on synthetic records in the fuzzer's own format:
#   - OracleMatches: a catalogue entry's oracle against a fuzzer's record (claim message; crash signal and ASan report
#     type) and against a replay ("ASan <type>");
#   - ExpectedTarget: the experiment's target (target_bug, target_oracle) first, else the preset's (VULN_TARGETS);
#     TargetMatches on both: a VulnA crash target by its place (HasPlace: common/signatures.js through
#     tools/js/has_place.js and qjs, the rule of the pages), BUF's crash not taken for SDOS2;
#   - ObjectiveTargeted from fuzzer records (FuzzerRecords lines -> FuzzerVerdict): the expected bug, another bug; a
#     claim set apart (CVE-2024-5814 on wolfSSL < 5.7.2) does not count, but in the experiment that looks for it;
#   - KnownVendorBuild: presets and builds derived from the catalogue, with the clone's presets.toml and
#     vulnerabilities.toml;
#   - CustomExperimentJSON: what cli-<step>.json records (null for Vuln group A and B, which name their bug too).
set -uo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
clone="${1:?usage: custom_target_test.sh <tlspuffin clone> [<commit>]}"; commit="${2:-HEAD}"
# shellcheck source=../PR_common.sh
source "${here}/../PR_common.sh"
# the bench's tools as installed (<data>/tools/{qjs,js} beside <data>/html/common): what HasPlace runs
qjs="${QJS:-/srv/puffin-bench/data/tools/qjs}"
[ -x "${qjs}" ] || { echo "SKIP: no qjs at ${qjs}"; exit 0; }
data=$( mktemp -d ); trap 'rm -rf "${data}"' EXIT
mkdir -p "${data}/tools" "${data}/html" && ln -s "${qjs}" "${data}/tools/qjs" &&
  cp -r "${here}/../../data/tools/js" "${data}/tools/js" && cp -r "${here}/../../data/html/common" "${data}/html/common"
export THEJOB_TOOLS_PATH="${data}/tools"

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
expect "ASan SEGV, the fuzzer's record: its signal only" 0 OracleMatches "${SEGV}" crash 'SIGSEGV'
expect 'ASan SEGV, a record of another signal'           1 OracleMatches "${SEGV}" crash 'SIGABRT'
expect 'ASan SEGV, a record with another ASan report'    1 OracleMatches "${SEGV}" crash 'SIGSEGV · ASan heap-buffer-overflow'
expect 'a replay ("ASan <type>")'                        0 OracleMatches "${BUF}" crash 'ASan stack-buffer-overflow'
expect 'claim with its message'                          0 OracleMatches "${AUTH}" claim 'Authentication bypass'
expect 'claim with another message'                      1 OracleMatches "${AUTH}" claim "Negotiated cipher is not in agent's configured ciphers list"
expect 'a crash is not a claim'                          1 OracleMatches "${AUTH}" crash 'SIGABRT · ASan stack-buffer-overflow'
expect 'signal oracle'                                   0 OracleMatches "${SIGNAL}" crash 'SIGSEGV · ASan SEGV'
expect 'signal oracle, other signal'                     1 OracleMatches "${SIGNAL}" crash 'SIGABRT'
expect 'no oracle'                                       1 OracleMatches 'null' crash 'SIGABRT'

echo "--- ExpectedTarget, TargetMatches"
declare -gA VULN_TARGETS=( ['wolfssl:wolfssl540-buf']='CVE-2022-39173|crash|RefineSuites < CheckPreSharedKeys < DoTls13ClientHello' )
same 'a VulnA preset: its target, its place' "$( ExpectedTarget wolfssl:wolfssl540-buf )" 'CVE-2022-39173|crash|RefineSuites < CheckPreSharedKeys < DoTls13ClientHello'
expect 'VulnA place, whatever the detail'        0 TargetMatches 'CVE-2022-39173|crash|RefineSuites < CheckPreSharedKeys < DoTls13ClientHello' crash 'ASan stack-buffer-overflow' 'RefineSuites < CheckPreSharedKeys < DoTls13ClientHello'
expect 'VulnA place, with an ASan frame first'   0 TargetMatches 'CVE-2022-39173|crash|RefineSuites < CheckPreSharedKeys < DoTls13ClientHello' crash '' '__asan_memcpy < RefineSuites < CheckPreSharedKeys'
expect 'VulnA place, another crash'              1 TargetMatches 'CVE-2022-39173|crash|RefineSuites < CheckPreSharedKeys < DoTls13ClientHello' crash '' 'AddPacketInfo < DoTls13HandShakeMsgType'
expect "BUF's crash is not SDOS2 (DoTls13ClientHello its 3rd frame)" 1 TargetMatches 'CVE-2022-38152|crash|DoTls13ClientHello < DoTls13HandShakeMsgType < DoTls13HandShakeMsg' crash '' 'RefineSuites < CheckPreSharedKeys < DoTls13ClientHello'
expect "SDOS2's crash in glibc's memmove is SDOS2" 0 TargetMatches 'CVE-2022-38152|crash|DoTls13ClientHello < DoTls13HandShakeMsgType < DoTls13HandShakeMsg' crash '' '__memmove_avx_unaligned_erms < DoTls13ClientHello < DoTls13HandShakeMsgType'
expect 'no tools: never a match'                 1 env THEJOB_TOOLS_PATH=/nonexistent bash -c 'source "$1"; TargetMatches "CVE-2022-39173|crash|RefineSuites < CheckPreSharedKeys < DoTls13ClientHello" crash "" "RefineSuites < CheckPreSharedKeys < DoTls13ClientHello"' _ "${here}/../PR_common.sh"
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

# the claim of CVE-2024-5814, set apart on wolfSSL < 5.7.2 (vuln_targets.json _not_targeted), in a run of wolfSSL 5.4.0
CLAIM="Negotiated cipher is not in agent's configured ciphers list"
declare -gA OBJECTIVES_NOT_TARGETED=( ["${CLAIM}"]='CVE-2024-5814|wolfssl|5.7.2' )
work=$( mktemp -d ); ( cd "${work}" && echo 'C harness, wolfssl540-asan' > .build_info )
claims=$( printf '%s\t%s\t%s\t%s\t%s\t%s\n' 1794297700000 warn "${CLAIM}" '' '2026-11-10T08:01:40.000+00:00' '' )
( cd "${work}" && ObjectiveTargeted "${claims}" 20261110-080140000-123456 ); rc=$?
same 'a claim set apart (CVE-2024-5814 on 5.4.0), no target: not targeted (1)' "${rc}" 1
target_bug=CVE-2022-39173; target_oracle="${BUF}"
( cd "${work}" && ObjectiveTargeted "${claims}" 20261110-080140000-123456 "$( ExpectedTarget x )" ); rc=$?
same 'the same claim in a BUF experiment: set apart (1)' "${rc}" 1
target_bug=CVE-2024-5814; target_oracle="{\"kind\":\"claim\",\"violation\":\"${CLAIM}\"}"
( cd "${work}" && ObjectiveTargeted "${claims}" 20261110-080140000-123456 "$( ExpectedTarget x )" ); rc=$?
same 'the same claim in the experiment of CVE-2024-5814: its target (0)' "${rc}" 0
unset target_bug target_oracle; rm -rf "${work}"

echo "--- KnownVendorBuild"
THEJOB_OUT_PATH=$( mktemp -d ); trap 'rm -rf "${THEJOB_OUT_PATH}"' EXIT
mkdir -p "${THEJOB_OUT_PATH}/repo/puffin-build/vendors/wolfssl"
# the commit, and the commit before presets.toml format 2 when the commit has it
v2=$( git -C "${clone}" log -1 --format=%H -G'^format = 2' "${commit}" -- puffin-build/vendors/wolfssl/presets.toml )
for ref in "${commit}" ${v2:+${v2}^}; do
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
same 'a VulnA configuration naming its bug: the rule of its preset' "$( ExpectedTarget wolfssl:wolfssl540-buf )" 'CVE-2022-39173|crash|RefineSuites < CheckPreSharedKeys < DoTls13ClientHello'
same 'it is not a custom experiment' "$( CustomExperimentJSON )" null
unset target_bug

echo "--- CustomExperimentJSON"
same 'not a custom experiment' "$( CustomExperimentJSON )" null
benchmark=VulnC target_bug=CVE-2022-38152 target_oracle="${SEGV}" catalogue_source=commit
same 'a custom experiment' "$( CustomExperimentJSON )" '{"benchmark":"VulnC","target":"CVE-2022-38152","oracle":{"kind":"crash","asan":"SEGV"},"catalogue":"commit"}'
exit ${fail}
