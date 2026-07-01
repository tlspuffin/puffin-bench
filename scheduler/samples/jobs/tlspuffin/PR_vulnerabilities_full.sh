#### HELPER START ####

ExperimentCheckAllThreadsRunning() {
  local tlspuffin_pid="$1"; shift;
  local -n ref_oldfilesize=$1; shift;
  local -n ref_lastcheck=$1; shift;
  local stats="$1"; shift;
  local nb_clients="$1"; shift;
  local -n ref_problems=$1; shift;

  echo "StartCheck ${ref_oldfilesize} ${ref_lastcheck} $( date )" >&2

  if ! kill -0 ${tlspuffin_pid} 2>/dev/null; then
    echo "process ${tlspuffin_pid} dead, exit" >&2
    return 1;
  fi

  local logsPath=$( dirname "${stats}" )
  local errorFile="${logsPath}/error.log"
  [ ! -e "${errorFile}" ] && { errorFile="${logsPath}/log/error.log"; [ ! -e "${errorFile}" ] && errorFile=""; }
  [ -e "${errorFile}" ] && grep -q "Timeout in fuzz run" "${errorFile}" && { echo "Timeout found in error.log" >&2; return 1; }

  local lastTS=$( tail -c 64K "${stats}" | sed 's/}{/}\n{/g' 2>/dev/null | head -n -1 | tail -1 | jq -r '.time.secs_since_epoch' );
  if (( ref_lastcheck != 0 )); then
    local diffTS=$(( lastTS - ref_lastcheck ));
    echo "global ${lastTS} - ${ref_lastcheck} = ${diffTS}" >&2
    (( diffTS > 300 )) && {
      echo "global diffTS > 300, exit" >&2
      return 1;
    }
  else
    echo "${ref_lastcheck} == 0" >&2
    [ -z "${lastTS}" ] && {
      echo "no ${stats} no lastTS, end check" >&2
      ref_problems=' -1 ';
      return 0;
    }
  fi

  local filesize=$( stat --format=%s "${stats}" )
  local newdatasize=$(( filesize - ref_oldfilesize ))
  echo "filesize= ${filesize} newdatasize= ${newdatasize}" >&2

  local found_ids=$( dd bs=10M iflag=skip_bytes if="${stats}" skip="${ref_oldfilesize}" status=none | awk 'BEGIN{RS="}{"} { if (match($0, /"id": *[0-9]+/)) { id = substr($0, RSTART, RLENGTH); gsub(/[^0-9]/, "", id); print id } }' | sort -u );
  ref_oldfilesize="${filesize}"
  ref_problems=''
  local i=1
  for ((i=1; i<=nb_clients; i++)); do
    echo "${found_ids}" | grep -q "^${i}$" || ref_problems+=" ${i} ";
  done

  echo "problems= ${ref_problems} end check" >&2
  ref_lastcheck="${lastTS}";
  return 0;
}

function ExperimentCheckRun() {
  [[ ${DISABLE_KILL_ON_HANG:-} == 1 ]] || DISABLE_KILL_ON_HANG=0;

  local tlspuffin_pid="$1"; shift;
  local stats="$1"; shift;

  local statssize=0;
  local lastcheck=0;
  local nbissues=0;
  local problems='';
  while true; do

    if (( DISABLE_KILL_ON_HANG == 1)); then
      if ! kill -0 ${tlspuffin_pid} 2>/dev/null; then
        echo "process ${tlspuffin_pid} dead, exit" >&2
        break;
      fi
    else

      echo "ExperimentCheckRun..." >&2
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
      (( nbissues > 4 )) && break;
      echo "ExperimentCheckRun sleep" >&2

    fi

    sleep 60;
  done
  echo "Issues detected, killing process ${tlspuffin_pid} ..." >&2
  local status;
  status=$( EndDirectChild "${tlspuffin_pid}" );
  local code=$?
  (( code == 0 )) && code=$status
  echo "Issues detected, killed process" >&2
  return $code
}

FindFile() {
  local base_path="$1"
  [ -n "${base_path}" ] && base_path="${base_path%/}/"
  shift
  local file_patterns=("$@")

  for pattern in "${file_patterns[@]}"; do
    local full_path="${base_path}${pattern}"
    if [ -e "${full_path}" ]; then
      echo "${full_path}"
      return 0
    fi
  done
  return 1
}

ComputeBuildRuntimeInfo() {
  if [ ! -e "${THEJOB_OUT_PATH}/repo/tlspuffin/Cargo.toml" ]; then
    echo "Missing required file ${THEJOB_OUT_PATH}/repo/tlspuffin/Cargo.toml"
    return 1;
  fi

  local vendor=$1;
  shift;
  if [ -z "$1" ]; then
    echo "Missing features parameter"
    return 1;
  fi
  local -n ref_features=$1;
  shift;

  if [ -z "$1" ]; then
    echo "Missing cputs parameter"
    return 1;
  fi
  local -n refcputs=$1;
  shift;

  refcputs=false;

  if [ -n "${vendor}" ] && [ -e "${THEJOB_OUT_PATH}/repo/tools/mk_vendor" ]; then
    local version=$( echo "${vendor}" | cut -f 2 -d ':' )
    local library=$( echo "${vendor}" | cut -f 1 -d ':' )
    echo "version= ${version} library= ${library}";
    if [ -e "${THEJOB_OUT_PATH}/repo/puffin-build/vendors/${library}/presets.toml" ]; then
      grep -F -q "[${version}]" "${THEJOB_OUT_PATH}/repo/puffin-build/vendors/${library}/presets.toml" && 
          grep -E -q "^[[:space:]]*cputs[[:space:]]*=" "${THEJOB_OUT_PATH}/repo/tlspuffin/Cargo.toml" && {
            refcputs=true;
            ref_features='cputs';
          }
    fi
  fi
  if [ -n "${required_features}" ]; then
    ref_features="${required_features},${ref_features}"
  fi
  for i in $( echo "${ref_features}" | sed 's/\([^,]\)[,$]/\1\n/g' ); do
    grep -E -q "^[[:space:]]*${i}[[:space:]]*=" "${THEJOB_OUT_PATH}/repo/tlspuffin/Cargo.toml" || {
      echo "Unsupported feature $i";
      return 1;
    }
  done

  echo "cputs= ${refcputs} features= ${ref_features} vendor= ${vendor}";

  return 0;
}

ExperimentSetup() {
  ipcrm --all

  if [ -z "$1" ]; then
    echo "Missing reference parameter binary"
    return 1
  fi
  local -n ref_binary=$1;
  shift;
  if [ -z "$1" ]; then
    echo "Missing reference parameter for last_core"
    return 1
  fi
  local -n ref_last_core=$1;
  shift
  if [ -z "$1" ]; then
    echo "Missing parameter feature"
    return 1
  fi
  local features="$1";
  shift

  [ -z "${COMMIT_ID}" ] && COMMIT_ID="main"
  [ -z "${PREFIX_FAKETIME}" ] && PREFIX_FAKETIME="" || echo "Using faketime"
  ref_binary="${THEJOB_OUT_PATH}/tlspuffin-${THEJOB_STEP_ID}"
  ref_last_core=$(( THEJOB_NB_CORES - 1 ))

  if [ ! -x "${ref_binary}" ]; then
    echo "No binary found ${ref_binary}, skipping run"
    return 1
  fi

  # disable this if preload is set to load asan and faketime
  [ ! -z "${PREFIX_FAKETIME}" ] && echo "${features}" | grep -qi asan && PREFIX_FAKETIME="" && echo "Disable faketime, asan used"

  ## TODO: replace with copy of log settings file
  #cp -apr "${THEJOB_OUT_PATH}/repo" . || return 1;
  #cd repo || return 1;
  if [ -e "${THEJOB_OUT_PATH}/repo/client_log_config.yml" ]; then
    cp "${THEJOB_OUT_PATH}/repo/client_log_config.yml" . || return 1;
  fi
  if [ -e "${THEJOB_OUT_PATH}/repo/shell.nix" ]; then
    cp "${THEJOB_OUT_PATH}/repo/shell.nix" . || return 1;
  else
    cp "${THEJOB_USER_FILES_PATH}/shell.nix" . || return 1;
  fi

  nix-shell --run "\"${ref_binary}\" seed" || return 1;

  rm -rf ./experiments

  eval $( ${THEJOB_TOOLS_PATH}/reserve_port ) || return 1; # reserve a tcp port on if 127.0.0.1 (RESERVED_PORT, RESERVED_PORT_PID)
  echo "${RESERVED_PORT_PID}" > ./.reserved_port.pid
}

ExperimentSetupForCargo() {
  ipcrm --all

  if [ -z "$1" ]; then
    echo "Missing reference parameter for last_core"
    return 1
  fi
  local -n ref_last_core=$1;
  shift
  if [ -z "$1" ]; then
    echo "Missing reference parameter for feature"
    return 1
  fi
  local -n ref_esfc_features=$1;
  shift

  local featureLib=${ref_esfc_features};

  [ -z "${PREFIX_FAKETIME}" ] && PREFIX_FAKETIME="" || echo "Using faketime"
  ref_last_core=$(( THEJOB_NB_CORES - 1 ))

  # disable this if preload is set to load asan and faketime
  [ ! -z "${PREFIX_FAKETIME}" ] && echo "${ref_esfc_features}" | grep -qi asan && PREFIX_FAKETIME="" && echo "Disable faketime, asan used"

  local cputs=false
  ComputeBuildRuntimeInfo "${vendor}" ref_esfc_features cputs || {
      echo "Failed to compute runtime info for vendor '${vendor}' '${ref_esfc_features}'"
      return 1;
  }

  local library=$( echo "${vendor}" | cut -d: -f1 )
  local library_version=""
  if ${cputs}; then
    # "wolfssl:wolfssl580-asan" → wolfssl + 580
    library_version=$( echo "${vendor}" | cut -d: -f2 | cut -d- -f1 | sed "s/${library}//" )
  else
    # ",?wolfssl540,?" → wolfssl + 540
    # ",?libressl,?" → libressl + 333
    if [ -n "${library}" ]; then
      if [ "${library}" == "libressl" ]; then
        featureLib=$( echo "${featureLib}" | sed "s/${library}/${library}0/g" )
      fi
      library_version=$( echo "${featureLib}" | sed -E "s/.*,?${library}([0-9][0-9a-zA-Z]*),?.*/\1/" )
      if [ "${library_version}" == "${featureLib}" ] || [ -z "${library_version}" ]; then
        library="NA";
        library_version="NA";
      elif [ "${library}" == "libressl" ]; then
        library_version=$( echo "${library_version}" | sed "s/^.//" )
        [ -z "${library_version}" ] && library_version="333";
      fi
    else
      library="NA";
      library_version="NA";
    fi
  fi

  local jsonCompilInfos="{ \"cputs\": ${cputs}, \"vendor\": \"${vendor}\", \"features\": \"${ref_esfc_features}\", \"flags\": \"${extra_flags}\", \"library\": { \"name\": \"${library}\", \"version\": \"${library_version}\" } }";
  if ((THEJOB_STEP_ATTEMPT_ID == 0)); then
    echo "${jsonCompilInfos}" > "${THEJOB_OUT_PATH}/cli-${THEJOB_STEP_ID}.json";
  fi
  echo "${jsonCompilInfos}" > "${THEJOB_USER_STATE_FILE}";

  eval $( ${THEJOB_TOOLS_PATH}/reserve_port ) || return 1; # reserve a tcp port on if 127.0.0.1 (RESERVED_PORT, RESERVED_PORT_PID)
}

ExperimentPostLaunchSetup() {
  [[ ${SAVE_CORPUS:-} == 1 ]] || SAVE_CORPUS=0;

  if [ -z "$1" ]; then
    echo 'Missing reference parameter for statsJSON' > /dev/stderr;
    return 1
  fi
  local -n ref_statsJSON=$1;
  shift;

  if [ -z "$1" ]; then
    echo 'Missing parameter tlspuffin_pid' > /dev/stderr;
    return 1
  fi
  local tlspuffin_pid="$1"
  shift
  if [ -z "$1" ]; then
    echo "Missing parameter to tell to save objectif or not"
    return 1
  fi
  local saveData="$1"
  shift;

  if [ -z "$1" ]; then
    echo 'Missing parameter features' > /dev/stderr;
    return 1
  fi
  local features="$1"
  shift

  local tlspuffin_outpath=""
  local experiment_base=""
  let count=0
  while (( count++ < 100 )); do
    kill -0 ${tlspuffin_pid} 2>/dev/null || {
      echo 'FATAL: process dead while looking for README.md' > /dev/stderr;
      return 1
    };

    if [[ -z "${experiment_base}" ]]; then
      tlspuffin_outpath=( ./experiments/* );
      if [[ "${tlspuffin_outpath[0]}" != "./experiments/*" ]]; then
        experiment_base="${tlspuffin_outpath[0]}";
        continue;
      fi
    else
      [ -e "${experiment_base}/README.md" ] && break;
    fi

    sleep 10;
  done
  [[ -z "${experiment_base}" ]] && return 1;
  CreateArtefact "${experiment_base}/README.md" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-README.md" "commit_id:${COMMIT_ID}" "features:${features}"

  let count=0
  while (( count++ < 30 )); do
    kill -0 ${tlspuffin_pid} 2>/dev/null || {
      echo 'FATAL: process dead while looking for stats.json' > /dev/stderr;
      return 1
    };

    if ref_statsJSON=$( FindFile "${experiment_base}" "stats.json" "log/stats.json" ); then
      CreateArtefact "${ref_statsJSON}" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-stats.json" "commit_id:${COMMIT_ID}" "features:${features}"
      CreateArtefact "${ref_statsJSON}.1" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-stats.json.1" "commit_id:${COMMIT_ID}" "features:${features}"
      break;
    fi

    sleep 10;
  done
  [ -z "${ref_statsJSON}" ] && {
    echo 'FATAL: No stats.json found' > /dev/stderr;
    return 1;
  }

  local tlspuffinLog
  if tlspuffinLog=$( FindFile "${experiment_base}" "tlspuffin.log" "log/tlspuffin.log" ); then
    CreateArtefact "${tlspuffinLog}" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-tlspuffin.log" "commit_id:${COMMIT_ID}" "features:${features}"
  else
    echo 'No tlspuffin.log found, will not be archived' > /dev/stderr
  fi
  local tlspuffinOut
  if tlspuffinOut=$( FindFile "${experiment_base}" "tlspuffin.out" "log/tlspuffin.out" ); then
    CreateArtefact "${tlspuffinOut}" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-tlspuffin.out" "commit_id:${COMMIT_ID}" "features:${features}"
  else
    echo 'No tlspuffin.out found, will not be archived' > /dev/stderr
  fi
  if [ -d './log' ]; then
    CreateArtefact "./log" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-log_root" "commit_id:${COMMIT_ID}" "features:${features}"
  else
    echo 'No root log directory found, will not be archived' | tee /dev/stderr
  fi
  if [ -d "./${experiment_base}/log" ]; then
    CreateArtefact "./${experiment_base}/log" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-log" "commit_id:${COMMIT_ID}" "features:${features}"
  else
    echo 'No log directory found, will not be archived' | tee /dev/stderr
  fi

  StartMonitor

  CreateArtefact "${experiment_base}/objective" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-objective" "commit_id:${COMMIT_ID}" "features:${features}"

  (( saveData && SAVE_CORPUS )) && 
      CreateArtefact "${experiment_base}/corpus" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-corpus" "commit_id:${COMMIT_ID}" "features:${features}"

  ln -sfn "./${experiment_base}/log" ./current_log

  return 0;
}

ExperimentReport() {
  local tlspuffin_outpath=$( ls experiments/ )
  local experiment_base="./experiments/${tlspuffin_outpath}"
  if statsJSON=$( FindFile "${experiment_base}" "stats.json" "log/stats.json" ); then
    read nbClients execPerSec <<< "$(
        tail -c 8192 "${statsJSON}" |\
        sed 's/}{/\n/g' |\
        grep '"type":"global"' |\
        sed 's/,/\n/g' |\
        awk -F: '
          $1 ~ /clients/      { clients=$2+0 }
          $1 ~ /exec_per_sec/ { exec=$2+0 }
          END { print clients, exec }
        '
    )"
    [[ "$nbClients" =~ ^[0-9]+$ ]] || nbClients=0;
    [[ "$execPerSec" =~ ^[0-9]+$ ]] || execPerSec=0;
    echo "{\"nb_cores\": ${THEJOB_NB_CORES}, \"nb_clients\": ${nbClients}, \"exec_per_sec\": ${execPerSec}}" >> "${THEJOB_USER_STATE_FILE}"
  fi

  local objective_dir="${experiment_base}/objective"
  if [ -d "$objective_dir" ]; then
    local objective_count=$(find "$objective_dir" -type f -name "*.trace" | wc -l)
    # Display the following if obejctive_count is greater than 0
    if [ "$objective_count" -gt 0 ]; then
      local last_objective=$(find "$objective_dir" -type f -name "*.trace" -printf "%T@ %Tc %p\n" | sort -nr 2>/dev/null | head -n1 | cut -d' ' -f2-)
      local last_objective_time=$(find "$objective_dir" -type f -name "*.trace" -printf "%T@\n" | sort -nr 2>/dev/null | head -n1 | cut -d. -f1)
      local now=$(date +%s)
      local last_objective_elapsed=$(( (now - last_objective_time) / 60 ))
      echo "{\"objective_count\": ${objective_count}, \"last_modified\": ${last_objective_elapsed}, \"last_objective\": \"${last_objective}\"}" >> "${THEJOB_USER_STATE_FILE}"
    else
      echo "{\"objective_count\": 0}" >> "${THEJOB_USER_STATE_FILE}"
    fi
  else
    echo "{\"objective_error\": \"Directory ${objective_dir} not found\"}" >> "${THEJOB_USER_STATE_FILE}"
  fi
}

ExperimentEndCommon() {
  [ -r "./.reserved_port.pid" ] && kill $( cat ./.reserved_port.pid )
  ipcrm --all
  ExperimentReport
}

ExperimentRun() {
  if [ -z "${AFL_CORES_GRAMMAR:+x}" ]; then
    echo "Missing global variable AFL_CORES_GRAMMAR"
    return 1;
  fi
  if [ -z "$1" ]; then
    echo "Missing reference parameter tlspuffin_pid"
    return 1;
  fi
  local -n ref_tlspuffin_pid=$1;
  shift;
  if [ -z "$1" ]; then
    echo "Missing reference parameter tlspuffin_killed"
    return 1;
  fi
  local -n ref_tlspuffin_killed=$1;
  shift;
  if [ -z "$1" ]; then
    echo "Missing reference parameter for stats"
    return 1
  fi
  local -n ref_stats=$1;
  shift;
  if [ -z "$1" ]; then
    echo "Missing parameter to tell to save objectif or not"
    return 1
  fi
  local saveData="$1"
  shift;


  if [ -z "${features}" ] && [ -z "${vendor}" ]; then
    echo "Missing required global variable: features | vendor"
    return 1;
  fi
  if [ -z "${experiment}" ]; then
    echo "Missing required global variable: experiment"
    return 1;
  fi

  local binary="";
  local last_core=0;
  ExperimentSetup binary last_core "${features}" || return 1;
  local cores="";
  (( AFL_CORES_GRAMMAR == 0 )) && cores="0-${last_core}" || cores="${THEJOB_CORES}"
  nix-shell --run "exec ${PREFIX_FAKETIME} \"${binary}\" --cores ${cores} --port ${RESERVED_PORT} ${extra_flags} experiment -d \"${experiment}\" -t \"${experiment}\"" &
  ref_tlspuffin_pid=$!

  ref_tlspuffin_killed=0
  if ! ExperimentPostLaunchSetup ref_stats "${ref_tlspuffin_pid}" "${saveData}" "${features}"; then
    kill -9 "${ref_tlspuffin_pid}" 2>/dev/null;
    ref_tlspuffin_killed=1
  fi

  return 0;
}

ExperimentRunWithCargo() {
  if [ -z "${AFL_CORES_GRAMMAR:+x}" ]; then
    echo "Missing global variable AFL_CORES_GRAMMAR"
    return 1;
  fi

  if [ -z "$1" ]; then
    echo "Missing reference parameter tlspuffin_pid"
    return 1;
  fi
  local -n ref_tlspuffin_pid=$1;
  shift;
  if [ -z "$1" ]; then
    echo "Missing reference parameter tlspuffin_killed"
    return 1;
  fi
  local -n ref_tlspuffin_killed=$1;
  shift;
  if [ -z "$1" ]; then
    echo "Missing reference parameter for stats"
    return 1
  fi
  local -n ref_stats=$1;
  shift;
  if [ -z "$1" ]; then
    echo "Missing parameter to tell to save objectif or not"
    return 1
  fi
  local saveData="$1"
  shift;

  if [ -z "${features}" ] && [ -z "${vendor}" ]; then
    echo "Missing required global variable: features | vendor"
    return 1
  fi
  if [ -z "${experiment}" ]; then
    echo "Missing required global variable: experiment"
    return 1
  fi

  local last_core=0;
  ExperimentSetupForCargo last_core features || return 1;
  local cores="";
  (( AFL_CORES_GRAMMAR == 0 )) && cores="0-${last_core}" || cores="${THEJOB_CORES}"
  echo "nix-shell --run exec ${PREFIX_FAKETIME} cargo run --bin tlspuffin --release --features=${features} -- --cores ${cores} --port ${RESERVED_PORT} ${extra_flags} experiment -d \"${experiment}\" -t \"${experiment}\""
  nix-shell --run "exec ${PREFIX_FAKETIME} cargo run --bin tlspuffin --release --features=${features} -- --cores ${cores} --port ${RESERVED_PORT} ${extra_flags} experiment -d \"${experiment}\" -t \"${experiment}\"" &
  ref_tlspuffin_pid=$!
  echo "tlspuffin monitored pid is ${ref_tlspuffin_pid}" >&2

  ref_tlspuffin_killed=0
  if ! ExperimentPostLaunchSetup ref_stats "${ref_tlspuffin_pid}" "${saveData}" "${features}"; then
    echo "KILLING tlspuffin, experiment post launch setup failed" >&2
    kill -9 "${ref_tlspuffin_pid}" 2>/dev/null;
    ref_tlspuffin_killed=1
  fi

  return 0;
}

#### HELPER END ####

Init () {
  [ -z "${COMMIT_ID}" ] && COMMIT_ID="main"

  git clone https://github.com/tlspuffin/tlspuffin.git "${THEJOB_OUT_PATH}/repo" || return 1;

  cd "${THEJOB_OUT_PATH}/repo" || return 1;

  git checkout "${COMMIT_ID}" || return 1;

  if [ -z "${PREFIX_FAKETIME}" ]; then
#    local TLSPUFFIN_RUN_PREFIX="env FAKETIME='2022-12-24 00:00:00' \
#env LD_PRELOAD='/nix/store/vvflx70q27229r0glx2ld1ciw40rr11n-clang-wrapper-14.0.6/resource-root/lib/linux/libclang_rt.asan-x86_64.so:/nix/store/kwp6bhp67i63xpcn1xrrdrnq9ilr707l-libfaketime-0.9.10/lib/libfaketimeMT.so.1:/nix/store/kwp6bhp67i63xpcn1xrrdrnq9ilr707l-libfaketime-0.9.10/lib/libfaketime.so.1'\
#"
#    git merge-base --is-ancestor "${COMMIT_ID}" 8b29ce76d && PREFIX_FAKETIME="${TLSPUFFIN_RUN_PREFIX}" || PREFIX_FAKETIME=""
    git merge-base --is-ancestor "${COMMIT_ID}" 8b29ce76d && PREFIX_FAKETIME="faketime 2022-12-24" || PREFIX_FAKETIME=""
    #AddGlobalParam PREFIX_FAKETIME "${PREFIX_FAKETIME}"
  fi
  if [ -n "${PREFIX_FAKETIME}" ]; then
    echo "Faketime setup to ${PREFIX_FAKETIME}";
  fi

  sed -i 's$\(.*url = \)git@github.com:tlspuffin$\1https://github.com/tlspuffin$' .gitmodules
  git submodule update --init --recursive || return 1;

  if [ ! -e "shell.nix" ]; then
    echo "Use provided shell.nix"
    cp "${THEJOB_USER_FILES_PATH}/shell.nix" . || return 1;
  else
    echo "Update shell.nix repo header"
    head -1 shell.nix
    sed -i 's${ pkgs ? import <nixpkgs> { } }:${ pkgs ? import (fetchTarball "https://github.com/NixOS/nixpkgs/archive/nixos-22.11.tar.gz") {} }:$' shell.nix
  fi

  if [ ! -z "${PREFIX_FAKETIME}" ]; then
    echo "Setup faketime in shell.nix"
    sed -i 's/\(.*nativeBuildInputs = \[.*\)/\1\n    pkgs.libfaketime/' shell.nix || return 1
  fi

  [ -r "tlspuffin/harness/wolfssl/src/put.c" ] &&
    ! grep -q MyTimeoutCallBack "tlspuffin/harness/wolfssl/src/put.c" &&
    patch --dry-run "tlspuffin/harness/wolfssl/src/put.c" < "${THEJOB_USER_FILES_PATH}/wolfssl_put.c.patch" &&
    patch "tlspuffin/harness/wolfssl/src/put.c" < "${THEJOB_USER_FILES_PATH}/wolfssl_put.c.patch"

  #nix-shell --run cargo >/dev/null 2>/dev/null || return 1;
  LIBAFL_VER=$( nix-shell --run "cd puffin; cargo pkgid libafl" | grep -i libafl | sed 's/.*@//' );
  echo -e "${LIBAFL_VER}\n0.15.3" | sort -V | tail -1 | grep -Fxq 0.15.3;
  AFL_CORES_GRAMMAR=$?
  AddGlobalParam AFL_CORES_GRAMMAR "${AFL_CORES_GRAMMAR}"

  return 0;
}

Build() {
  if [ -z "${features}" ] && [ -z "${vendor}" ]; then
    echo "Missing required global variable: features | vendor"
    return 1
  fi
  if [ -z "${experiment}" ]; then
    echo "Missing required global variable: experiment"
    return 1
  fi

  local cputs=false
  ComputeBuildRuntimeInfo "${vendor}" features cputs || {
      echo "Failed to compute runtime info for vendor '${vendor}' '${features}'"
      return 1;
  }

  [ -z "${COMMIT_ID}" ] && COMMIT_ID="main"
  md5sum_res=$( echo "tlspuffin-${COMMIT_ID}-${features}-${vendor}" | md5sum )
  cache_id="tlspuffin-${md5sum_res%% *}"
  echo "tlspuffin-${COMMIT_ID}-${features}-${vendor} = ${cache_id}"
  cache_ok=1
  if [[ "${COMMIT_ID}" != "main" ]]; then
    binary=$( QueryCache -q "${cache_id}" )
    cache_ok=$?
  fi
  if [[ $cache_ok -ne 0 ]]; then
    cp -apr "${THEJOB_OUT_PATH}/repo" . || return 1;
    cd repo || return 1;
    if ${cputs}; then
      nix-shell --run "./tools/mk_vendor make '${vendor}'"
    fi
    nix-shell --run "cargo build --bin tlspuffin --release --features=${features} -j ${THEJOB_NB_CORES}" || return 1
    binary=$( realpath ./target/release/tlspuffin )
    SetCache "${cache_id}" "${binary}"
  else
    echo "Found in cache"
  fi
  cp "${binary}" "${THEJOB_OUT_PATH}/tlspuffin-${THEJOB_STEP_ID}" || return 1;

  return 0
}

ForcedBuild() {
  if [ -z "${features}" ] && [ -z "${vendor}" ]; then
    echo "Missing required global variable: features | vendor"
    return 1
  fi
  if [ -z "${experiment}" ]; then
    echo "Missing required global variable: experiment"
    return 1
  fi

  cp -apr "${THEJOB_OUT_PATH}/repo/." . || return 1;

  local cputs=false
  ComputeBuildRuntimeInfo "${vendor}" features cputs || {
      echo "Failed to compute runtime info for vendor '${vendor}' '${features}'"
      return 1;
  }

  if ${cputs}; then
    rm -rf ./vendor
    nix-shell --run "./tools/mk_vendor make '${vendor}'"
  fi

  rm -rf ./seeds
  echo "nix-shell --run \"cargo run --release --bin tlspuffin --features=${features} -j ${THEJOB_NB_CORES} -- seed\""
  nix-shell --run "cargo run --release --bin tlspuffin --features=${features} -j ${THEJOB_NB_CORES} -- seed" || return 1;

  rm -rf ./experiments
  echo "nix-shell --run \"exec ${PREFIX_FAKETIME} cargo run --bin tlspuffin --release --features=${features} -- help\""
  nix-shell --run "exec ${PREFIX_FAKETIME} cargo run --bin tlspuffin --release --features=${features} -- help" || return 1
}

Clean() {
  rm -rf "${THEJOB_OUT_PATH}/repo"
}

CleanAllRepo() {
  ipcrm --all
  rm -rf "${THEJOB_OUT_PATH}/repo*"
}

MonitorExperiment() {
  local outfile="$1";
  if [ -z "${outfile}" ]; then
    echo "Missing outfile"
    return 1;
  fi
  shift;

  local now=$(date +%s)

  local tlspuffin_outpath=$( ls experiments/ )
  exp="./experiments/${tlspuffin_outpath}"

  local old_tlspuffin=false
  local README="$exp/README.md"
  local stats_file="$exp/log/stats.json"
  # if stat_file does not exists then look for the file at $exp/stats.json (as in older versions of puffin)
  if [ ! -f "$stats_file" ]; then
    stats_file="$exp/stats.json"
    old_tlspuffin=true
  fi
  if [ -f "$stats_file" ]; then
    # Last modified time in epoch seconds
    local mod_time=$(stat -c %Y "$stats_file")
    local elapsed=$((now - mod_time))

    local exp_name=$(basename "$exp")
    echo -n "# Experiment: $exp_name" >> ${outfile}
    if [ -f "$README" ]; then
      local port=$(head -n 100 "$README" | grep "Port:" | cut -d' ' -f2-)
      echo -n "  ${port}" >> ${outfile}
    fi
    echo -e "\n  Time since last stats.json update: ${elapsed}s" >> ${outfile}

    if ! ${old_tlspuffin}; then
      # Default PUT info from log
      local log_file="$exp/log/stats_puffin_main_broker.log"
      if [ -f "$log_file" ]; then
        local default_put=$(head -n 100 "$log_file" | grep "Default PUT:" | head -n1 | sed 's/^[ \t]*//' | cut -d' ' -f2-)
        if [ -n "$default_put" ]; then
          echo "  $default_put" >> ${outfile}
        else
          if [ -f "$README" ]; then
            default_put=$(head -n 100 "$README" | grep "Default PUT:" | cut -d' ' -f2-)
            echo "  ${default_put} (asan?)" >> ${outfile}
          else
            echo "   Could not find default PUT in README or ./log/stats_puffin_main_broker.log" >> ${outfile}
          fi
        fi
      else
        echo "  Log file not found: $log_file" >> ${outfile}
      fi
    fi

    # Corpus info
    local corpus_dir="$exp/corpus"
    if [ -d "$corpus_dir" ]; then
      local corpus_count=$(find "$corpus_dir" -type f -name "*.trace" | wc -l)
      local last_corpus=$(find "$corpus_dir" -type f -name "*.trace" -printf "%T@ %Tc\n" | sort -nr 2>/dev/null | head -n1 | cut -d' ' -f2-)
      local last_corpus_time=$(find "$corpus_dir" -type f -name "*.trace" -printf "%T@\n" | sort -nr 2>/dev/null | head -n1 | cut -d. -f1)
      now=$(date +%s)
      local last_corpus_elapsed=$(( (now - last_corpus_time) / 60 ))
      echo "  Corpus: $corpus_count file(s), last modified: $last_corpus_elapsed minutes ago - $last_corpus" >> ${outfile}
    else
      echo "  Corpus: Directory not found" >> ${outfile}
    fi

    # Error log
    if ! ${old_tlspuffin}; then
      local log_file="$exp/log/error.log"
      if [ -f "$log_file" ]; then
        if [ -s "$log_file" ]; then
          echo -n "   --> ❌ Errors while fuzzing: " >> ${outfile}
          local nb_errors=$(grep -c ERROR "$log_file")
          echo -n "${nb_errors} errors, " >> ${outfile}
          local nb_crashes=$(grep -c CRASH "$log_file")
          echo "${nb_crashes} crashes" >> ${outfile}
          local last_lines=$(grep ERROR "$log_file" | grep "\[" | tail -n 1  | cut -c1-180)
          if [ -n "$last_lines" ]; then
            echo "  $last_lines" >> ${outfile}
          fi
        else
          echo "    No error ✅" >> ${outfile}
        fi
      else
        echo "  Log file not found: $log_file" >> ${outfile}
      fi
    fi

    # Objective info
    local objective_dir="$exp/objective"
    if [ -d "$objective_dir" ]; then
      local objective_count=$(find "$objective_dir" -type f -name "*.trace" | wc -l)
      # Display the following if obejctive_count is greater than 0
      if [ "$objective_count" -gt 0 ]; then
        local last_objective=$(find "$objective_dir" -type f -name "*.trace" -printf "%T@ %Tc %p\n" | sort -nr 2>/dev/null | head -n1 | cut -d' ' -f2-)
        local last_objective_time=$(find "$objective_dir" -type f -name "*.trace" -printf "%T@\n" | sort -nr 2>/dev/null | head -n1 | cut -d. -f1)
        local now=$(date +%s)
        local last_objective_elapsed=$(( (now - last_objective_time) / 60 ))
        echo "    ==> 🎉 Objective: $objective_count file(s), last modified: $last_objective_elapsed minutes ago - $last_objective" >> ${outfile}
      else
        echo "    No objective yet ✓" >> ${outfile}
      fi
    else
      echo "  Objective: Directory not found" >> ${outfile}
    fi
    echo "" >> ${outfile}
  fi
}
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
  [ -r "${THEJOB_OUT_PATH}/cli-${THEJOB_STEP_ID}.json" ] && cat "${THEJOB_OUT_PATH}/cli-${THEJOB_STEP_ID}.json" >> "${output}" || echo "Missing \"${THEJOB_OUT_PATH}/cli-${THEJOB_STEP_ID}.json\"" >&2

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
