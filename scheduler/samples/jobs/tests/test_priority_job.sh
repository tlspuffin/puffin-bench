#! /bin/bash
#
# Single step used by test_priority.sh. Just sleeps so the orchestrator has
# time to observe which task the scheduler picked first.

Sleep() {
  local seconds=${SLEEP_SECONDS:-8}
  echo "Sleep step start task=${THEJOB_TASK_ID:-?} pid=$$ duration=${seconds}s" 1>&2
  sleep "${seconds}"
  echo "Sleep step done task=${THEJOB_TASK_ID:-?}" 1>&2
  return 0
}
