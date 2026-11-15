#!/bin/bash
# build_features_test.sh: the cargo features of a build (PR_common.sh ComputeBuildRuntimeInfo), on a checkout made here:
#   - an ASAN preset with the asan feature (the launcher's, or a task launched before it stopped giving it) at a
#     tlspuffin commit without that cargo feature (tlspuffin 838bd9588 removed them): the feature is dropped, said, and
#     the build goes on (its ASAN comes with the preset); the other features are kept;
#   - the same at a commit that has the feature: kept;
#   - the asan feature with a preset without ASAN, or another feature the commit lacks: unsupported, as before.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; echo "${out}" | sed 's/^/     /'; fail=1; fi; }
source <( sed -n '/^ComputeBuildRuntimeInfo()/,/^}/p' "${here}/../PR_common.sh" )
CompatBuildRules() { return 0; }
export THEJOB_OUT_PATH="${work}"
mkdir -p "${work}/repo/tlspuffin"
build() {
  local vendor="$1"; required_features="$2"; features=''; cputs=false;
  out=$( ComputeBuildRuntimeInfo tlspuffin "${vendor}" features cputs 2>&1 ) && rc=0 || rc=$?;
  ComputeBuildRuntimeInfo tlspuffin "${vendor}" features cputs > /dev/null 2>&1 || true;
}
# a commit after tlspuffin 838bd9588: no asan feature
printf '[features]\ndefault = ["sancov"]\ncputs = []\nintrospection = []\n' > "${work}/repo/tlspuffin/Cargo.toml"
build wolfssl:wolfssl584-asan asan
check 'an ASAN preset, the asan feature, a commit without it: dropped, said, the build goes on' \
  '[ "${rc}" -eq 0 ] && [ "${features}" == "" ] && grep -q "asan: no such cargo feature at this commit; the preset wolfssl584-asan builds the library with ASAN: dropped" <<< "${out}"'
build wolfssl:wolfssl552-asan-only-CVE-2023-6936 asan,introspection
check 'a custom preset with ASAN: asan dropped, introspection kept' '[ "${rc}" -eq 0 ] && [ "${features}" == "introspection" ]'
build wolfssl:wolfssl584 asan
check 'the asan feature with a preset without ASAN: unsupported, as before' '[ "${rc}" -eq 1 ] && grep -q "Unsupported feature asan" <<< "${out}"'
build wolfssl:wolfssl584-asan gcov
check 'another feature the commit lacks: unsupported, as before' '[ "${rc}" -eq 1 ] && grep -q "Unsupported feature gcov" <<< "${out}"'
# a commit before tlspuffin 838bd9588: the asan feature exists
printf '[features]\ndefault = ["sancov"]\nasan = []\ncputs = []\n' > "${work}/repo/tlspuffin/Cargo.toml"
build wolfssl:wolfssl540-asan asan
check 'a commit with the asan feature: kept' '[ "${rc}" -eq 0 ] && [ "${features}" == "asan," ] && ! grep -q dropped <<< "${out}"'
exit "${fail}"
