#!/bin/bash
#
# Submit dummy tasks to the scheduler, to look at the board: their steps only sleep (no CPU), with the
# structure of the tlspuffin jobs (init, a build and an experiment per library with several attempts,
# summary) and real tlspuffin commits, one of each kind for the commit line: a PR merged on dev, the tip
# of an open PR, an intermediate commit of a PR, a dev commit without PR, plus a custom task name.
#
# Each experiment attempt takes DUMMY_CORES cores (default 4: 3 libraries x 3 attempts x 4 = 36 cores),
# so the tasks run one after the other: the board shows one running task, the next one waiting for cores
# and the others scheduled. The tasks are not published (no results on the dashboard); their job type is
# "dummy" (history), so their step durations do not mix with the real ones in the estimated times.
#
# Usage: bash dummy_tasks.sh
#   SCHEDULER    scheduler URL                     (default http://localhost:10082)
#   DUMMY_CORES  cores of an experiment attempt    (default 4)
#   DUMMY_USER   user of the tasks                 (default dummy)

set -euo pipefail

SCHEDULER="${SCHEDULER:-http://localhost:10082}"
DUMMY_CORES="${DUMMY_CORES:-4}"
DUMMY_USER="${DUMMY_USER:-dummy}"

work="$( mktemp -d )"
trap 'rm -r -- "${work}"' EXIT

cat > "${work}/dummy.sh" <<'EOS'
DummyInit() { sleep 5; }
DummyBuild() { sleep 60; }
DummyExperiment() { sleep "${SLEEP:-60}"; }
DummySummary() { sleep 5; }
EOS

# Flow of one task: DUMMY_SLEEP is the duration of an experiment attempt, in seconds
Flow() {
  cat <<EOF
{
  "name": "dummy",
  "flow": [
    { "step": "DummyInit", "configuration": { "nb_cores": 1 } },
    { "step": "DummyBuild", "run": [ {"BoringSSL": {}}, {"OpenSSL": {}}, {"WolfSSL": {}} ],
      "configuration": { "nb_cores": 2 } },
    { "step": "DummyExperiment", "run": [ {"BoringSSL": {}}, {"OpenSSL": {}}, {"WolfSSL": {}} ],
      "configuration": { "nb_cores": ${DUMMY_CORES}, "nb_retry": 3, "timeout": "30m",
                         "args": { "SLEEP": "${1}" } } },
    { "step": "DummySummary", "configuration": { "nb_cores": 1 } }
  ]
}
EOF
}

Submit() {
  local name="$1" commit="$2" sleep="$3"
  Flow "${sleep}" > "${work}/flow.json"
  printf '%-60s ' "${name:0:60}"
  curl -sS -X POST "${SCHEDULER}/api/task/new" \
      -F "config=@${work}/flow.json" -F "script=@${work}/dummy.sh" \
      -F "name=${name}" -F "user=${DUMMY_USER}" -F "job_type=dummy" \
      -F "args[COMMIT_ID]=${commit}" -F "args[PACKAGE]=tlspuffin"
  echo
}

# merge of PR #540 on dev
Submit "Performance - 5c588ab11ce137d8199cfcde2897d95b83f830e1" 5c588ab11ce137d8199cfcde2897d95b83f830e1 240
# tip of the open PR #545
Submit "Vulnerabilities (group A) search - d9b09ff4448fe29e20bb1043c8f4f60f4cbfff77" \
    d9b09ff4448fe29e20bb1043c8f4f60f4cbfff77 120
# commit 1 of the 2 commits of PR #545, custom name
Submit "board check" a96945a0cec249c7f9a0148f4e892d7532f8b8ab 120
# dev commit without PR
Submit "Performance - a269124f41c587467bf49abc1cbf060de6ac5a34" a269124f41c587467bf49abc1cbf060de6ac5a34 60
# tip of PR #544
Submit "Vulnerabilities (group B) search - 6bc0e2a90bdf3b7199dd4a08fecd5f2fcc7d13c1" \
    6bc0e2a90bdf3b7199dd4a08fecd5f2fcc7d13c1 60
