#!/bin/bash
# replay_timeout_test.sh: a timeout of the fuzzer is a bug only when its replay runs past the time the fuzzer gives an
# execution (the user's rule, 2026-11-17); otherwise a timeout under the load of fuzzing. The pieces of PR_common.sh
# that decide it: FuzzerTimeoutMs (that time, from the commit's sources), ReplayStamp and ReplayTimed (how long a
# replay ran, in its report), ReplayMsOf (both, for the pages), ObjectiveSignature (type "timeout" past that time).
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
source <( sed -n '/^AsanTypeAwk()/,/^}/p;/^ObjectiveSignature()/,/^}/p;/^FuzzerTimeoutMs()/,/^}/p;/^ReplayStamp()/,/^}/p;/^ReplayTimed()/,/^}/p;/^ReplayMsOf()/,/^}/p' "${here}/../PR_common.sh" )

# the fuzzer's timeout, as the commits write it: InProcessExecutor::with_timeout (2024 on), TimeoutExecutor before
mkdir -p "${work}/new/puffin/src/fuzzer" "${work}/old/puffin/src/fuzzer" "${work}/none"
cat > "${work}/new/puffin/src/fuzzer/libafl_setup.rs" <<'EOF'
        let mut executor = InProcessExecutor::with_timeout(
            self.harness_fn,
            self.observers.unwrap(),
            &mut fuzzer,
            &mut state,
            &mut self.event_manager,
            Duration::new(5, 0),
        )?;
EOF
cat > "${work}/old/puffin/src/fuzzer/libafl_setup.rs" <<'EOF'
    let mut executor = TimeoutExecutor::new(
        InProcessExecutor::new(&mut harness, observers, &mut fuzzer, &mut state, &mut mgr)?,
        Duration::from_millis(2500),
    );
EOF
check 'the fuzzer timeout of a commit: with_timeout(…, Duration::new(5, 0)) is 5000 ms' '[ "$( FuzzerTimeoutMs "${work}/new" )" == 5000 ]'
check 'and TimeoutExecutor::new(…, Duration::from_millis(2500)) of older commits 2500 ms' '[ "$( FuzzerTimeoutMs "${work}/old/" )" == 2500 ]'
check 'nothing when the sources do not say' '[ -z "$( FuzzerTimeoutMs "${work}/none" )" ]'

# a replay command writes its start (ReplayStamp, run by the replay's own shell), ReplayTimed adds how long it ran
bash -c "$( ReplayStamp ) sleep 0.3; echo 'error in PUT : decryption failed'" > "${work}/report" 2>&1
echo 'exit status: 0' >> "${work}/report"
ReplayTimed "${work}/report" 5000
ran=$( sed -n 's/^replay time: \([0-9]*\) ms$/\1/p' "${work}/report" )
check 'the time a replay ran, from the start its command wrote' '[ -n "${ran}" ] && (( ran >= 300 && ran < 5000 ))'
check 'and the fuzzer timeout beside it' 'grep -qx "fuzzer timeout: 5000 ms" "${work}/report"'
check 'both for the pages (ReplayMsOf)' '[ "$( ReplayMsOf "${work}/report" )" == "${ran}"$'"'"'\t5000'"'"' ]'
printf 'error in PUT : decryption failed\nexit status: 0\n' > "${work}/untimed"
ReplayTimed "${work}/untimed" 5000
check 'a report without the start of its replay (older job scripts): nothing added' '! grep -q "^replay time" "${work}/untimed" && [ "$( ReplayMsOf "${work}/untimed" )" == $'"'"'\t'"'"' ]'

# the signature of a replay: past the fuzzer timeout, the timeout reproduced; under it, what the replay did
sig() { printf '%b' "$1" | LANG=fr_FR.UTF-8 ObjectiveSignature; }
check 'a replay past the fuzzer timeout: a timeout, reproduced (the seconds with a point under any locale)' \
  '[ "$( sig "error in PUT : decryption failed\nexit status: 0\nreplay time: 7210 ms\nfuzzer timeout: 5000 ms\n" )" == $'"'"'timeout\t\treplay ran 7.2 s, past the fuzzer timeout (5.0 s)\t0'"'"' ]'
check 'under it: not reproduced, the error that stopped it' \
  '[ "$( sig "error in PUT : decryption failed\nexit status: 0\nreplay time: 2400 ms\nfuzzer timeout: 5000 ms\n" | cut -f1,2 )" == $'"'"'no-crash\terror in PUT : decryption failed'"'"' ]'
check 'killed by the time limit of the replay itself, past the fuzzer timeout: a timeout' \
  '[ "$( sig "exit status: 124\nreplay time: 60012 ms\nfuzzer timeout: 5000 ms\n" | cut -f1 )" == timeout ]'
check 'killed, the fuzzer timeout unknown (older reports): a replay error, as before' \
  '[ "$( sig "exit status: 124\n" | cut -f1 )" == replay-error ]'
check 'a crash past the fuzzer timeout stays the crash' \
  '[ "$( sig "==1==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x1\n    #0 0x10 in AddPacketInfo /src/internal.c:1\n\nexit status: 1\nreplay time: 9000 ms\nfuzzer timeout: 5000 ms\n" | cut -f1,2 )" == $'"'"'heap-buffer-overflow\tAddPacketInfo'"'"' ]'
check 'a replay that could not run, whatever its time, a replay error' \
  '[ "$( sig "binary not found: /x/tlspuffin\nexit status: 1\nreplay time: 6000 ms\nfuzzer timeout: 5000 ms\n" | cut -f1 )" == replay-error ]'

# the live replay (objectives_live.sh Replay) of a run's binary (here a fake one, run directly: no shell.nix): its report
# says how long it ran and the fuzzer's timeout, and a replay slower than that timeout is a timeout reproduced
source <( sed -n '/^BudgetLeft()/p;/^Symbolizer()/,/^}/p;/^Replay()/,/^}/p' "${here}/../tools/objectives_live.sh" )
BUDGET=240 REPLAY_TIMEOUT=60 start=$( date +%s )
mkdir -p "${work}/run"
printf '#!/bin/bash\nsleep "${FAKE_SLEEP:-0}"\necho "error in PUT : decryption failed" >&2\nexit 0\n' > "${work}/run/fake"; chmod +x "${work}/run/fake"
printf 'LAUNCH_BINARY=%q\nLAUNCH_SHA256=\nLAUNCH_PREFIX=\nLAUNCH_NOASLR=\nLAUNCH_FLAGS=\nLAUNCH_ASAN_SET=false\nLAUNCH_ASAN_OPTIONS=\n' "${work}/run/fake" > "${work}/run/.currentlaunch"
: > "${work}/t.trace"
FAKE_SLEEP=0 Replay "${work}/run" "${work}/t.trace" "${work}/fast.txt" 1000 || true
check 'a live replay under the fuzzer timeout: its time and that timeout in its report, not reproduced' \
  'grep -q "^replay time: [0-9]* ms$" "${work}/fast.txt" && grep -qx "fuzzer timeout: 1000 ms" "${work}/fast.txt" &&
   [ "$( ObjectiveSignature < "${work}/fast.txt" | cut -f1 )" == no-crash ]'
FAKE_SLEEP=1.3 Replay "${work}/run" "${work}/t.trace" "${work}/slow.txt" 1000 || true
check 'one slower than the fuzzer timeout: a timeout reproduced' '[ "$( ObjectiveSignature < "${work}/slow.txt" | cut -f1 )" == timeout ]'
exit "${fail}"
