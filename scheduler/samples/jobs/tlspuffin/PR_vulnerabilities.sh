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
  ExperimentEndCommon
  SaveSummary
}

SaveSummary() {
  local output="summary.json";
  CreateArtefact "summary.json" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-summary-stats.json" "commit_id:${COMMIT_ID}" "features:${features}"

  #local stats=$( cat ./.xp_state_file )
  local stats="${THEJOB_ARTEFACTS_PATH}/${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-stats.json"
  [ -r "${stats}" ] || {
    echo "{\"error\": \"no file ${stats} not found\"}" > "${output}"
    return 1;
  }

  local -a filesLst=()
  [ -r "${stats}.1" ] && filesLst+=("${stats}.1")
  filesLst+=("${stats}")
  : > "${output}"
  for file in "${filesLst[@]}"; do
    awk '
      function Validate(line, is_first,       opens, closes, i, c) {
        if (is_first == 1) {
          if (line !~ /^\{/) return ""
          line = substr(line, 2)
        } else if (is_first == 0) {
          if (line !~ /\}$/) return ""
          line = substr(line, 1, length(line) - 1)
        }

        opens = 0
        closes = 0
        for (i = 1; i <= length(line); i++) {
          c = substr(line, i, 1)
          if (c == "{") opens++
          else if (c == "}") closes++
        }
        if (opens != closes) return ""
        return line
    }
      BEGIN {
        RS="}{"; line=""; buffer=""; first_record="";
      }
      {
        sub(/\n$/, "", $0)

        line = buffer
        if (NR == 1) {
          first_record=$0;
          buffer = Validate($0, 1)
        } else {
          buffer = $0
        }
        if (line != "") {
          if (Validate(line, 2) != "") {
            print "{" line "}"
          }
        }
      }
      END {
        if (NR == 1) {
          if (buffer !~ /^\{/) buffer = substr(first_record, 2);
          else buffer = ""
        }
        line = Validate(buffer, 0)
        if (line != "") {
          print "{" line "}"
        }
      }
    ' "${file}" >> "${output}"
  done

  local summary=$( awk '
    BEGIN {
      nb = 0;
    }
    {
      if ($0 ~ /"type":"global"/) {
        if (!global_set) {
          global = $0
          if ($0 !~ /"objective_size":0/) {
            global_set = 1
          }
        }
      } else if ($0 ~ /"type":"client"/) {
        if (match($0, /"id": *[0-9]+/)) {
          id = substr($0, RSTART, RLENGTH)
          gsub(/[^0-9]/, "", id)
          if (id > nb) { nb = id }
          if (!clients_set[id]) {
            clients[id] = $0
            if ($0 !~ /"objective_size":0/) {
              clients_set[id] = 1
            }
          }
        }
      }
    }
    END {
      if (global) print global

      for (id = 1; id <= nb; id++) {
        if (clients[id]) print clients[id]
      }
    }' "${output}" | jq -c '.' 2>/dev/null )

  echo "${summary}" > "${output}"
  [ -r "./.compil_info.json" ] && cat "./.compil_info.json" >> "${output}" || echo "Missing .compil_info.json file" >&2

  local errorFile="${THEJOB_ARTEFACTS_PATH}/${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-log/error.log"
  [ -r "${errorFile}" ] && grep -q "Timeout in fuzz run" "${errorFile}" && echo '{"run_error":"fuzzer timeout"}' >> "${output}"
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
    local cputs="";
    while read -r i; do
      local statsFile="${i#"${THEJOB_ARTEFACTS_PATH}/${lib}/"}";
      local runID="${statsFile%'-summary-stats.json'}"
      local readmeFile="${THEJOB_ARTEFACTS_PATH}/${lib}/${runID}-README.md"
      local jsonEntry='';
      if [ ! -r "${readmeFile}" ]; then
        jsonEntry=" { \"id\": \"${runID}\", \"duration\": 0, \"total_execs\": 0, \"objective_size\": 0, \"valid\": false }";
        echo "Missing required file ${readmeFile}" >&2; 
      elif [ ! -r "${i}" ]; then
        jsonEntry=" { \"id\": \"${runID}\", \"duration\": 0, \"total_execs\": 0, \"objective_size\": 0, \"valid\": false }";
        echo "Missing required file ${i}" >&2; 
      elif jq -e 'has("error")' "${i}" 2>/dev/null >&2; then
        jsonEntry=" { \"id\": \"${runID}\", \"duration\": 0, \"total_execs\": 0, \"objective_size\": 0, \"valid\": false }";
        echo "Error in required file ${i}" >&2; 
      else
        local startTime=$( date -d "$( sed -n 's/* Date: \(.*\)\.[0-9][0-9]*/\1/p' "${readmeFile}" )" +%s )
        local endTime=$( jq -r 'select(.type=="global") | .time.secs_since_epoch' "${i}" )
        local runTime=$(( endTime - startTime ))

        local objectiveSize=$( jq -n '[inputs.objective_size] | max' "${i}" );
        [ -z "${objectiveSize}" ] && objectiveSize=0;
        local totalExecs=$( jq 'select(.type == "global") | .total_execs' "${i}" );
        [ -z "${totalExecs}" ] && totalExecs=0;
        jsonEntry=" { \"id\": \"${runID}\", \"duration\": ${runTime}, \"total_execs\": ${totalExecs}";
        local cancelByRunError=$( jq -r 'select(has("run_error")) | .run_error' "${i}" )
        [ -n "${cancelByRunError}" ] && { jsonEntry+=", \"run_error\": \"${cancelByRunError}\""; objectiveSize=0; }
        jsonEntry+=", \"objective_size\": ${objectiveSize}, \"valid\": true }";
        [ -z "${cputs}" ] && cputs=$( jq -r 'select(has("cputs")) | .cputs' "${i}" )
      fi
      if (( ! firstRun )); then
        echo -n "," >> .run-summary.json.tmp
      fi
      firstRun=0;
      echo -n  "${jsonEntry}" >> .run-summary.json.tmp

    done < <( find "${libresults}" -name "*-summary-stats.json" | sort -V )
    echo -n " ], \"cputs\": \"${cputs}\" }" >> .run-summary.json.tmp
  done < <( find "${THEJOB_ARTEFACTS_PATH}" -maxdepth 1 -mindepth 1 -type d | sort -V )
  echo " ] }" >> .run-summary.json.tmp
  mv .run-summary.json.tmp run-summary.json;
  CreateArtefact "./run-summary.json" "run-summary.json" "commit_id:${COMMIT_ID}"
  return 0;
}
