#### HELPER START ####

SaveSummary() {
  local oldfilesize=$1; shift;
  local stats="$1"; shift;
  local output="$1"; shift;

  local old_summary=""
  [ -f "${output}" ] && old_summary=$( cat "${output}" )

  (( oldfilesize > 1024 )) && (( oldfilesize -= 1024 ))
  local summary=$( dd bs=10M iflag=skip_bytes if="${stats}" skip="${oldfilesize}" status=none | 
    awk 'BEGIN{ RS="}{"; nb=0; } {
      line = $0
      if (line !~ /^{/) line = "{" line
      if (line !~ /}$/) line = line "}"

      if (line ~ /"type":"global"/) {
        global_0 = global_1
        global_1 = line
      } else if (line ~ /"type":"client"/) {
        if (match(line, /"id": *[0-9]+/)) {
          id = substr(line, RSTART, RLENGTH)
          gsub(/[^0-9]/, "", id); if (id > nb) { nb = id };
          clients_0[id] = clients_1[id]
          clients_1[id] = line
        }
      }
    }
    END {
      if (global_1) print global_1
      if (global_0) print global_0

      for (id = 1; id <= nb; id++) {
        if (clients_1[id]) print clients_1[id]
        if (clients_0[id]) print clients_0[id]
      }
    }' | jq -c '.' 2>/dev/null | jq -s 'group_by(.type, .id // 0) | map(first) | .[]' )

  local merged=$( {
    echo "$summary"
    echo "$old_summary"
  } | jq -c '.' 2>/dev/null | jq -s 'group_by(.type, .id // 0) | map(first) | .[]' )

  echo "${merged}" | jq -c '.' > "${output}"
}

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
      ref_problems=" -1 ";
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
  local tlspuffin_pid="$1"; shift;
  local stats="$1"; shift;

  local statssize=0;
  local lastcheck=0;
  local nbissues=0;
  local problems='';
  while true; do
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
  shift
  local file_patterns=("$@")

  for pattern in "${file_patterns[@]}"; do
    local full_path="${base_path}/${pattern}"
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
  if ! ${refcputs}; then
    for i in $( echo "${ref_features}" | sed 's/\([^,]\)[,$]/\1\n/g' ); do
      grep -E -q "^[[:space:]]*${i}[[:space:]]*=" "${THEJOB_OUT_PATH}/repo/tlspuffin/Cargo.toml" || {
        echo "Unsupported feature $i";
        return 1;
      }
    done
  fi

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
    echo "Missing parameter feature"
    return 1
  fi
  local features="$1";
  shift

  [ -z "${PREFIX_FAKETIME}" ] && PREFIX_FAKETIME="" || echo "Using faketime"
  ref_last_core=$(( THEJOB_NB_CORES - 1 ))

  # disable this if preload is set to load asan and faketime
  [ ! -z "${PREFIX_FAKETIME}" ] && echo "${features}" | grep -qi asan && PREFIX_FAKETIME="" && echo "Disable faketime, asan used"

  local cputs=false
  ComputeBuildRuntimeInfo "${vendor}" features cputs || {
      echo "Failed to compute runtime info for vendor '${vendor}' '${features}'"
      return 1;
  }
  if ${cputs}; then
    echo "{ \"cputs\": true, \"features\": \"${vendor}\" }" > "${THEJOB_USER_STATE_FILE}";
  else
    echo "{ \"cputs\": false, \"features\": \"${features}\" }" > "${THEJOB_USER_STATE_FILE}";
  fi

  eval $( ${THEJOB_TOOLS_PATH}/reserve_port ) || return 1; # reserve a tcp port on if 127.0.0.1 (RESERVED_PORT, RESERVED_PORT_PID)
}

ExperimentPostLaunchSetup() {
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
  local saveObjectif="$1"
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
  while (( count++ < 30 )); do
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
      (( saveObjectif == 0 )) && CreateArtefact "${ref_statsJSON}" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-stats.json" "commit_id:${COMMIT_ID}" "features:${features}"
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
    echo 'No root log directory found, will not be archived' > tee /dev/stderr
  fi
  if [ -d "./${experiment_base}/log" ]; then
    CreateArtefact "./${experiment_base}/log" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-log_root" "commit_id:${COMMIT_ID}" "features:${features}"
  else
    echo 'No log directory found, will not be archived' > tee /dev/stderr
  fi

  StartMonitor

  if (( saveObjectif == 1 )); then
    CreateArtefact "${experiment_base}/objective" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-objective" "commit_id:${COMMIT_ID}" "features:${features}"
  fi

  return 0;
}

ExperimentReport() {
  local tlspuffin_outpath=$( ls experiments/ )
  local experiment_base="./experiments/${tlspuffin_outpath}"
  if statsJSON=$( FindFile "${experiment_base}" "stats.json" "log/stats.json" ); then
    echo "${THEJOB_NB_CORES} $( tail -c 8192 "${statsJSON}" | sed 's/}{/\n/g' | grep '"type":"global"' | sed 's/,/\n/g' | awk -F: ' $1 ~ /clients/ { clients=$2+0 } $1 ~ /exec_per_sec/ { exec=$2+0 } END { print clients, exec }' )" > "${THEJOB_USER_STATE_FILE}"
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
      echo "🎉 Objective: $objective_count file(s), last modified: $last_objective_elapsed minutes ago - $last_objective" >> "${THEJOB_USER_STATE_FILE}"
    else
      echo "No objective yet ✓" >> "${THEJOB_USER_STATE_FILE}"
    fi
  else
    echo "Objective: Directory ${objective_dir} not found" >> "${THEJOB_USER_STATE_FILE}"
  fi
}

ExperimentEnd() {
  kill ${RESERVED_PORT_PID}
  ipcrm --all
  ExperimentReport
}

ExperimentRun() {
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
  local saveObjectif="$1"
  shift;


  if [ -z "${features}" ]; then
    echo "Missing required global variable: features"
    return 1;
  fi
  if [ -z "${experiment}" ]; then
    echo "Missing required global variable: experiment"
    return 1;
  fi

  local binary="";
  local last_core=0;
  ExperimentSetup binary last_core "${features}" || return 1;

  nix-shell --run "exec ${PREFIX_FAKETIME} \"${binary}\" --cores 0-${last_core} --port ${RESERVED_PORT} ${extra_flags} experiment -d \"${experiment}\" -t \"${experiment}\"" &
  ref_tlspuffin_pid=$!

  ref_tlspuffin_killed=0
  if ! ExperimentPostLaunchSetup ref_stats "${ref_tlspuffin_pid}" "${saveObjectif}" "${features}"; then
    kill -9 "${ref_tlspuffin_pid}" 2>/dev/null;
    ref_tlspuffin_killed=1
  fi

  return 0;
}

ExperimentRunWithCargo() {
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
  local saveObjectif="$1"
  shift;

  if [ -z "${features}" ]; then
    echo "Missing required global variable: features"
    return 1
  fi
  if [ -z "${experiment}" ]; then
    echo "Missing required global variable: experiment"
    return 1
  fi

  local last_core=0;
  ExperimentSetupForCargo last_core "${features}" || return 1;
  nix-shell --run "exec ${PREFIX_FAKETIME} cargo run --bin tlspuffin --release --features=${features} -- --cores 0-${last_core} --port ${RESERVED_PORT} ${extra_flags} experiment -d \"${experiment}\" -t \"${experiment}\"" &
  ref_tlspuffin_pid=$!

  ref_tlspuffin_killed=0
  if ! ExperimentPostLaunchSetup ref_stats "${ref_tlspuffin_pid}" "${saveObjectif}" "${features}"; then
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
    AddGlobalParam PREFIX_FAKETIME "${PREFIX_FAKETIME}"
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

  nix-shell --run cargo >/dev/null 2>/dev/null || return 1;

  return 0;
}

Build() {
  if [ -z "${features}" ]; then
    echo "Missing required global variable: features"
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
  if [ -z "${features}" ]; then
    echo "Missing required global variable: features"
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

  cp -apr "${THEJOB_OUT_PATH}/repo/." . || return 1;
  if ${cputs}; then
    nix-shell --run "./tools/mk_vendor make '${vendor}'"
  fi

  rm -rf seeds
  nix-shell --run "cargo run --release -p tlspuffin --features=${features} -j ${THEJOB_NB_CORES} -- seed" || return 1;

  nix-shell --run "cargo run --bin tlspuffin --release --features=${features} -j ${THEJOB_NB_CORES} -- help" || return 1

  rm -rf ./experiments
}

Clean() {
  rm -rf "${THEJOB_OUT_PATH}/repo"
}

CleanAllRepo() {
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

    if [ ! ${old_tlspuffin} ]; then
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
    if [ ! ${old_tlspuffin} ]; then
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

