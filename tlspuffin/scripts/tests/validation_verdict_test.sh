#!/bin/bash
# validation_verdict_test.sh: the verdict of one objective (ValidationVerdict, PR_validate.sh) on a stand-in tlspuffin
# whose outcome depends on the build (--put) and the trace, with a validation set F (every patch) and V_X for two
# candidates, X1 (a claim) and X2 (a crash with ASan heap-buffer-overflow), and one known bug without patch, U (a crash
# with ASan SEGV):
#   - an objective on F: not-patched, U named when its oracle matches (a SIGSEGV of ASan SEGV), none otherwise; the
#     claim of X1, patched there, recorded (signature_of_patched: to review); X2's crash type is too weak to be;
#   - an objective on V_X1 with X1's claim: confirmed X1; on V_X2 with another crash: other-signature X2;
#   - nothing anywhere: inconclusive; an error of the PUT (tlspuffin's "error" outcome) is a replay result, inconclusive;
#   - an execution that could not run (no outcome: the binary refused its command line, timed out) is "failed", never
#     "no objective": on F, verdict error (V_X not run); on a V_X only, error (unless another V_X confirmed it); the
#     failure says what failed, from the log; a failed execution is not retried;
#   - ConfirmObjective: 0 confirmed, 1 another bug, 2 (undecided) for an error and for a target that does not replay
#     (replayable false: CDOS; beware of jq's false // true, which is true).
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
# shellcheck source=../PR_validate.sh
source "${here}/../PR_validate.sh"
cd "${work}"
mkdir -p validation/runs validation/verdicts
# the stand-in: --put <build> execute --outcome <file> <trace>; counts its executions
cat > fake-tlspuffin <<'EOF'
#!/bin/bash
put=; out=; trace=
while (( $# )); do
  case "$1" in --put) put=$2; shift 2;; --outcome) out=$2; trace=$3; shift 3;; *) shift;; esac
done
echo x >> "${COUNT}"
name=$( basename "${trace}" .trace )
case "${name}|${put}" in
  usage\|*) echo "2026-11-11T18:00:00+01:00	error: unrecognized subcommand ''--put-use-clear''" >&2; exit 2;;
  hang\|*) sleep 5; exit 0;;
  vfail\|p-only-X2|vfail1\|p-only-X2) echo "error while loading shared libraries: libwolfssl.so: cannot open shared object file: No such file or directory" >&2; exit 127;;
  segv\|p-fix-all) o='{"outcome":"crash","signal":"SIGSEGV","asan":{"type":"SEGV"}}';;
  newcrash\|p-fix-all) o='{"outcome":"crash","asan":{"type":"heap-use-after-free"}}';;
  claimf\|p-fix-all) o='{"outcome":"claim","violation":"Authentication bypass"}';;
  heapf\|p-fix-all) o='{"outcome":"crash","asan":{"type":"heap-buffer-overflow"}}';;
  claim\|p-only-X1|vfail\|p-only-X1) o='{"outcome":"claim","violation":"Authentication bypass"}';;
  other\|p-only-X2) o='{"outcome":"crash","asan":{"type":"stack-buffer-overflow"}}';;
  puterr\|*) o='{"outcome":"error","message":"error in PUT : Out of order message, fatal"}';;
  *) o='{"outcome":"none"}';;
esac
printf '[{"trace":"%s","outcome":%s}]\n' "${trace}" "${o}" > "${out}"
EOF
chmod +x fake-tlspuffin
export COUNT="${work}/count"
jq -n '{ status: "ready", binary: "'"${work}"'/fake-tlspuffin", tree: "'"${work}"'/tree", fixAll: "p-fix-all", preset: "p",
         candidates: [{ id: "X1", oracle: { kind: "claim", violation: "Authentication bypass" } },
                      { id: "X2", oracle: { kind: "crash", asan: "heap-buffer-overflow" } }],
         unpatched: [{ id: "U", oracle: { kind: "crash", asan: "SEGV" } }],
         entries: [{ id: "X1", replayable: true }, { id: "X2", replayable: true }, { id: "U", replayable: true }, { id: "R", replayable: false }] }' > validation/state.json
ValidationEnv
VALIDATION_TIMEOUT=1
verdict() { : > "${COUNT}"; touch "$1.trace"; ValidationVerdict "${work}/$1.trace" > "${work}/$1.verdict"; jq -r "$2" "${work}/$1.verdict"; }
check 'an objective on F with ASan SEGV: not-patched, U named' '[ "$( verdict segv ".verdict + \" \" + (.known_unpatched | join(\",\"))" )" == "not-patched U" ]'
check 'an objective on F, no known signature: not-patched, none named' '[ "$( verdict newcrash ".verdict + \" \" + (.known_unpatched | join(\",\"))" )" == "not-patched " ]'
check 'the claim of X1 (patched here) on F: not-patched, X1 recorded as a signature its patch does not remove' \
  '[ "$( verdict claimf ".verdict + \" \" + (.signature_of_patched | join(\",\"))" )" == "not-patched X1" ]'
check 'the ASan type of X2 (a crash oracle, too weak) on F: not-patched, nothing recorded' \
  '[ "$( verdict heapf ".verdict + \" \" + (.signature_of_patched | join(\",\")) + (.known_unpatched | join(\",\"))" )" == "not-patched " ]'
check 'the claim of X1 on V_X1: confirmed X1' '[ "$( verdict claim ".verdict + \" \" + (.entries | join(\",\"))" )" == "confirmed X1" ]'
check 'another crash on V_X2: other-signature X2' '[ "$( verdict other ".verdict + \" \" + (.other_signature | join(\",\"))" )" == "other-signature X2" ]'
check 'nothing anywhere: inconclusive, 3 executions per build' '[ "$( verdict nothing .verdict )" == inconclusive ] && [ "$( wc -l < "${COUNT}" )" == 9 ]'
check "an error of the PUT is a replay result: inconclusive" '[ "$( verdict puterr .verdict )" == inconclusive ]'
check 'F could not run it: error, on F, with the first error line of the log, V_X not run, not retried' \
  '[ "$( verdict usage ".verdict + \"|\" + .failure.build + \"|\" + .failure.message" )" == "error|F|no outcome, exit status 2: error: unrecognized subcommand '"''--put-use-clear''"'" ] && [ "$( wc -l < "${COUNT}" )" == 1 ] && [ "$( jq -r ".v // \"none\"" usage.verdict )" == none ]'
check 'a timeout: error, timed out' '[ "$( verdict hang ".verdict + \"|\" + .failure.message" )" == "error|no outcome, timed out after 1 s" ]'
check 'V_X2 could not run it but V_X1 confirms it: confirmed X1' '[ "$( verdict vfail ".verdict + \" \" + (.entries | join(\",\"))" )" == "confirmed X1" ]'
# only V_X2 can tell, and it could not run
check 'a V_X could not run it, no other verdict: error on that build' \
  '[ "$( verdict vfail1 ".verdict + \"|\" + .failure.build + \"|\" + (.failure.message | test(\"exit status 127: error while loading shared libraries\") | tostring)" )" == "error|X2|true" ]'
# in-run confirmation (target X1): confirmed, another bug, undecided on an error
check 'ConfirmObjective: 0 for X1 confirmed' '( target_bug=X1; rm -f validation/verdicts/claim.json; ConfirmObjective "${work}/claim.trace" > /dev/null ); [ $? == 0 ]'
check 'ConfirmObjective: 1 for another bug' 'rc=0; ( target_bug=X1; ConfirmObjective "${work}/other.trace" > /dev/null ) || rc=$?; [ "${rc}" == 1 ]'
check 'ConfirmObjective: 2 (undecided, the fuzzer record) for a target whose objectives do not replay (jq: false // true is true)' \
  'rc=0; ( target_bug=R; ConfirmObjective "${work}/nothing.trace" > "${work}/why" ) || rc=$?; [ "${rc}" == 2 ] && grep -q "do not replay" "${work}/why"'
check 'ConfirmObjective: 2 (undecided, the fuzzer record) for replays that could not run' \
  'rc=0; ( target_bug=X1; ConfirmObjective "${work}/usage.trace" > "${work}/why" ) || rc=$?; [ "${rc}" == 2 ] && grep -q "could not run" "${work}/why"'
exit "${fail}"
