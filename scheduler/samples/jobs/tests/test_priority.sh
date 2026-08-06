#!/bin/bash
#
# Test: task priority scheduling.
#
# Exercises the full chain: Task::priority_, Schedule::steps_ sorted
# insertion/relocation (AddTask / TaskUpdatePriority), and the strict
# per-tier blocking in Local::FindRunnableSteps() — not just that the field
# is accepted, but that it actually changes execution order.
#
# Requires:
#   - jq (for parsing JSON responses)
#   - Server running with the local executor configured for at least 2 cores
#     (executors.local.nbCores). The actual count is auto-detected from
#     GET /api/tasks/running (data.executors[].nb_cores) — no need to match
#     a hardcoded value.
#   - Server built with the "PRIORITY" runtime[] substitution wired in
#     Schedule::AddTask() (RUNTIME_PRIORITY placeholder).
#
# Usage:
#   ./test_priority.sh [host] [port]

set -u
set -o pipefail

HOST="${1:-127.0.0.1}"
PORT="${2:-10082}"
BASE="http://${HOST}:${PORT}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLOW="${SCRIPT_DIR}/test_priority_flow.json"
JOB="${SCRIPT_DIR}/test_priority_job.sh"

PASS=0
FAIL=0

check() {
  local label="$1" ok="$2"
  if [ "${ok}" = "1" ]; then
    echo "OK   ${label}"
    PASS=$((PASS + 1))
  else
    echo "FAIL ${label}"
    FAIL=$((FAIL + 1))
  fi
}

# require_server — abort immediately with a clear message if the server
# can't be reached, instead of letting empty curl output silently cascade
# into empty task ids and confusing timeouts further down.
require_server() {
  if ! curl -sf -m 3 "${BASE}/api/tasks/running" > /dev/null; then
    echo "ERROR: cannot reach ${BASE}/api/tasks/running — is the server running on ${HOST}:${PORT}?" 1>&2
    exit 1
  fi
}

# total_cores -> prints the local executor's configured nbCoresMax_
# (data.executors[].nb_cores), so scenarios can size their contention
# relative to whatever the server actually has, instead of assuming a
# specific nbCores value in the config.
total_cores() {
  local n
  n=$(curl -sf "${BASE}/api/tasks/running" \
    | jq -r '.data.executors[] | select(.name == "local") | .nb_cores')
  if [ -z "${n}" ] || [ "${n}" -lt 2 ]; then
    echo "ERROR: local executor reports nb_cores='${n}' — need at least 2 to run scenario 2/3" 1>&2
    exit 1
  fi
  echo "${n}"
}

# submit_task <priority> <nb_cores> <sleep_seconds> -> prints task id on stdout
# Aborts the whole script (not just a check) on failure: a failed submission
# makes every subsequent step of the running scenario meaningless anyway.
submit_task() {
  local priority="$1" nb_cores="$2" seconds="$3"
  local resp id
  resp=$(curl -sf -X POST "${BASE}/api/task/new" \
      -F "name=prio-test-${priority}-$$-${RANDOM}" \
      -F "config=@${FLOW}" \
      -F "script=@${JOB}" \
      -F "runtime[RUNTIME_PRIORITY]=${priority}" \
      -F "runtime[RUNTIME_NB_CORES]=${nb_cores}" \
      -F "args[SLEEP_SECONDS]=${seconds}")
  if [ -z "${resp}" ]; then
    echo "ERROR: task submission failed — no response from ${BASE}/api/task/new" 1>&2
    exit 1
  fi
  id=$(echo "${resp}" | jq -r '.task_id // empty')
  if [ -z "${id}" ]; then
    echo "ERROR: task submission failed — response was: ${resp}" 1>&2
    exit 1
  fi
  echo "${id}"
}

# task_state <task_id> -> prints current state, empty if task not found
task_state() {
  local task_id="$1"
  curl -sf "${BASE}/api/tasks/running" \
    | jq -r --arg id "${task_id}" \
        '.data.tasksmanager.tasks[]? | select((.id|tostring) == $id) | .state'
}

# wait_for_state <task_id> <state> <timeout_s>
wait_for_state() {
  local task_id="$1" want="$2" timeout="$3" waited=0
  while [ "${waited}" -lt "${timeout}" ]; do
    [ "$(task_state "${task_id}")" = "${want}" ] && return 0
    sleep 0.5
    waited=$((waited + 1))
  done
  return 1
}

# wait_while_running <task_id> <timeout_s> — returns once task is no longer
# Running (finished, or already gone from the live list after archival)
wait_while_running() {
  local task_id="$1" timeout="$2" waited=0
  while [ "${waited}" -lt "${timeout}" ]; do
    [ "$(task_state "${task_id}")" != "Running" ] && return 0
    sleep 0.5
    waited=$((waited + 1))
  done
  return 1
}

echo "=== Priority scheduling tests against ${BASE} ==="
echo ""

require_server
TOTAL_CORES=$(total_cores)
echo "detected local executor nb_cores=${TOTAL_CORES}"
echo ""

# ── Scenario 1 — priority overtakes FIFO submission order ──────────────────
#
# LOW starts alone (nothing else queued). While it's still running, MID then
# HIGH are submitted, in that order. Once LOW frees its core, HIGH must run
# next — despite MID having been submitted first.
#
# Each task requests TOTAL_CORES (i.e. every core) so at most one can ever
# run at a time regardless of how many cores the server actually has —
# otherwise, with a few spare cores, MID/HIGH would just start alongside LOW
# immediately and the ordering being tested here would never be exercised.
echo "--- Scenario 1: priority overtakes submission order"

id_low=$(submit_task 0 "${TOTAL_CORES}" 8)
echo "submitted LOW  id=${id_low} priority=0"
if wait_for_state "${id_low}" "Running" 10; then
  echo "LOW is running"
else
  check "LOW started (prerequisite for scenario 1)" 0
fi

id_mid=$(submit_task 10 "${TOTAL_CORES}" 8)
id_high=$(submit_task 20 "${TOTAL_CORES}" 8)
echo "submitted MID  id=${id_mid} priority=10 (while LOW still running)"
echo "submitted HIGH id=${id_high} priority=20 (while LOW still running)"

wait_while_running "${id_low}" 15
echo "LOW finished"
sleep 1  # let one scheduler tick (500ms) pick the next runnable step

state_high=$(task_state "${id_high}")
state_mid=$(task_state "${id_mid}")
echo "after LOW finished: HIGH=${state_high} MID=${state_mid}"
check "HIGH runs next despite MID being submitted first" \
    "$([ "${state_high}" = "Running" ] && echo 1 || echo 0)"

wait_while_running "${id_high}" 15
wait_while_running "${id_mid}" 15
echo ""

# ── Scenario 2 — strict blocking by tier ────────────────────────────────────
#
# FILLER takes 1 core. BIG_HIGH (priority 20) requests every core
# (TOTAL_CORES) — with FILLER already holding one, that's always more than
# what's free, so it's genuinely blocked no matter how many cores exist.
# SMALL_LOW (priority 0) needs only 1 core — it would fit in a free core,
# but must NOT be allowed to run ahead of the blocked higher-priority step
# (strict per-tier blocking, not the "smaller step bypasses a stuck bigger
# one" behaviour).
echo "--- Scenario 2: a blocked high-priority step blocks a smaller low-priority one"

id_filler=$(submit_task 0 1 12)
wait_for_state "${id_filler}" "Running" 10
echo "FILLER running, 1/${TOTAL_CORES} cores used"

id_bighigh=$(submit_task 20 "${TOTAL_CORES}" 8)
id_smalllow=$(submit_task 0 1 8)
echo "submitted BIG_HIGH  id=${id_bighigh} priority=20 nb_cores=${TOTAL_CORES} (FILLER holds 1 -> can't fit -> blocked)"
echo "submitted SMALL_LOW id=${id_smalllow} priority=0 nb_cores=1 (would fit in a free core)"

sleep 3  # several scheduler ticks
state_smalllow=$(task_state "${id_smalllow}")
echo "SMALL_LOW state after 3s: ${state_smalllow}"
check "SMALL_LOW stays Pending behind the unsatisfied higher-priority step" \
    "$([ "${state_smalllow}" = "Pending" ] && echo 1 || echo 0)"

wait_while_running "${id_filler}" 15
wait_while_running "${id_bighigh}" 15
wait_while_running "${id_smalllow}" 15
echo ""

# ── Scenario 3 — a Running step must not be mistaken for a blocked one ─────
#
# Regression test for the bug where Local::FindRunnableSteps() flagged the
# whole tier as "not drained" just because one of its steps was already
# Running (state != Pending), instead of only when a step is genuinely
# resource-blocked. HIGH_RUN runs alone in its tier (nothing else pending
# there) — LOW_FREE, lower priority, must still start promptly since
# plenty of cores remain free.
echo "--- Scenario 3: a running higher-priority step alone must not block a lower tier"

id_highrun=$(submit_task 20 1 10)
wait_for_state "${id_highrun}" "Running" 10
echo "HIGH_RUN running alone in its tier"

id_lowfree=$(submit_task 0 1 8)
echo "submitted LOW_FREE id=${id_lowfree} priority=0 (cores free, HIGH_RUN's tier has nothing pending)"

if wait_for_state "${id_lowfree}" "Running" 6; then
  rc=1
else
  rc=0
fi
check "LOW_FREE starts promptly despite HIGH_RUN still Running" "${rc}"

# Not just "eventually ran" — confirm the two are genuinely running at the
# same instant (cascade: leftover capacity is used, not left idle behind
# a higher tier that has nothing left to schedule).
state_highrun_now=$(task_state "${id_highrun}")
echo "HIGH_RUN state while LOW_FREE is Running: ${state_highrun_now}"
check "HIGH_RUN and LOW_FREE run concurrently (cascade uses free capacity)" \
    "$([ "${state_highrun_now}" = "Running" ] && echo 1 || echo 0)"

wait_while_running "${id_highrun}" 15
wait_while_running "${id_lowfree}" 15
echo ""

echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "${FAIL}" -eq 0 ]
