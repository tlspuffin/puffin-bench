CheckObjectif() {
  local tlspuffin_pid="$1"; shift;
  local stats="$1"; shift;

  local nb_clients=0;
  local problems=0;
  local goal_success=0
  while true; do
    sleep 10
    kill -0 ${tlspuffin_pid} 2>/dev/null || break;

    local obj_count=$( find experiments/*/objective -maxdepth 1 -type f -name '*.trace' 2>/dev/null | wc -l )
    if (( ${obj_count} > 0 )); then
      goal_success=1
      break;
    fi

    nb_clients=$( ExperimentCheckAllThreadsRunning "${stats}" "$nb_clients" ) || break;
    (( nb_clients < THEJOB_NB_CORES )) && (( ++problems )) || problems=0;
    (( problems > 10 )) && { tlspuffin_killed=1; break };
  done
  EndDirectChild "${tlspuffin_pid}"

  echo "${tlspuffin_killed}";
  return 0;
}

Experiment () {
  local tlspuffin_pid=0;
  local tlspuffin_killed=0;
  local stats="";
  ExperimentRun tlspuffin_pid tlspuffin_killed stats 0 "${@}" || return 1;

  local nb_clients=0;
  local problems=0;
  if ((tlspuffin_killed == 0)); then
    tlspuffin_killed=$( CheckObjectif "${tlspuffin_pid}" "${stats}" );
  fi
  wait "${tlspuffin_pid}" 2>/dev/null
  local status=$?

  ExperimentEnd

  (( tlspuffin_killed == 1 )) && return 1;
  (( goal_success == 1 )) && return 0;
  return "${status}"
}

ExperimentWithCargo () {
  local tlspuffin_pid;
  local tlspuffin_killed;
  local stats="";
  ExperimentRunWithCargo tlspuffin_pid tlspuffin_killed stats 0 "${@}" || return 1;

  local nb_clients=0;
  local problems=0;
  if ((tlspuffin_killed == 0)); then
    tlspuffin_killed=$( CheckObjectif "${tlspuffin_pid}" "${stats}" );
  fi
  wait "${tlspuffin_pid}" 2>/dev/null
  local status=$?

  ExperimentEnd

  (( tlspuffin_killed == 1 )) && return 1;
  (( goal_success == 1 )) && return 0;
  return "${status}"
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
