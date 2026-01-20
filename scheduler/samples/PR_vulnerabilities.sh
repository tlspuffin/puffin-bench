CheckObjectif() {
  local -n ref_status=$1; shift
  local tlspuffin_pid="$1"; shift;
  local stats="$1"; shift;
  local -n ref_goal_success=$1; shift

  CreateArtefact "summary.json" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-stats.json" "commit_id:${COMMIT_ID}" "features:${features}"

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

    local currentStatSize="${statssize}";
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

    echo "${statssize}" > ./.xp_state_file_size
    SaveSummary "${currentStatSize}" "${stats}" "summary.json"

    if (( statssize > 268435456 )); then
      local purgeRetries=0
      while (( statssize > 268435456 )); do
        truncate -s 0 "${stats}";
        sleep 0.5;
        statssize=$( stat --format=%s "${stats}" )
        (( purgeRetries++ ))
        (( purgeRetries > 10 )) && { echo "Fail to purge ${stats}" >&2; break; };
      done;
      (( purgeRetries <= 10 )) && statssize=0;
    fi;

    (( nbissues > 4 )) && { echo "TOO MUCH ISSUES, END PROCESS" >&2 ; break; }

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
  echo "Experiment launched with process: ${tlspuffin_pid}" >&2

  local goal_success=0
  local status=1
  if ((tlspuffin_killed == 0)); then
    echo "CheckObjectif status ${tlspuffin_pid} ${stats} goal_success" >&2
    echo "${stats}" > ./.xp_state_file
    CheckObjectif status "${tlspuffin_pid}" "${stats}" goal_success
  fi

  Shutdown

  ExperimentEnd

  (( goal_success == 1 )) && return 0;
  return "${status}"
}

Experiment__Shutdown () {
  Shutdown
}

ExperimentWithCargo () {
  local tlspuffin_pid;
  local tlspuffin_killed;
  local stats="";
  ExperimentRunWithCargo tlspuffin_pid tlspuffin_killed stats 0 "${@}" || return 1;
  echo "Experiment launched with process: ${tlspuffin_pid}" >&2

  local goal_success=0
  local status=1
  if ((tlspuffin_killed == 0)); then
    echo "CheckObjectif status ${tlspuffin_pid} ${stats} goal_success" >&2
    echo "${stats}" > ./.xp_state_file
    CheckObjectif status "${tlspuffin_pid}" "${stats}" goal_success;
  fi

  Shutdown

  ExperimentEnd

  (( goal_success == 1 )) && return 0;
  return "${status}"
}

ExperimentWithCargo__Shutdown () {
  Shutdown
}

Shutdown() {
  [ ! -f './.xp_state_file' ] && return;
  local stats=$( cat './.xp_state_file' )
  [ ! -f "${stats}" ] && return;

  [ ! -f './.xp_state_file_size' ] && return;
  local statSize=$( cat './.xp_state_file_size' )
  [[ ! "${statSize}" =~ ^[0-9]+$ ]] && return;

  SaveSummary "${statSize}" "${stats}" "summary.json"
}

ManageResults () {
  echo "${vulnerabilities}"
  python_storage="/local-unsafe/demengeo"
  if [[ ! -d "${python_storage}/puffin-bench.venv" ]]; then
    python3 -m venv "${python_storage}/puffin-bench.venv"
    source "${python_storage}/puffin-bench.venv/bin/activate"
    python3 -m pip install -r ${script}/requirements.txt
  else
    source "${python_storage}/puffin-bench.venv/bin/activate"
  fi
  python3 ${script}/cli.py generate --commit "${COMMIT_ID}" "${THEJOB_ARTEFACTS_PATH}" out.csv
  python3 ${script}/cli.py report --outdir out out.csv
  CreateArtefact "./out/report" "report" "commit_id:${COMMIT_ID}"
  return 0
}

SummaryRun () {
  [ -z "${COMMIT_ID}" ] && COMMIT_ID="main"

  echo -n '{ "type": "vuln", "libraries": [ ' > .run-summary.json.tmp
  local firstlib=1;
  while read -r libresults; do
    local lib=${libresults#"${THEJOB_ARTEFACTS_PATH}/"}
    if (( ! firstlib )); then
      echo -n "," >> .run-summary.json.tmp
    fi
    firstlib=0
    echo -n " { \"name\": \"${lib}\", \"data\": [ " >> .run-summary.json.tmp
    local firstRun=1;
    while read -r i; do
      local statsFile="${i#"${THEJOB_ARTEFACTS_PATH}/${lib}/"}";
      local runID="${statsFile%'-stats.json'}"
      local readmeFile="${THEJOB_ARTEFACTS_PATH}/${lib}/${runID}-README.md"
      [ ! -r "${readmeFile}" ] && { 
        echo -n " { \"id\": \"${runID}\", \"duration\": 0, \"objective_size\": ${objectiveSize}, \"valid\": false }" >> .run-summary.json.tmp
        echo "Missing required file ${readmeFile}" >&2; 
        continue;
      }
      startTime=$( date -d "$( sed -n 's/* Date: \(.*\)\.[0-9][0-9]*/\1/p' "${readmeFile}" )" +%s )
      local endTime=$( jq -n '[inputs.time.secs_since_epoch] | max' "${i}" )
      local runTime=$(( endTime - startTime ))

      local objectiveSize=$( jq -n '[inputs.objective_size] | max' "${i}" );
      [ -z "${objectiveSize}" ] && objectiveSize=0;

      if (( ! firstRun )); then
        echo -n "," >> .run-summary.json.tmp
      fi
      firstRun=0;
      echo -n " { \"id\": \"${runID}\", \"duration\": ${runTime}, \"objective_size\": ${objectiveSize}, \"valid\": true }" >> .run-summary.json.tmp

    done < <( find "${libresults}" -name "*-stats.json" | sort -n )
    echo -n " ] }" >> .run-summary.json.tmp
  done < <( find "${THEJOB_ARTEFACTS_PATH}"  -maxdepth 1 -mindepth 1 -type d | sort -n )
  echo " ] }" >> .run-summary.json.tmp
  mv .run-summary.json.tmp run-summary.json;
  CreateArtefact "./run-summary.json" "run-summary.json" "commit_id:${COMMIT_ID}"
  return 0;
}