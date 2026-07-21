CheckObjectif() {
  local -n ref_status=$1; shift
  local tlspuffin_pid="$1"; shift;
  local stats="$1"; shift;
  local -n ref_goal_success=$1; shift

  local statsmaxsize=$(( 16*1024*1024 ));
  local statssize=0;
  local lastcheck=0;
  local nbissues=0;
  local problems='';
  while true; do
    local obj_count=$( find experiments/*/objective -maxdepth 1 -type f -name '*.trace' 2>/dev/null | wc -l )
    if (( ${obj_count} > 0 )); then
      echo "FOUND OBJECTIF, END PROCESS" >&2
      ref_goal_success=1
      break;
    fi

    local currentProblems='';
    ExperimentCheckAllThreadsRunning "${tlspuffin_pid}" statssize lastcheck "${stats}" "${THEJOB_NB_CORES}" currentProblems || break;
    local haveissue=0;
    local i='';
    for i in ${currentProblems}; do
      echo "${problems}" | grep -q " ${i} " && { haveissue=1; break; }
    done;
    problems="${currentProblems}";
    (( haveissue == 0)) && nbissues=0 || (( ++nbissues ));
    (( nbissues > 0 )) && echo "Checking Process vital: nbissues: ${nbissues}, problems: ${problems}" >&2

    (( nbissues > 4 )) && { echo "TOO MUCH ISSUES, END PROCESS" >&2 ; break; }

    if (( statssize > statsmaxsize )); then
      echo "Try purge ${stats}";
      cp "${stats}" "${stats}.1"
      [ ! -e "${stats}.0" ] && cp "${stats}" "${stats}.0"
      local purgeRetries=0
      while (( statssize > statsmaxsize )); do
        truncate -s 0 "${stats}";
        sleep 0.5;
        statssize=$( stat --format=%s "${stats}" )
        (( purgeRetries++ ))
        (( purgeRetries > 10 )) && { echo "Fail to purge ${stats}" >&2; break; };
      done;
      (( purgeRetries <= 10 )) && statssize=0;
    fi;

    sleep 60;
  done
  echo "END EXPERIMENT ${tlspuffin_pid} ..." >&2
  ref_status=$( EndDirectChild "${tlspuffin_pid}" );
  local code=$?
  (( code != 0 )) && ref_status=1
  echo "END EXPERIMENT ${tlspuffin_pid}" >&2

  echo "${ref_goal_success}";
  return 0;
}

Experiment () {
  local tlspuffin_pid=0;
  local tlspuffin_killed=0;
  local stats="";
  ExperimentRun tlspuffin_pid tlspuffin_killed stats 0 "${@}" || return 1;
  echo  "${stats}" > ./.xp_state_file
  echo "Experiment launched with process: ${tlspuffin_pid}" >&2

  local goal_success=0
  local status=1
  if ((tlspuffin_killed == 0)); then
    echo "CheckObjectif status ${tlspuffin_pid} ${stats} goal_success" >&2
    CheckObjectif status "${tlspuffin_pid}" "${stats}" goal_success
  fi

  (( goal_success == 1 )) && return 0;
  return "${status}"
}

ExperimentWithCargo () {
  local tlspuffin_pid=-1;
  local tlspuffin_killed=-1;
  local stats="";
  ExperimentRunWithCargo tlspuffin_pid tlspuffin_killed stats 0 "${@}" || return 1;
  echo  "${stats}" > ./.xp_state_file
  echo "Experiment launched with process: ${tlspuffin_pid}" >&2

  local goal_success=0
  local status=1
  if ((tlspuffin_killed == 0)); then
    echo "CheckObjectif status ${tlspuffin_pid} ${stats} goal_success" >&2
    CheckObjectif status "${tlspuffin_pid}" "${stats}" goal_success;
  fi

  (( goal_success == 1 )) && return 0;
  return "${status}"
}

ExperimentEnd() {
  ExperimentEndCommon || return 1;

  local experimentUUID=-1;
  local experiment_base='';
  local objective_count=0;
  ExperimentReport experimentUUID experiment_base objective_count || return 1;

  local errorFile="${THEJOB_ARTEFACTS_PATH}/${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-log/error.log"
  local errorFilePresent='false';
  [ -r "${errorFile}" ] && grep -q "Timeout in fuzz run" "${errorFile}" && errorFilePresent='true';
  
  local outFile="${THEJOB_OUT_PATH}/summary-${THEJOB_STEP_ID}-${THEJOB_STEP_ATTEMPT_ID}.json"
  if statsJSON=$( FindFile "${experiment_base}" "stats.json" "log/stats.json" ); then
    "${THEJOB_TOOLS_PATH}/qjs" --std "${THEJOB_TOOLS_PATH}/js/vuln_experiment_end.js" task.json "${LIBAFL_VERSION}" "${statsJSON}" "${objective_count}" "${errorFilePresent}" "${experimentUUID}" "${outFile}" >> "${THEJOB_USER_STATE_FILE}"
  else
    echo '{ "error": "stats.json not found" }' > "${outFile}"
  fi
}

SummaryRun () {
  [ -z "${COMMIT_ID}" ] && COMMIT_ID="main"
  [ -z "${TYPE}" ] && TYPE="vuln"
  CreateArtefact "./summary.json" "summary.json" "commit_id:${COMMIT_ID}"
  "${THEJOB_TOOLS_PATH}/qjs" --std "${THEJOB_TOOLS_PATH}/js/vuln_summary_run.js" "${COMMIT_ID}" "${THEJOB_TASK_ID}" "${TYPE}" "${THEJOB_ARTEFACTS_PATH}" "${THEJOB_OUT_PATH}" ./summary.json || return 1;
  return 0;
}
