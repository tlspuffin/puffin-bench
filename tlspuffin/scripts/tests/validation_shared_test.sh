#!/bin/bash
# validation_shared_test.sh: the validation of a configuration prepared once for all its attempts (PR_validate.sh
# PrepareValidationOnce, a group of the Vuln flows run once per experiment, before its attempts), each attempt taking a
# copy (ValidationFromShared, from ValidationPrepare: its files and controls, its own runs/ and verdicts/, the checkout
# and binary shared), the shared checkout removed once at the end (ValidationCleanupShared, by CleanAllRepo). Before,
# every attempt prepared its own: the same builds made once per attempt, at the same time.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
source <( sed -n '/^ValidationState()/,/^}/p;/^ValidationCleanup()/,/^}/p;/^ValidationPrepare()/,/^}/p;/^SharedValidationDir()/p;/^PrepareValidationOnce()/,/^}/p;/^ValidationFromShared()/,/^}/p;/^ValidationCleanupShared()/,/^}/p' "${here}/../PR_validate.sh" )
export THEJOB_OUT_PATH="${work}/out" THEJOB_STEP_ID=CALLB vendor=wolfssl:wolfssl552-asan COMMIT_ID=main
# the task's repository (Init), with the checkout of the shared validation as one of its worktrees
mkdir -p "${THEJOB_OUT_PATH}/repo" && git -C "${THEJOB_OUT_PATH}/repo" init -q && git -C "${THEJOB_OUT_PATH}/repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
shared="${THEJOB_OUT_PATH}/validation-CALLB/validation"
mkdir -p "${shared}/runs" "${shared}/verdicts" "${work}/bin"
git -C "${THEJOB_OUT_PATH}/repo" worktree add -q --detach "${shared}/tree" HEAD
printf '#!/bin/sh\nexit 0\n' > "${work}/bin/tlspuffin"; chmod +x "${work}/bin/tlspuffin"
jq -n --arg binary "${work}/bin/tlspuffin" --arg tree "${shared}/tree" '{ status: "ready", message: "", binary: $binary, tree: $tree, cached: false, controls: [{ entry: "CVE-2023-6936", ok: true }] }' > "${shared}/state.json"
echo '{"entries":[]}' > "${shared}/list.json"; echo '{"entries":[]}' > "${shared}/list-build.json"
touch "${shared}/runs/control-CVE-2023-6936-wolfssl552-asan-only-CVE-2023-6936.json" "${shared}/runs/stack-CVE-2024-5814-wolfssl552-asan-fix-all.json" \
      "${shared}/runs/objective-of-another-attempt.json" "${shared}/verdicts/of-another-attempt.json"
# an attempt: its validation, a copy (no checkout of its own, no build)
git() { echo "git $*" >> "${work}/git.calls"; command git "$@"; }
mkdir -p "${work}/attempt0" && cd "${work}/attempt0"
rc=0; ValidationPrepare || rc=$?
check 'an attempt: the validation of its configuration, copied (state, listings), no checkout or build of its own' \
  '[ "${rc}" -eq 0 ] && cmp -s "${shared}/state.json" validation/state.json && [ -s validation/list.json ] && [ -s validation/list-build.json ] && [ ! -e validation/tree ] && [ ! -s "${work}/git.calls" ]'
check 'its controls copied, its own runs/ and verdicts/ (not those of another attempt)' \
  '[ "$( ls validation/runs | sort | tr "\n" " " )" == "control-CVE-2023-6936-wolfssl552-asan-only-CVE-2023-6936.json stack-CVE-2024-5814-wolfssl552-asan-fix-all.json " ] && [ -z "$( ls validation/verdicts )" ]'
# its cleanup at the end of the attempt (ValidateObjectives): the shared checkout stays (the job scripts run without
# set -e: a status of git inside does not stop them)
ValidationCleanup || true
check 'the cleanup of an attempt leaves the shared checkout' '[ -d "${shared}/tree" ]'
# a shared validation whose binary is gone: not taken (the attempt prepares its own)
cd "${work}" && mkdir -p attempt1 && cd attempt1
command mv -f "${work}/bin/tlspuffin" "${work}/bin/gone"
rc=0; ValidationFromShared || rc=$?
check 'a shared validation without its binary: not copied' '[ "${rc}" -eq 1 ] && [ ! -e validation ]'
command mv -f "${work}/bin/gone" "${work}/bin/tlspuffin"
# PrepareValidationOnce: prepared in the configuration's folder
cd "${work}" && mkdir -p once && cd once
rm -rf "${THEJOB_OUT_PATH}/validation-BUF"
( THEJOB_STEP_ID=BUF; ValidationPrepare() { mkdir -p validation && jq -n --arg d "${PWD}" '{ status: "unsupported", message: $d }' > validation/state.json; }; PrepareValidationOnce ) > "${work}/once.log" 2>&1 || true
check 'PrepareValidationOnce: the validation prepared in <out>/validation-<configuration>' \
  '[ "$( jq -r .message "${THEJOB_OUT_PATH}/validation-BUF/validation/state.json" 2> /dev/null )" == "${THEJOB_OUT_PATH}/validation-BUF" ] && grep -q "for all its attempts: unsupported" "${work}/once.log"'
# a flow without PrepareValidationOnce (campaigns): the first attempt that needs a validation prepares it for all (in the
# configuration's folder, under its lock), the next one takes a copy: one checkout (here refused: an unknown commit)
: > "${work}/git.calls"
cd "${work}" && mkdir -p campA campB
( cd campA && THEJOB_STEP_ID=CAMP COMMIT_ID=0123456789abcdef0123456789abcdef01234567 ValidationPrepare ) > /dev/null 2>&1 || true
( cd campB && THEJOB_STEP_ID=CAMP COMMIT_ID=0123456789abcdef0123456789abcdef01234567 ValidationPrepare ) > /dev/null 2>&1 || true
check 'a campaign: prepared once for its attempts, on demand (one checkout), each attempt a copy' \
  '[ "$( grep -c "worktree add" "${work}/git.calls" )" -eq 1 ] && [ "$( jq -r .status "${THEJOB_OUT_PATH}/validation-CAMP/validation/state.json" )" == unsupported ] && cmp -s campA/validation/state.json campB/validation/state.json && cmp -s campA/validation/state.json "${THEJOB_OUT_PATH}/validation-CAMP/validation/state.json"'
# the end of the task: the shared checkout goes
unset -f git
ValidationCleanupShared || true
check 'at the end of the task (CleanAllRepo): the shared checkout removed' \
  '[ ! -d "${shared}/tree" ] && ! command git -C "${THEJOB_OUT_PATH}/repo" worktree list | grep -q "${shared}/tree"'
# the flows: one group per experiment before its attempts
jobs="${here}/../../data/html/jobsscripts/tlspuffin"
for f in PR_vulnerabilities-groupA_cargo.json PR_vulnerabilities-groupB_cargo.json PR_vulnerabilities-custom_cargo.json; do
  shape=$( sed -e 's/\${RUNTIME_RUN_CONFIG}/{}/; s/\${RUNTIME_NB_CORES}/2/; s/\${RUNTIME_NB_RUN}/5/' "${jobs}/${f}" |
    jq -c '[.flow[] | select(type == "array") | [.[0].configuration.nb_retry, ([.[] | .step? // empty] | index("PrepareValidationOnce") != null), ([.[] | .step? // empty] | index("ExperimentWithCargo") != null)]]' )
  check "${f}: the validation prepared once per experiment, then its attempts" '[[ "${shape}" == "[[1,true,false],["*",false,true]]" ]]'
done
exit "${fail}"
