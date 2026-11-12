#!/bin/bash
# asan_type_test.sh: AddressSanitizer's report type as the job scripts and the objectives tools read it (PR_common.sh
# AsanTypeAwk, FuzzerRecordsOf, ObjectiveSignature): the word after "AddressSanitizer:" (heap-buffer-overflow, SEGV),
# and for the reports that say what was attempted, the type of their SUMMARY line: a bad-free ("attempting free on
# address which was not malloc()-ed", CDOS) and a double-free, never "attempting", which no signature matches.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
source <( sed -n '/^AsanTypeAwk()/,/^}/p;/^FuzzerRecords()/,/^}/p;/^FuzzerRecordsOf()/,/^}/p;/^ObjectiveSignature()/,/^}/p' "${here}/../PR_common.sh" )
type_of() { awk "$( AsanTypeAwk )"' { print asantype($0) }' <<< "$1"; }
check 'bad-free' '[ "$( type_of "==1==ERROR: AddressSanitizer: attempting free on address which was not malloc()-ed: 0x1 in thread T0" )" == bad-free ]'
check 'double-free' '[ "$( type_of "==1==ERROR: AddressSanitizer: attempting double-free on 0x602 in thread T0:" )" == double-free ]'
check 'allocation-size-too-big' '[ "$( type_of "==1==ERROR: AddressSanitizer: requested allocation size 0xfffff (0x100000 after adjustments) exceeds maximum supported size of 0x10000000000 (thread T0)" )" == allocation-size-too-big ]'
check 'heap-buffer-overflow, SEGV: the word after AddressSanitizer' \
  '[ "$( type_of "==1==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x62" )" == heap-buffer-overflow ] && [ "$( type_of "==1==ERROR: AddressSanitizer: SEGV on unknown address 0x0" )" == SEGV ]'

# the fuzzer's records from the clients' stderr: a bad-free report, then a dated line
mkdir -p "${work}/log"
cat > "${work}/log/puffin_client_stderr.log" <<'EOF'
2026-11-10T18:22:35.900000000+01:00	INFO	client 1
==1676926==ERROR: AddressSanitizer: attempting free on address which was not malloc()-ed: 0x00000175b47c in thread T0
    #0 0x7ffff75088c8 in __interceptor_free.part.0 (/nix/store/x/libclang_rt.asan-x86_64.so+0x1088c8)
    #1 0xd0e1f4 in wolfSSL_Free memory.c
    #2 0xe1f4a1 in AddSessionToCache ssl.c
    #3 0xe1f4b2 in AddSession ssl.c
SUMMARY: AddressSanitizer: bad-free (/nix/store/x/libclang_rt.asan-x86_64.so+0x1088c8) in __interceptor_free.part.0
2026-11-10T18:22:36.000000000+01:00	INFO	client 1 restarted
EOF
records=$( FuzzerRecords "${work}/log" 2> /dev/null )
check 'the fuzzer record of a bad-free: its type and frames' \
  'awk -F"\t" "\$2 == \"asan\" && \$3 == \"bad-free\" && \$4 == \"wolfSSL_Free < AddSessionToCache < AddSession\"" <<< "${records}" | grep -q .'

# a replay's report: its signature
printf '%s\n' '==7==ERROR: AddressSanitizer: attempting double-free on 0x602000000010 in thread T0:' \
  '    #0 0x7ffff75088c8 in __interceptor_free (/x/libclang_rt.asan.so+0x1)' '    #1 0xd0e1f4 in FreeKeyExchange ssl.c' \
  '    #2 0xd0e1f5 in Caller ssl.c' '' 'SUMMARY: AddressSanitizer: double-free (/x/libclang_rt.asan.so+0x1) in __interceptor_free' > "${work}/report.txt"
sig=$( ObjectiveSignature < "${work}/report.txt" )
check "a replay's signature: double-free, never \"attempting\" ($( cut -c1-60 <<< "${sig}" | tr '\t' ' ' ))" \
  'grep -q "double-free" <<< "${sig}" && ! grep -q attempting <<< "${sig}"'
exit "${fail}"
