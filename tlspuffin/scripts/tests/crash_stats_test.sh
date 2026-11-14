#!/bin/bash
# crash_stats_test.sh: the client restarts and ASan reports a run records (PR_common.sh ExperimentCrashStats), from the
# broker's logs and tlspuffin.out, and from tlspuffin.log, where tlspuffin 1957fba (2024-09) writes its "Spawning next
# client" (else counted 0 there, whatever happened)
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
source <( sed -n '/^ExperimentCrashStats()/,/^}/p' "${here}/../PR_common.sh" )
cd "${work}"
# a run of today's tlspuffin: the broker's stdout
mkdir -p new/log && printf 'x\nSpawning next client (id 1)\nSpawning next client (id 2)\n==1==ERROR: AddressSanitizer: heap-buffer-overflow\n' > new/log/puffin_main_broker_stdout.log
stats=''; ExperimentCrashStats "${work}/new" stats
check 'the broker'"'"'s log: 2 restarts, 1 ASan report' '[ "$( jq -c "[.client_restarts, .asan_reports]" <<< "${stats}" )" == "[2,1]" ]'
# a run of tlspuffin 1957fba: one tlspuffin.log of every level in the experiment
mkdir -p old && printf 'Spawning next client (id 1)\nSpawning next client (id 1)\nSpawning next client (id 3)\nSpawning next client (id 0)\n==7==ERROR: AddressSanitizer: SEGV\n' > old/tlspuffin.log
stats=''; ExperimentCrashStats "${work}/old" stats
check 'tlspuffin 1957fba: its restarts in tlspuffin.log, 3 (the first client, id 0, is no restart)' '[ "$( jq -c "[.client_restarts, .asan_reports]" <<< "${stats}" )" == "[3,1]" ]'
exit "${fail}"
