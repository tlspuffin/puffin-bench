#!/bin/bash
# log_stats_test.sh: the log volume of a run (PR_common.sh ExperimentLogStats), its live files plus one roll size per
# rolled archive, from the files the clients share (rolled at 10 MB) and from the clients' own folders (tlspuffin's
# per-client logs, log/client-<id>/: each of the n clients rolls its files at 10 MB / n): the same logs, the same volume
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
source <( sed -n '/^LOG_ROLL_SIZE_BYTES=/p;/^ExperimentLogStats()/,/^}/p' "${here}/../PR_common.sh" )
cd "${work}"
kb=1024; mb=$(( 1024 * 1024 ))
# a run of 20 minutes on 4 cores
echo "$(( $( date +%s ) - 1200 )) 4" > .experiment_launch
# the files the clients share: 2 rolled archives of warn.log (10 MB each before compression) and 1 MB live
mkdir -p shared/log
head -c "${mb}" /dev/zero > shared/log/warn.log
for n in 1 2; do head -c "${kb}" /dev/zero | gzip > "shared/log/warn.${n}.gz"; done
stats=''; ExperimentLogStats "${work}/shared" stats
check 'shared files: 2 rolled archives of 10 MB and 1 MB live, ~21 MB' \
  '[ "$( jq -c "[.estimated_mb, .files, .rolled]" <<< "${stats}" )" == "[21,3,2]" ]'
# the same volume, each of the 4 clients in its own folder: 2 rolled archives of 2.5 MB and 256 KB live each
for c in 0 1 2 3; do
  mkdir -p "clients/log/client-${c}"
  head -c $(( 256 * kb )) /dev/zero > "clients/log/client-${c}/warn.log"
  for n in 1 2; do head -c "${kb}" /dev/zero | gzip > "clients/log/client-${c}/warn.${n}.gz"; done
done
stats=''; ExperimentLogStats "${work}/clients" stats
check 'per-client folders: their files counted, each archive at the roll size of one of 4 clients, ~21 MB' \
  '[ "$( jq -c "[.estimated_mb, .files, .rolled]" <<< "${stats}" )" == "[21,12,8]" ]'
check 'per-client folders: the same rate per hour and per core as the shared files' \
  '[ "$( jq -r .mb_per_core_hour <<< "${stats}" )" == "15.7" ]'
exit "${fail}"
