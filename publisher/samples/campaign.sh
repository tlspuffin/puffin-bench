Init () {
  echo "################ Init ################" >&2;
  commit=${COMMIT_ID}

  [ -z "${commit}" ] && commit="main"

  AddGlobalParam "START_PORT" $(( 6000 ))

  #AbortFail git clone https://github.com/tlspuffin/tlspuffin.git "${OUTPATH}/repo" || return 1;
  AbortFail cp -apr "${OUTPATH}/../../repo" "${OUTPATH}/repo" || return 1;

  AbortFail cd "${OUTPATH}/repo" || return 1;
  AbortFail git checkout "${commit}" || return 1;
  AbortFail git submodule update --init --recursive || return 1;

  if [ ! -e "shell.nix" ]; then
    AbortFail cp "${INPATH}/shell.nix" . || return 1
  fi
  AbortFail nix-shell --run cargo >/dev/null 2>/dev/null || return 1;

  return 0;
}

Build() {
  [ -z "${COMMIT_ID}" ] && return 1;
  echo "tlspuffin-${COMMIT_ID}-${features}"
  MD5SUM_RES=$( echo "tlspuffin-${COMMIT_ID}-${features}" | md5sum )
  CACHE_ID="tlspuffin-${MD5SUM_RES%% *}"
  echo "cid: ${CACHE_ID}"
  cache_ok=1
  if [[ "${COMMIT_ID}" != "main" ]]; then
    binary=$( ${TOOLSPATH}/get_file.sh -q "$CACHE_ID" )
    cache_ok=$?
  fi
  if [[ $cache_ok -ne 0 ]]; then
    AbortFail cp -apr "${OUTPATH}/repo" . || return 1;
    AbortFail cd repo || return 1;
    if [ ! -e "shell.nix" ]; then
      AbortFail cp "${INPATH}/shell.nix" . || return 1
    fi
    AbortFail nix-shell --run "cargo build --bin tlspuffin --release --features=${features}" || return 1;
    binary=$( realpath ./target/release/tlspuffin )
    AbortFail curl -s -X PUT "http://localhost:8080/api/cache/${CACHE_ID}" -H "Content-Type: application/json" --data-binary "{\"path\": \"${binary}\"}" || return 1;
  fi
  AbortFail cp "${binary}" "${OUTPATH}/${CACHE_ID}" || return 1;
  #CreateArtefact "${binary}" "${CACHE_ID}" "commit_id:${COMMIT_ID}" "is_release:true"

  return 0
}

Experiment0 () {
  experiment="${STEP_NAME}"
  MD5SUM_RES=$( echo "tlspuffin-${COMMIT_ID}-${features}" | md5sum )
  #binary="${OUTPATH}/tlspuffin-${MD5SUM_RES%% *}"
  AbortFail cp "${OUTPATH}/tlspuffin-${MD5SUM_RES%% *}" tlspuffin || return 1

  core=0
  end_core=$(( NBCORES - 1))

  ipcrm --all

  if [ ! -e "shell.nix" ]; then
    AbortFail cp "${INPATH}/shell.nix" . || return 1
  fi
  AbortFail nix-shell --run "./tlspuffin seed" || return 1;
  AbortFail eval $( ${TOOLSPATH}/reserve_port ) || return 1; # reserve a tcp port on if 127.0.0.1 (RESERVED_PORT, RESERVED_PORT_PID)
  #echo nix-shell --run "./tlspuffin --cores \"${core}-${end_core}\" --port \"${RESERVED_PORT}\" ${extra_flags} experiment -d \"${experiment}\" -t \"${experiment}\""
  nix-shell --run "exec ./tlspuffin --cores ${core}-${end_core} --port ${RESERVED_PORT} ${extra_flags} experiment -d \"${experiment}\" -t \"${experiment}\"" &
  TLSPUFFIN_PID=$!

  sleep 10
  kill -0 ${TLSPUFFIN_PID} 2>/dev/null
  if (( $? == 0 )); then
    TLSPUFFIN_OUTPATH=$( ls experiments/ )
    CreateArtefact "./experiments/${TLSPUFFIN_OUTPATH}/README.md" "${STEP_NAME}/${ATTEMPT_ID}-README.md" "commit_id:${COMMIT_ID}" "features:${features}"
    CreateArtefact "./experiments/${TLSPUFFIN_OUTPATH}/stats.json" "${STEP_NAME}/${ATTEMPT_ID}-stats.json" "commit_id:${COMMIT_ID}" "features:${features}"
  fi

  CRASHED=0
  while true; do
    sleep 10
    kill -0 ${TLSPUFFIN_PID} 2>/dev/null
    if (( $? != 0 )); then
      CRASHED=1
      break;
    fi
    OBJ_COUNT=$( find experiments/*/objective -maxdepth 1 -type f -name '*.trace' 2>/dev/null | wc -l )
    if (( ${OBJ_COUNT} > 0 )); then
      kill ${TLSPUFFIN_PID} 2> /dev/null
      N=10
      for (( i=0; i<N; i++ )); do
        kill -0 ${TLSPUFFIN_PID} 2> /dev/null
        if (( $? != 0 )); then
          break;
        fi
        sleep 0.5
      done
      kill -0 ${TLSPUFFIN_PID} 2> /dev/null
      if (( $? == 0 )); then
        sleep 5
        kill -9 ${TLSPUFFIN_PID} 2> /dev/null
      fi
      break;
    fi
  done
  wait "$TLSPUFFIN_PID" 2>/dev/null

  ipcrm --all

  kill ${RESERVED_PORT_PID}

  return ${CRASHED}
}

Experiment () {
  experiment="${STEP_NAME}"
  MD5SUM_RES=$( echo "tlspuffin-${COMMIT_ID}-${features}" | md5sum )
  #binary="${OUTPATH}/tlspuffin-${MD5SUM_RES%% *}"
  ls
  AbortFail cp "${OUTPATH}/tlspuffin-${MD5SUM_RES%% *}" tlspuffin || return 1
  ls

  core=0
  end_core=$(( NBCORES - 1))

  ipcrm --all

  if [ ! -e "shell.nix" ]; then
    AbortFail cp "${INPATH}/shell.nix" . || return 1
  fi
  #AbortFail nix-shell --run "./tlspuffin seed" || return 1;
  AbortFail ./tlspuffin seed || return 1;
  AbortFail eval $( ${TOOLSPATH}/reserve_port ) || return 1; # reserve a tcp port on if 127.0.0.1 (RESERVED_PORT, RESERVED_PORT_PID)
  #echo nix-shell --run "./tlspuffin --cores \"${core}-${end_core}\" --port \"${RESERVED_PORT}\" ${extra_flags} experiment -d \"${experiment}\" -t \"${experiment}\""
  #nix-shell --run "exec ./tlspuffin --cores ${core}-${end_core} --port ${RESERVED_PORT} ${extra_flags} experiment -d \"${experiment}\" -t \"${experiment}\"" &
  ./tlspuffin --cores ${core}-${end_core} --port ${RESERVED_PORT} ${extra_flags} experiment -d "${experiment}" -t "${experiment}" &
  TLSPUFFIN_PID=$!

  StartMonitor ${TLSPUFFIN_PID}

  wait "$TLSPUFFIN_PID" 2>/dev/null
  RETVAL=$?
  ipcrm --all

  kill ${RESERVED_PORT_PID}

  return ${RETVAL}
}

CheckObjectif () {
  OUTFILE="$1";
  if [ -z "${OUTFILE}" ]; then
    echo "Missing outfile"
    return 1;
  fi
  shift;
  TLSPUFFIN_PID=$1;
  if [ -z "${TLSPUFFIN_PID}" ]; then
    echo "Missing PID arg" > ${OUTFILE}
    return 1;
  fi
  shift

  kill -0 ${TLSPUFFIN_PID} 2>/dev/null
  if (( $? != 0 )); then
    echo "Not running" > ${OUTFILE}
    return 0;
  fi

  NBFOLDERS=$( ls -l experiments/ | grep ^d | wc -l )
  case "${NBFOLDERS}" in
    0)
      echo "Not started" > ${OUTFILE}
      return 0;
      ;;
    1)
      TLSPUFFIN_OUTPATH=$( ls experiments/ )
      CreateArtefact "./experiments/${TLSPUFFIN_OUTPATH}/README.md" "${STEP_NAME}/${ATTEMPT_ID}-README.md" "commit_id:${COMMIT_ID}" "features:${features}"
      CreateArtefact "./experiments/${TLSPUFFIN_OUTPATH}/stats.json" "${STEP_NAME}/${ATTEMPT_ID}-stats.json" "commit_id:${COMMIT_ID}" "features:${features}"
      mkdir experiments/RUNNING
      echo "Artefacts created" > ${OUTFILE}
      ;;
    2)
      ;;
    *)
      echo "Too much folders in experiments" > ${OUTFILE}
      return 1;
      ;;
  esac

  OBJ_COUNT=$( find experiments/*/objective -maxdepth 1 -type f -name '*.trace' 2>/dev/null | wc -l )
  if (( ${OBJ_COUNT} > 0 )); then
    echo "Objective found" >> ${OUTFILE}
    kill ${TLSPUFFIN_PID} 2> /dev/null
    N=10
    for (( i=0; i<N; i++ )); do
      sleep 0.5
      kill -0 ${TLSPUFFIN_PID} 2> /dev/null
      if (( $? != 0 )); then
        return 0;
      fi
    done
    kill -9 ${TLSPUFFIN_PID} 2> /dev/null
  fi
}

ManageResults () {
  echo "${vulnerabilities}"
  PYTHON_STORAGE="${HOME}"
  #PYTHON_STORAGE="/local-unsafe/demengeo"
  if [[ ! -d "${PYTHON_STORAGE}/puffin-bench.venv" ]]; then
    python3 -m venv "${PYTHON_STORAGE}/puffin-bench.venv"
    source "${PYTHON_STORAGE}/puffin-bench.venv/bin/activate"
    python3 -m pip install -r ${script}/requirements.txt
  else
    source "${PYTHON_STORAGE}/puffin-bench.venv/bin/activate"
  fi
  python3 ${script}/cli.py generate --commit "${COMMIT_ID}" "${ARTEFACTSPATH}/" out.csv
  python3 ${script}/cli.py report --outdir out out.csv
  CreateArtefact "./out/report" "report" "commit_id:${COMMIT_ID}"
  return 0
}

CleanupUser () {
  echo "CLEAN"
  echo rm -rf git.${sid}
}
