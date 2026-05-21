#!/bin/bash

# Generic campaign probe script for samples/PR_campaign.json
#
# Logs all scheduler-injected variables at each step without asserting any
# expected value.  Use this to inspect what the scheduler actually delivers
# for any RUNTIME_RUN_CONFIG / runtime combination before writing assertions.

_log_step() {
  local step="$1"
  {
    echo "────────────────────────────────────────"
    echo "STEP        : ${step}"
    echo "rank        : ${THEJOB_STEP_RANK_ID}"
    echo "attempt     : ${THEJOB_STEP_ATTEMPT_ID}"
    echo "nb_cores    : ${THEJOB_NB_CORES}"
    echo "── args ──────────────────────────────"
    echo "COMMIT_ID   : ${COMMIT_ID}"
    echo "vendor      : ${vendor}"
    echo "features    : ${features}"
    echo "extra_flags : ${extra_flags}"
    echo "── env (all THEJOB_*) ────────────────"
    env | grep '^THEJOB_' | sort
    echo "────────────────────────────────────────"
  } | tee -a "${THEJOB_OUT_PATH}/probe.log" 1>&2
}

Init()              { _log_step "Init";              }
ForcedBuild()       { _log_step "ForcedBuild";       }
ExperimentWithCargo() { _log_step "ExperimentWithCargo"; }
ExperimentEnd()     { _log_step "ExperimentEnd";     }
CleanAllRepo()      { _log_step "CleanAllRepo";      }

MonitorExperiment() {
  echo "monitor: running" > "$1"
}

SummaryRun() {
  _log_step "SummaryRun"
  local log="${THEJOB_OUT_PATH}/probe.log"
  [ -f "${log}" ] && CreateArtefact "${log}" "probe.log"
}
