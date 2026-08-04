Experiment () {
  local tlspuffin_pid=0;
  local tlspuffin_killed=0;
  local stats="";
  ExperimentRun tlspuffin_pid tlspuffin_killed stats 1 "${@}" || return 1;

  local status=1
  (( tlspuffin_killed == 0 )) && {
    status=$( ExperimentCheckRun "${tlspuffin_pid}" "${stats}" )
  }

  return ${status}
}

ExperimentWithCargo () {
  local tlspuffin_pid=0;
  local tlspuffin_killed=0;
  local stats="";
  ExperimentRunWithCargo tlspuffin_pid tlspuffin_killed stats 1 "${@}" || return 1;

  local status=1
  (( tlspuffin_killed == 0 )) && {
    status=$( ExperimentCheckRun "${tlspuffin_pid}" "${stats}" )
  }

  return ${status}
}

ExperimentEnd() {
  ExperimentEndCommon || return 1;

  local experimentUUID=-1;
  local experiment_base='';
  local objective_count=0;
  ExperimentReport experimentUUID experiment_base objective_count || return 1;
  local outFile="${THEJOB_OUT_PATH}/summary-${THEJOB_STEP_ID}-${THEJOB_STEP_ATTEMPT_ID}.json"
  if statsJSON=$( FindFile "${experiment_base}" "stats.json" "log/stats.json" ); then
    "${THEJOB_TOOLS_PATH}/qjs" --std "${THEJOB_TOOLS_PATH}/js/perf_experiment_end.js" task.json "${LIBAFL_VERSION}" "${statsJSON}" "${objective_count}" "${experimentUUID}" "${outFile}" >> "${THEJOB_USER_STATE_FILE}" 
  else
    echo '{ "error": "stats.json not found" }' > "${outFile}"
  fi
  (( objective_count > 0 )) || return 0;
  return 0;
}

SummaryRun () {
  [ -z "${COMMIT_ID}" ] && COMMIT_ID="main"
  [ -z "${TYPE}" ] && TYPE="perf"
  [ -z "${CAMPAIGN_ID}" ] && CAMPAIGN_ID="N/A"
  CreateArtefact "./summary.json" "summary.json" "commit_id:${COMMIT_ID}"
  "${THEJOB_TOOLS_PATH}/qjs" --std "${THEJOB_TOOLS_PATH}/js/perf_summary_run.js" "${COMMIT_ID}" "${THEJOB_USER}" "${THEJOB_TASK_ID}" "${TYPE}" "${CAMPAIGN_ID}" "${THEJOB_ARTEFACTS_PATH}" "${THEJOB_OUT_PATH}" ./summary.json
  local flagObjective=$?
  (( flagObjective == 2 )) && return 1;
  if [ "${flagObjective}" == '0' ]; then
    Flag '{"color": "#6f6f00"}';
  fi
  return 0;
}
