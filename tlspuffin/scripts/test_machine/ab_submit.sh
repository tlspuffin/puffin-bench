#!/bin/bash
#
# Paired A/B perf runs of one commit: A = compat rules applied, B = COMPAT_DISABLE=<rules>. Submits <pairs> pairs of
# tasks of one attempt per library, alternately A, B, A, B... (the scheduler runs equal-priority steps in submission
# order, so the two runs of a pair run at about the same time, under the same load). The tasks are stored under
# <package>/AB/<commit>/Perf/, which the dashboard does not index (it only reads PR/<commit>/Perf/).
# Task ids are appended to ~/ab-<commit>/tasks.txt ("A|B <pair> <task id>"); analyse with ab_report.py.
#
# Usage: bash ab_submit.sh <commit> [pairs (default 6)] [COMPAT_DISABLE of B (default all)]
#   PB_ROOT  install root (default /srv/puffin-bench), PB_API (default http://127.0.0.1:10082/api)

set -euo pipefail

COMMIT="${1:?Usage: $0 <commit> [pairs] [compat_disable]}"
PAIRS="${2:-6}"
DISABLE="${3:-all}"
PB_ROOT="${PB_ROOT:-/srv/puffin-bench}"
PB_API="${PB_API:-http://127.0.0.1:10082/api}"
JOBS="${PB_ROOT}/data/html/jobsscripts/tlspuffin"
OUT="${HOME}/ab-${COMMIT:0:9}"
mkdir -p "${OUT}"

# one attempt per library, stored outside the dashboard
jq '.flow[1][0].configuration.nb_retry = 1
    | .publish.storage = "${PACKAGE}/AB/${COMMIT_ID}/Perf/" | .publish.goal = "A/B ${COMMIT_ID}"
    | .name = "AB - ${COMMIT_ID}"' "${JOBS}/PR_perf_cargo.json" > "${OUT}/PR_perf_ab.json"

Submit() {  # Submit <group> <pair> [COMPAT_DISABLE]
  local extra=();
  [ -n "${3:-}" ] && extra=( -F "args[COMPAT_DISABLE]=$3" );
  local id;
  id=$( curl -s -X POST "${PB_API}/task/new" -F "config=@${OUT}/PR_perf_ab.json" -F "script=@${JOBS}/PR_perf_full.sh" \
      -F "files[]=@${JOBS}/shell.nix" -F "files[]=@${JOBS}/wolfssl_put.c.patch" -F "args[COMMIT_ID]=${COMMIT}" \
      -F "args[PACKAGE]=tlspuffin" "${extra[@]}" -F "user=${USER:-$( id -un )}" -F "job_type=perf" | jq -r '.task_id // empty' );
  [ -n "${id}" ] || { echo "submission of $1$2 failed" >&2; exit 1; };
  echo "$1 $2 ${id}" | tee -a "${OUT}/tasks.txt";
}

for (( p = 1; p <= PAIRS; p++ )); do
  Submit A "${p}";
  Submit B "${p}" "${DISABLE}";
done
echo "task ids in ${OUT}/tasks.txt; when done: python3 $( dirname "$0" )/ab_report.py ${OUT}/tasks.txt"
