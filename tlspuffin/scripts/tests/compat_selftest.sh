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
