#!/bin/bash
# fuzzer_records_awk_test.sh: the job scripts read the fuzzer's records with any awk (PR_common.sh FuzzerRecordsOf,
# FuzzerVerdicts, FuzzerExcerpt): gawk, mawk, and the awk first in PATH (pesto's mawk 1.3.4 20200120 under its shim),
# under the services' locale (fr_FR.UTF-8), gawk itself unavailable. Gawk-only constructs (mktime(…, 1), interval
# patterns {4}) make those programs fail under mawk: no objective would have a record, and nothing would say why.
# What they record: a crash, a timeout ("Timeout in fuzz run."), a claim (a message of tlspuffin's security policies
# only: a bit-level mutation that failed, "mutation::MakeMessage failed …", is no claim, campaigns of 2026-11-16), an
# ASan report, a restart of a client by the broker (a timeout whose line the clients' logs lost; a crash when an ASan
# report dates from it).
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; return 1; fi; }
# what was expected and what came, for a failed check (never fails itself)
differs() { diff <( echo "$1" ) <( echo "$2" ) | sed 's/^/     /' || true; }
# the functions that read the fuzzer's logs, as objectives_report.sh takes them
source <( sed -n '/^AsanTypeAwk()/,/^}/p;/^FuzzerRecords()/,/^}/p;/^FuzzerRecordsOf()/,/^}/p;/^FuzzerVerdict()/,/^}/p;/^FuzzerVerdicts()/,/^}/p;/^FuzzerExcerpt()/,/^}/p' "${here}/../PR_common.sh" )

# the logs of a run, as the fuzzer writes them: a crash with its sections (error.log: the backtrace in the third), a
# claim (warn.log), a timeout (both), warnings that are no claim, ASan reports and restarts of clients (the broker's stderr)
mkdir -p "${work}/log"
bar='━━━━━━━━━━━━━━━━━━━━'
printf '%s\n' $'2026-11-11T01:00:00.002000000+01:00\tERROR\tCrashed with SIGABRT' \
  $'2026-11-11T01:00:00.002500000+01:00\tERROR\tinput: "20261111-000000003-aaaa.trace"' \
  "${bar} CRASH ${bar}" 'Received signal SIGABRT at 0x007ffff7d64ddc, fault address: 0x00000000000000' \
  "${bar} REGISTERS ${bar}" 'r8 : 0x000000ffffffff, r9 : 0x00000000000000,' \
  "${bar} BACKTRACE ${bar}" '   0: libafl_bolts::minibsod::generate_minibsod' '   1: __pthread_kill_implementation' \
  '   2: AddPacketInfo' '   3: DoTls13HandShakeMsgType' '   4: DoTls13HandShakeMsg' \
  $'2026-11-11T01:00:05.000000000+01:00\tINFO\tnext' $'2026-11-11T01:00:20.000000000+01:00\tERROR\tTimeout in fuzz run.' > "${work}/log/error.log"
printf '%s\n' $'2026-11-11T01:00:09.000000000+01:00\tWARN\tAuthentication bypass' $'2026-11-11T01:00:20.000000000+01:00\tERROR\tTimeout in fuzz run.' \
  $'2026-11-11T01:00:30.000000000+01:00\tWARN\tmutation::MakeMessage failed (with_focus: false) due to error in PUT : Out of order message, fatal' \
  $'2026-11-11T01:00:31.000000000+01:00\tWARN\t       Skipped ReadMessage as we failed to choose a term with payload in the trace.' > "${work}/log/warn.log"
printf '%s\n' '==7==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x602 at pc 0x55 bp 0x7f sp 0x7e' \
  '    #0 0x55 in AddPacketInfo /src/internal.c:1' '    #1 0x56 in DoTls13HandShakeMsgType /src/tls13.c:2' \
  '    #2 0x57 in DoTls13HandShakeMsg /src/tls13.c:3' 'SUMMARY: AddressSanitizer: heap-buffer-overflow /src/internal.c:1 in AddPacketInfo' \
  '2026-11-11T01:00:00.004000000+01:00 [INFO] restart' $'2026-11-11T01:00:41+01:00\tSpawning next client (id 1)' \
  '==9==ERROR: AddressSanitizer: SEGV on unknown address 0x000000000000 (pc 0x60 bp 0x1 sp 0x2 T0)' '    #0 0x60 in DoHandShakeMsgType /src/internal.c:9' \
  'SUMMARY: AddressSanitizer: SEGV /src/internal.c:9 in DoHandShakeMsgType' $'2026-11-11T01:00:51+01:00\tSpawning next client (id 2)' > "${work}/log/puffin_main_broker_stderr.log"
ms() { date -u -d "$1" +%s%3N; }
crash_ms=$( ms 2026-11-11T00:00:00.002Z ); claim_ms=$( ms 2026-11-11T00:00:09.000Z ); asan_ms=$( ms 2026-11-11T00:00:00.004Z )
timeout_ms=$( ms 2026-11-11T00:00:20.000Z ); restart1_ms=$( ms 2026-11-11T00:00:41Z ); restart2_ms=$( ms 2026-11-11T00:00:51Z )
frames='AddPacketInfo < DoTls13HandShakeMsgType < DoTls13HandShakeMsg'
expected_records=$( printf '%s\n' "${crash_ms}"$'\tcrash\tSIGABRT\t'"${frames}" "${claim_ms}"$'\twarn\tAuthentication bypass\t' \
  "${timeout_ms}"$'\ttimeout\tTimeout in fuzz run.\t' "${asan_ms}"$'\tasan\theap-buffer-overflow\t'"${frames}" \
  "${restart1_ms}"$'\trestart\tSpawning next client (id 1)\t' "${restart2_ms}"$'\tasan\tSEGV\tDoHandShakeMsgType' \
  "${restart2_ms}"$'\trestart\tSpawning next client (id 2)\t' )
# a crash, a claim, a timeout 40 ms after its line, an objective 29 ms after a bit-level warning (no record), one
# without line the broker restarted the client of (a timeout), one whose crash line is lost but not its ASan report
names=( 20261111-000000003-aaaa 20261111-000009100-bbbb 20261111-000020040-cccc 20261111-000030029-dddd 20261111-000040230-eeee 20261111-000050600-ffff )
expected_verdicts=$( printf '%s\n' $'20261111-000000003-aaaa\tcrash\tSIGABRT · ASan heap-buffer-overflow\t'"${frames}" \
  $'20261111-000009100-bbbb\tclaim\tAuthentication bypass\t' $'20261111-000020040-cccc\ttimeout\tTimeout in fuzz run.\t' \
  $'20261111-000030029-dddd\t\t\t' $'20261111-000040230-eeee\ttimeout\tno line logged, the client restarted\t' \
  $'20261111-000050600-ffff\tcrash\tASan SEGV\tDoHandShakeMsgType' )
expected_one=$( sed 's/\t*$//' <<< "${expected_verdicts}" )

# each awk of the machine, gawk made unavailable (as on pesto): its own folder first in PATH
awks=()
first=$( command -v awk ); awks+=( "awk first in PATH|${first}" )
for a in /usr/bin/gawk /usr/bin/mawk /usr/bin/original-awk /usr/bin/busybox; do
  [ -x "${a}" ] || continue
  case "${a}" in */busybox) "${a}" awk 'BEGIN { exit }' 2> /dev/null || continue;; esac
  awks+=( "${a##*/}|${a}" )
done
for entry in "${awks[@]}"; do
  label="${entry%%|*}"; bin="${entry#*|}"
  "${bin}" 'BEGIN { exit }' < /dev/null 2> /dev/null || [[ "${bin}" == */busybox ]] || { echo "SKIP ${label}: ${bin} does not run"; continue; }
  dir="${work}/path-${label// /_}"; mkdir -p "${dir}"
  if [[ "${bin}" == */busybox ]]; then printf '#!/bin/sh\nexec %s awk "$@"\n' "${bin}" > "${dir}/awk"; chmod +x "${dir}/awk"; else ln -sf "${bin}" "${dir}/awk"; fi
  printf '#!/bin/sh\necho "gawk: command not found" >&2\nexit 127\n' > "${dir}/gawk"; chmod +x "${dir}/gawk"
  version=$( "${dir}/awk" -W version 2> /dev/null | head -1 || true ); [ -n "${version}" ] || version=$( "${dir}/awk" --version 2> /dev/null | head -1 || true )
  records=$( LANG=fr_FR.UTF-8 PATH="${dir}:${PATH}" FuzzerRecords "${work}/log" 2> "${work}/err" | cut -f1-4 ) || true
  check "${label} (${version:-?}): the records of a crash, a claim, a timeout, ASan reports and restarts, no bit-level warning" '[ "${records}" == "${expected_records}" ]' ||
    { differs "${expected_records}" "${records}"; sed 's/^/     /' "${work}/err" | head -5 || true; }
  all_records=$( LANG=fr_FR.UTF-8 PATH="${dir}:${PATH}" FuzzerRecords "${work}/log" 2> /dev/null ) || true
  verdicts=$( printf '%s\n' "${names[@]}" | LANG=fr_FR.UTF-8 PATH="${dir}:${PATH}" FuzzerVerdicts "${all_records}" 2> /dev/null | cut -f1-4 ) || true
  check "${label}: each objective given its record" '[ "${verdicts}" == "${expected_verdicts}" ]' ||
    differs "${expected_verdicts}" "${verdicts}"
  # the same, objective by objective (FuzzerVerdict: the live pages, the Vuln jobs)
  one=$( for n in "${names[@]}"; do printf '%s\t%s\n' "${n}" "$( LANG=fr_FR.UTF-8 PATH="${dir}:${PATH}" FuzzerVerdict "${all_records}" "${n}" 2> /dev/null | cut -f1-3 )"; done | sed 's/\t*$//' ) || true
  check "${label}: the same objective by objective (FuzzerVerdict)" '[ "${one}" == "${expected_one}" ]' || differs "${expected_one}" "${one}"
  excerpt=$( LANG=fr_FR.UTF-8 PATH="${dir}:${PATH}" FuzzerExcerpt "${work}/log" 2026-11-11T01:00:00.002000000+01:00 crash 2> /dev/null ) || true
  check "${label}: the excerpt of the crash, its CRASH and BACKTRACE sections, not its registers" \
    '[ "$( head -1 <<< "${excerpt}" | cut -f3 )" == "Crashed with SIGABRT" ] && grep -q "4: DoTls13HandShakeMsg" <<< "${excerpt}" && grep -q "Received signal SIGABRT" <<< "${excerpt}" && ! grep -q "r8 :" <<< "${excerpt}"' || true
  excerpt=$( LANG=fr_FR.UTF-8 PATH="${dir}:${PATH}" FuzzerExcerpt "${work}/log" 2026-11-11T01:00:20.000000000+01:00 timeout 2> /dev/null ) || true
  check "${label}: the excerpt of a timeout, its line" '[ "$( cut -f3 <<< "${excerpt}" )" == "Timeout in fuzz run." ]' || true
  excerpt=$( LANG=fr_FR.UTF-8 PATH="${dir}:${PATH}" FuzzerExcerpt "${work}/log" 2026-11-11T01:00:41+01:00 timeout 2> /dev/null ) || true
  check "${label}: the excerpt of a timeout known by its restart, the broker's line" '[ "$( cut -f2 <<< "${excerpt}" )" == "Spawning next client (id 1)" ]' || true
done
exit "${fail}"
