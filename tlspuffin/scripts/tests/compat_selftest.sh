#!/bin/bash
#
# Self-test of the compat rules (PR_compat.sh) against a tlspuffin clone.
#
# For every first-parent commit of <rev-range>, checks that the probe of each rule matches its
# declared range, and checks a few pinned expectations at the range boundaries.
#
# Usage: compat_selftest.sh <tlspuffin clone (not shallow)> [rev-range]
#   default rev-range: 3bc37034a^..origin/dev

BASE_PATH="$( dirname $( realpath "${BASH_SOURCE[0]}" ) )";
source "${BASE_PATH}/../PR_compat.sh"

COMPAT_REPO="$1";
REV_RANGE="${2:-3bc37034a^..origin/dev}";

if [ -z "${COMPAT_REPO}" ] || ! git -C "${COMPAT_REPO}" rev-parse --git-dir > /dev/null 2>&1; then
  echo "Usage: $0 <tlspuffin clone> [rev-range]" >&2;
  exit 2;
fi
if [ "$( git -C "${COMPAT_REPO}" rev-parse --is-shallow-repository )" == "true" ]; then
  echo "${COMPAT_REPO} is a shallow clone, run: git -C ${COMPAT_REPO} fetch --unshallow" >&2;
  exit 2;
fi

nbErrors=0;
nbChecks=0;

# $1 rule id, $2 commit, $3 expected probe result (true|false)
Check() {
  local id="$1";
  local commit="$2";
  local expected="$3";
  local probe=false;
  COMPAT_GIT_REV="${commit}" CompatProbe_${id} && probe=true;
  (( ++nbChecks ));
  if [ "${probe}" != "${expected}" ]; then
    (( ++nbErrors ));
    echo "FAIL ${id} $( git -C "${COMPAT_REPO}" log -1 --format='%h %ad %s' --date=short "${commit}" ): probe=${probe} expected=${expected}";
  fi
}

# pinned expectations at the boundaries
Check wo_bit      47c97cd7ac2cdad73cd9c9b1753b69f857298c89 true
Check wo_bit      2f38bf22a                                true
Check wo_bit      e13983d6a6e186cde04fffeb12914f06b4ff9b68 false
Check wo_bit      47c97cd7ac2cdad73cd9c9b1753b69f857298c89^1 false
Check log_config  60b3f3185edd8dc6515c578e6321bf7a6f00fc2b true
Check log_config  2f38bf22a                                true
Check log_config  e13983d6a6e186cde04fffeb12914f06b4ff9b68 false
Check log_config  60b3f3185edd8dc6515c578e6321bf7a6f00fc2b^1 false
Check wo_trunc    2ed7077aa2a3b937dcbb18d5fc80797bc43f0337 true
Check wo_trunc    a768e78f3                                true
Check wo_trunc    24f7f10c2425fafcddd5a6358d147e5d49487a08 false
Check wo_trunc    2ed7077aa2a3b937dcbb18d5fc80797bc43f0337^1 false
Check reseed_warn 2f38bf22aee802509663609fa4ca84b8634e5574 true
Check reseed_warn e866693e0 true
Check reseed_warn d1f510dcbd4423914fe49966285c58fe7901efee false
Check reseed_warn 60b3f3185edd8dc6515c578e6321bf7a6f00fc2b false
Check codec_warn  2f38bf22aee802509663609fa4ca84b8634e5574 true
Check codec_warn  2f38bf22aee802509663609fa4ca84b8634e5574^1 false
Check codec_warn  origin/dev                               true
Check wolfssl_reseed_warn 29e90ea7816e582d84fd3928156b84b033808549 true
Check wolfssl_reseed_warn 29e90ea7816e582d84fd3928156b84b033808549^1 false
Check wolfssl_reseed_warn origin/dev                       true
Check codec_warn  origin/pr/quiet-eval-errors       false
Check wolfssl_reseed_warn origin/pr/quiet-eval-errors false
Check wolfssl_reseed_error 2a0619f4ad4324cd264c76ead7e5ca208212d8c1 true
Check wolfssl_reseed_error 1957fba63754933fa99a2ed26d2acee1d8cc9ab1 true
Check wolfssl_reseed_error a914ff56a8e11acb158b7ebaa1afc007d28a1d5d false
Check wolfssl_reseed_error 2a0619f4ad4324cd264c76ead7e5ca208212d8c1^1 false
Check openssl_descriptor_info 207ecfde6c81380b90b1c52e31c0aec547b896ae true
Check openssl_descriptor_info 2f38bf22aee802509663609fa4ca84b8634e5574 true
Check openssl_descriptor_info e13983d6a6e186cde04fffeb12914f06b4ff9b68 false
Check openssl_descriptor_info origin/dev false
Check wolfssl_descriptor_info 15e32f80427ed753744b36d5e3c588ad4a85ce72 true
Check wolfssl_descriptor_info 2f38bf22aee802509663609fa4ca84b8634e5574 true
Check wolfssl_descriptor_info e13983d6a6e186cde04fffeb12914f06b4ff9b68 false
Check boringssl_clear_info 8d799887b891b0fa7f8ae34f3b5152a4757bb4cb true
Check boringssl_clear_info 2f38bf22aee802509663609fa4ca84b8634e5574 true
Check boringssl_clear_info 8d799887b891b0fa7f8ae34f3b5152a4757bb4cb^1 false
Check toml_cli_locked c3a6d8a94af81ebd5f24d9420cb6c2cf17fb690b true
Check toml_cli_locked 1957fba63754933fa99a2ed26d2acee1d8cc9ab1 true
Check toml_cli_locked 5586c58b12a7bee021d3ae9df242df89ebefae0f false
Check toml_cli_locked c3a6d8a94af81ebd5f24d9420cb6c2cf17fb690b^1 false
Check stats_monitor_heartbeat 92251a29515c05733832c67fe637a7bd54b84055 true
Check stats_monitor_heartbeat dcf9ff4e7caffbd35d6b83cfef6bac5b7f7efdc3 true
Check stats_monitor_heartbeat 2f06dfef8b0a530e058d489ffee0179be10a3f7a false
Check stats_monitor_heartbeat 92251a29515c05733832c67fe637a7bd54b84055^1 false
Check stats_monitor_heartbeat origin/dev false
Check security_claim_objective 2dad52a3c64458f446f721ef83107fa89905b8dc true
Check security_claim_objective 2dad52a3c64458f446f721ef83107fa89905b8dc^1 false
Check security_claim_objective 0ac66344b28143c07a2813bb743d8d374bd3a169 false
Check security_claim_objective 0ac66344b28143c07a2813bb743d8d374bd3a169^1 true
Check security_claim_objective origin/dev false
Check reservoir_sample_warn ce5a15be7949c787001b657d5f891e00aa07dd5d true
Check reservoir_sample_warn ce5a15be7949c787001b657d5f891e00aa07dd5d^1 false
Check reservoir_sample_warn dcf9ff4e7caffbd35d6b83cfef6bac5b7f7efdc3 true
Check reservoir_sample_warn d4455dfc7ae00994971890594c85d8fbee01c109 false
Check reservoir_sample_warn 0cd3fed801fa4e3e7b7b22246e5b56b5dcfc91a9 false
# logged at ERROR on that side branch: not this rule
Check reservoir_sample_warn b27e21cb9 false
Check reservoir_sample_warn_dev 0cd3fed801fa4e3e7b7b22246e5b56b5dcfc91a9 true
Check reservoir_sample_warn_dev 0cd3fed801fa4e3e7b7b22246e5b56b5dcfc91a9^1 false
Check reservoir_sample_warn_dev origin/dev true
Check reservoir_sample_warn_dev dcf9ff4e7caffbd35d6b83cfef6bac5b7f7efdc3 false
Check subterm_size_warn ce5a15be7949c787001b657d5f891e00aa07dd5d true
Check subterm_size_warn ce5a15be7949c787001b657d5f891e00aa07dd5d^1 false
Check subterm_size_warn dcf9ff4e7caffbd35d6b83cfef6bac5b7f7efdc3 true
Check subterm_size_warn d4455dfc7ae00994971890594c85d8fbee01c109 false
Check subterm_size_warn origin/dev false

# the reference log config must be the pinned blob
blob=$( git -C "${COMPAT_REPO}" rev-parse "${COMPAT_LOG_CONFIG_REF}:client_log_config.yml" );
(( ++nbChecks ));
if [ "${blob}" != "${COMPAT_LOG_CONFIG_BLOB}" ]; then
  (( ++nbErrors ));
  echo "FAIL reference client_log_config.yml blob ${blob} != ${COMPAT_LOG_CONFIG_BLOB}";
fi

# probe == declared range on every first-parent commit
for commit in $( git -C "${COMPAT_REPO}" rev-list --first-parent "${REV_RANGE}" ); do
  for id in "${COMPAT_RULES[@]}"; do
    expected=false;
    CompatInDeclaredRange "${id}" "${commit}" && expected=true;
    Check "${id}" "${commit}" "${expected}";
  done
done

echo "${nbChecks} checks, ${nbErrors} failures";
(( nbErrors == 0 ))
