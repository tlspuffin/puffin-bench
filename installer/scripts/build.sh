#!/bin/bash


cd "$( dirname $( realpath "${BASH_SOURCE[0]}" ) )"

cat PR_common.sh PR_perf.sh > PR_perf_full.sh
cat PR_common.sh PR_vulnerabilities.sh > PR_vulnerabilities_full.sh

echo "All done in $( pwd )"

