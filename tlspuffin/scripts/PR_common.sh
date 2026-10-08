#### HELPER START ####

# Command prefix running the fuzzer without ASLR (inherited across fork/exec; setarch execs the command, so a
# background PID stays the fuzzer's): ASAN runtimes of LLVM < 18, used by older tlspuffin commits, crash at
# random at startup when the kernel uses more than 28 bits of mmap randomization (recent kernels: 32).
# Empty when setarch is unavailable or with COMPAT_DISABLE=no_aslr (or "all"), which runs the fuzzer with ASLR as
# before, e.g. to reproduce older results.
NoAslrPrefix() {
  CompatIsDisabled no_aslr && return 0;
  local arch;
  arch=$( uname -m );
  setarch "${arch}" -R true > /dev/null 2>&1 && echo "setarch ${arch} -R";
  return 0;
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

  local logsPath=$( dirname "${stats}" )
  local errorFile="${logsPath}/error.log"
  [ ! -e "${errorFile}" ] && { errorFile="${logsPath}/log/error.log"; [ ! -e "${errorFile}" ] && errorFile=""; }
  [ -e "${errorFile}" ] && grep -q "Timeout in fuzz run" "${errorFile}" && { echo "Timeout found in error.log" >&2; return 1; }

  local lastTS=$( "${THEJOB_TOOLS_PATH}/qjs" --std "${THEJOB_TOOLS_PATH}/js/get_last_stats_time.js" "${stats}" );
  local now; now=$( date +%s );
  # every check, kept next to the run (the step's stderr is a ring that loses the old lines): time of the check, last
  # stats time, size of the stats file
  echo "${now} ${lastTS:-none} $( stat --format=%s "${stats}" 2> /dev/null || echo 0 )" >> ./.vital_checks 2> /dev/null;
  if (( ref_lastcheck != 0 )); then
    local diffTS=$(( ${lastTS:-0} - ref_lastcheck ));
    echo "global ${lastTS} - ${ref_lastcheck} = ${diffTS}" >&2
    # a stuck fuzzer: its stats are older than 5 minutes. (The rule was "the stats moved more than 300 s since the
    # previous check": it never caught a stall, where they do not move, and it stopped healthy runs whose checks came
    # late, e.g. the 5 SKIP runs of 1791387599889: stats current, checks 41 min apart.)
    if [ -n "${lastTS}" ] && (( now - lastTS > 300 )); then
      echo "stats.json not updated for $(( now - lastTS )) s: the fuzzer is stuck, exit" >&2
      return 1;
    fi
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

  # the clients that reported since the last check, read from the new bytes until every client is seen: a chatty
  # fuzzer writes tens of MB a minute (a SKIP run: 50 MB, about one record per two executions), which this check,
  # on the cores of the run, parsed whole (0.9 s of CPU a minute); now it stops within the first records
  local found_ids=$( dd bs=10M iflag=skip_bytes if="${stats}" skip="${ref_oldfilesize}" status=none 2> /dev/null | awk -v n="${nb_clients}" 'BEGIN{RS="}{"} { if (match($0, /"id": *[0-9]+/)) { id = substr($0, RSTART, RLENGTH); gsub(/[^0-9]/, "", id); if (!(id in seen)) { seen[id] = 1; print id; if (id >= 1 && id <= n) found++ } if (found >= n) exit } }' | sort -u );
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

# LostClients <experiment dir>: how many crashed clients the fuzzer could not restart (its respawner gave up: LibAFL
# 0.11.2 "Storing state in crashed fuzzer instance did not work, no point to spawn the next client!", e.g. when a crash
# corrupted the client's memory); 0 when none. Such a client never comes back: its cores do nothing.
LostClients() {
  local f;
  for f in "$1/tlspuffin.out" "$1/log/tlspuffin.out"; do
    [ -r "${f}" ] && { grep -c "Storing state in crashed fuzzer instance did not work" "${f}"; return; };
  done
  echo 0;
}

function ExperimentCheckRun() {
  [[ ${DISABLE_KILL_ON_HANG:-} == 1 ]] || DISABLE_KILL_ON_HANG=0;

  local tlspuffin_pid="$1"; shift;
  local stats="$1"; shift;

  local statssize=0;
  local lastcheck=0;
  local nbissues=0;
  local problems='';
  # the bench's own checks share the run's cores with the fuzzer: lowest priority (nice 19, never starved), so that
  # they never take CPU from it; the fuzzer, started before, keeps its priority
  renice -n 19 -p "${BASHPID}" > /dev/null 2>&1;
  while true; do

    if (( DISABLE_KILL_ON_HANG == 1)); then
      if ! kill -0 ${tlspuffin_pid} 2>/dev/null; then
        echo "process ${tlspuffin_pid} dead, exit" >&2
        break;
      fi
    else

      echo "ExperimentCheckRun..." >&2
      # a client the fuzzer could not restart never comes back: no need to wait for 5 checks without its stats
      local expDir; expDir=$( dirname "${stats}" ); [ "$( basename "${expDir}" )" == log ] && expDir=$( dirname "${expDir}" );
      local lost; lost=$( LostClients "${expDir}" );
      if (( lost > 0 )); then
        echo "Client(s) lost after a crash: the fuzzer could not restart ${lost} of them (\"Storing state in crashed fuzzer instance did not work\"), end of the experiment" >&2;
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

# What an experiment built, in words: the step arguments give both a vendor preset (C harness, used when the
# commit has that preset and the cputs feature) and features (Rust harness, the fallback), so the arguments alone
# do not tell which library version ran. Usage: BuildDescription <cputs> <vendor> <features> <library> <version>
# e.g. "C harness, wolfssl580-asan" or "Rust harness, wolfssl540 (vendor wolfssl580-asan not available at this commit)".
# Mirrored for older results (no "build" in cli-<library>.json) by summary_render.js and objectives_report.sh.
BuildDescription() {
  local cputs="$1" vendor="$2" features="$3" library="$4" version="$5";
  if [ "${cputs}" == true ]; then
    echo "C harness, ${vendor#*:}";
    return 0;
  fi
  local desc="Rust harness, features ${features}";
  [ -n "${library}" ] && [ "${library}" != 'NA' ] && desc="Rust harness, ${library}${version}";
  [ -n "${vendor}" ] && desc+=" (vendor ${vendor#*:} not available at this commit)";
  echo "${desc}";
}

ComputeBuildRuntimeInfo() {
  if [ -z "$1" ]; then
    echo "Missing package parameter"
    return 1;
  fi
  local package=$1;
  shift;

  if [ ! -e "${THEJOB_OUT_PATH}/repo/${package}/Cargo.toml" ]; then
    echo "Missing required file ${THEJOB_OUT_PATH}/repo/${package}/Cargo.toml"
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
          { [[ "${package}" != "tlspuffin" ]] || grep -E -q "^[[:space:]]*cputs[[:space:]]*=" "${THEJOB_OUT_PATH}/repo/${package}/Cargo.toml"; } && {
            refcputs=true;
            [[ "${package}" == "tlspuffin" ]] && ref_features='cputs';
          }
    fi
  fi
  CompatBuildRules "${package}" "${vendor}" "${refcputs}" ref_features || return 1;
  if [ -n "${required_features}" ]; then
    ref_features="${required_features},${ref_features}"
  fi
  for i in $( echo "${ref_features}" | sed 's/\([^,]\)[,$]/\1\n/g' ); do
    grep -E -q "^[[:space:]]*${i}[[:space:]]*=" "${THEJOB_OUT_PATH}/repo/${package}/Cargo.toml" || {
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

  [ -z "${PACKAGE}" ] && PACKAGE="tlspuffin"

  [ -z "${COMMIT_ID}" ] && COMMIT_ID="main"
  [ -z "${PREFIX_FAKETIME}" ] && PREFIX_FAKETIME="" || echo "Using faketime"
  ref_binary="${THEJOB_OUT_PATH}/${PACKAGE}-${THEJOB_STEP_ID}"
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

  $( NoAslrPrefix ) nix-shell --run "\"${ref_binary}\" seed" || return 1;

  rm -rf ./experiments

  eval $( ${THEJOB_TOOLS_PATH}/reserve_port ) || return 1; # reserve a tcp port on if 127.0.0.1 (RESERVED_PORT, RESERVED_PORT_PID)
  echo "${RESERVED_PORT_PID}" > ./.reserved_port.pid
}

ExperimentSetupForCargo() {
  ipcrm --all

  [ -z "${vendor}" ] && vendor=

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

  [ -z "${PACKAGE}" ] && PACKAGE="tlspuffin"

  local featureLib=${ref_esfc_features};

  [ -z "${PREFIX_FAKETIME}" ] && PREFIX_FAKETIME="" || echo "Using faketime"
  ref_last_core=$(( THEJOB_NB_CORES - 1 ))

  # disable this if preload is set to load asan and faketime
  [ ! -z "${PREFIX_FAKETIME}" ] && echo "${ref_esfc_features}" | grep -qi asan && PREFIX_FAKETIME="" && echo "Disable faketime, asan used"

  local cputs=false
  ComputeBuildRuntimeInfo "${PACKAGE}" "${vendor}" ref_esfc_features cputs || {
      echo "Failed to compute runtime info for vendor '${vendor}' '${ref_esfc_features}'"
      return 1;
  }

  local library=$( echo "${vendor}" | cut -d: -f1 )
  local library_version='NA'
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
      library=$( echo "${featureLib}" | sed 's/[0-9][0-9]*.*//' )
      if [ -n "${library}" ]; then
        library_version=$( echo "${featureLib}" | sed "s/${library}//" )
        if [ -z "${library_version}" ]; then
          if [ "${library}" == "libressl" ]; then
            library_version='333'
          else
            library_version='NA'
          fi
        fi
      else
        library='NA';
      fi
    fi
  fi

  local asanInfo='';
  if [ -s ./.asan_info.json ]; then
    asanInfo=$( < ./.asan_info.json );
  else
    DetectAsan "./target/release/${PACKAGE}" "${ref_esfc_features}" "${vendor}" asanInfo || asanInfo='null';
  fi

  local vendorSources='null';
  [ -s ./.vendor_sources.json ] && vendorSources=$( < ./.vendor_sources.json );
  # the CVEs tlspuffin declares for this build (DetectVendorVulnerabilities, ForcedBuild)
  local vendorVulnerabilities='null';
  [ -s ./.vendor_vulnerabilities.json ] && vendorVulnerabilities=$( < ./.vendor_vulnerabilities.json );

  local build;
  build=$( BuildDescription "${cputs}" "${vendor}" "${ref_esfc_features}" "${library}" "${library_version}" );
  echo "${build}" > ./.build_info;
  echo "Build: ${build}";

  local jsonCompilInfos="{ \"package\": \"${PACKAGE}\", \"cputs\": ${cputs}, \"vendor\": \"${vendor}\", \"features\": \"${ref_esfc_features}\", \"flags\": \"${extra_flags}\", \"library\": { \"name\": \"${library}\", \"version\": \"${library_version}\" }, \"build\": \"${build}\", \"asan\": ${asanInfo}, \"aslr\": $( [ -n "$( NoAslrPrefix )" ] && echo false || echo true ), \"compat\": $( CompatAppliedJSON ), \"compat_warning\": $( CompatWarningJSON ), \"vendor_sources\": ${vendorSources}, \"vulnerabilities\": ${vendorVulnerabilities} }";
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
      # the vital checks of the run (ExperimentCheckAllThreadsRunning: time, last stats time, size), to see late checks
      [ -s ./.vital_checks ] && CreateArtefact ./.vital_checks "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-vital_checks.txt" "commit_id:${COMMIT_ID}" "features:${features}"
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
  if [ -z "$1" ]; then
    echo "Missing experimentUUID ref parameter"
    return 1;
  fi
  local -n ref_experimentUUID=$1;
  shift;

  if [ -z "$1" ]; then
    echo "Missing experiment_base ref parameter"
    return 1;
  fi
  local -n ref_experiment_base=$1;
  shift;

  if [ -z "$1" ]; then
    echo "Missing objective_count ref parameter"
    return 1;
  fi
  local -n ref_objective_count=$1;
  shift;

  ref_experimentUUID=
  [ -r "./.thejob_uuid" ] && ref_experimentUUID=$( cat ./.thejob_uuid )
  if [ -n "${ref_experimentUUID}" ]; then
    curl -sf "${THEJOB_API_URL}/task/${THEJOB_TASK_ID}/state" -o "task.json" || {
      echo "{\"error\": \"fail curl -sf \\\"${THEJOB_API_URL}/task/${THEJOB_TASK_ID}/state\\\" -o \\\"task.json\\\"\"}" \
          | tee -a "${THEJOB_USER_STATE_FILE}" >&2
      return 1
    }
  else
    echo '{"error": "missing or invalid .thejob_uuid"}' | tee -a "${THEJOB_USER_STATE_FILE}" >&2
    return 1
  fi

  local tlspuffin_outpath=$( ls experiments/ )
  ref_experiment_base="./experiments/${tlspuffin_outpath}"

  ref_objective_count=0
  local objective_dir="${ref_experiment_base}/objective"
  if [ -d "$objective_dir" ]; then
    ref_objective_count=$(find "$objective_dir" -type f -name "*.trace" ! -name ".*" | wc -l)
    # Display the following if obejctive_count is greater than 0
    if [ "${ref_objective_count}" -gt 0 ]; then
      local last_objective=$(find "$objective_dir" -type f -name "*.trace" ! -name ".*" -printf "%T@ %Tc %p\n" | sort -nr 2>/dev/null | head -n1 | cut -d' ' -f2-)
      local last_objective_time=$(find "$objective_dir" -type f -name "*.trace" ! -name ".*" -printf "%T@\n" | sort -nr 2>/dev/null | head -n1 | cut -d. -f1)
      local now=$(date +%s)
      local last_objective_elapsed=$(( (now - last_objective_time) / 60 ))
      echo "{\"objective_count\": ${ref_objective_count}, \"last_modified\": ${last_objective_elapsed}, \"last_objective\": \"${last_objective}\"}" >> "${THEJOB_USER_STATE_FILE}"
    else
      echo "{\"objective_count\": 0}" >> "${THEJOB_USER_STATE_FILE}"
    fi
  else
    echo "{\"objective_error\": \"Directory ${objective_dir} not found\"}" >> "${THEJOB_USER_STATE_FILE}"
  fi
}

# ASAN status of a built binary, as a JSON record in the referenced variable.
# Checked on the binary itself (the "Running with shared ASAN support" message of tlspuffin is
# logged before its logger is set up, so it never reaches the logs):
#   - instrumented code: references to __asan_report_* (the C library under test was built with ASAN)
#   - runtime: shared (ldd lists libclang_rt.asan / libasan) or static (__asan_init defined)
# instrumented is null when the tools are missing or the binary is not found.
DetectAsan() {
  local binary="$1";
  local features="$2";
  local vendor="$3";
  if [ -z "$4" ]; then
    echo "Missing reference parameter for asan info";
    return 1;
  fi
  local -n ref_asan=$4;

  local requested=false;
  [[ ",${features}," == *",asan,"* || "${vendor}" == *-asan* ]] && requested=true;

  local instrumented=null;
  local runtime='unknown';
  local reports=0;
  if [ -x "${binary}" ] && command -v readelf > /dev/null && command -v ldd > /dev/null; then
    local symbols=$( readelf -Ws "${binary}" 2>/dev/null );
    reports=$( grep -c '__asan_report_' <<< "${symbols}" );
    if ldd "${binary}" 2>/dev/null | grep -q -E 'libclang_rt\.asan|libasan'; then
      runtime='shared';
    elif awk '$8 == "__asan_init" && $7 != "UND" { found = 1 } END { exit !found }' <<< "${symbols}"; then
      runtime='static';
    else
      runtime='none';
    fi
    (( reports > 0 )) && [ "${runtime}" != 'none' ] && instrumented=true || instrumented=false;
  fi

  ref_asan="{ \"requested\": ${requested}, \"instrumented\": ${instrumented}, \"runtime\": \"${runtime}\", \"asan_report_refs\": ${reports}, \"method\": \"readelf+ldd\" }";
}

# Size of a rolled log file: every tlspuffin log config rolls its files at 10 MB
LOG_ROLL_SIZE_BYTES=$(( 10 * 1024 * 1024 ))

# Log volume of an experiment, as a JSON record in the referenced variable.
# Rotation bounds the size on disk, so the volume written is estimated: live files plus one
# rolling size per compressed archive. Non-empty debug/trace/terms logs (and "puffin.N.gz", the
# debug archives of the modular-logging config) mean logging below INFO was active.
# The broker's monitor log (stats_puffin_main_broker.log* and its rotations ./log<N>, the periodic
# client statistics of tlspuffin's StatsMonitor) grows with the run time and the number of clients,
# not with the log level: recorded separately ("monitor_mb"), not counted in the estimate.
# The volume is compared per hour of run and per fuzzing core (start and cores saved by ExperimentSaveLaunchInfo,
# end = last write of a counted log), so that runs of any length and width are judged alike: warns above
# LOG_WARN_MB_PER_CORE_HOUR (task argument, default 15, i.e. 50 MB for a 70 min run on 3 cores, about 10x dev),
# or above LOG_WARN_MB MB in total when that task argument is given, or when verbose logs are present.
ExperimentLogStats() {
  local experiment_base="$1";
  shift;
  if [ -z "$1" ]; then
    echo "Missing reference parameter for log stats";
    return 1;
  fi
  local -n ref_logstats=$1;
  shift;

  [[ ${LOG_WARN_MB_PER_CORE_HOUR:-} =~ ^[0-9]+$ ]] || LOG_WARN_MB_PER_CORE_HOUR=15;
  local warnTotalMB='';
  [[ ${LOG_WARN_MB:-} =~ ^[0-9]+$ ]] && warnTotalMB="${LOG_WARN_MB}";

  # start of the run and its fuzzing cores
  local start='' cores='';
  [ -r ./.experiment_launch ] && read -r start cores < ./.experiment_launch;
  [[ ${start} =~ ^[0-9]+$ ]] || start=$( stat --format=%Y "${experiment_base}/README.md" 2> /dev/null );
  [[ ${cores} =~ ^[0-9]+$ ]] && (( cores > 0 )) || cores="${THEJOB_NB_CORES:-1}";
  [[ ${cores} =~ ^[0-9]+$ ]] && (( cores > 0 )) || cores=1;

  local -a dirs=( ./log );
  [ -n "${experiment_base}" ] && dirs+=( "${experiment_base}/log" );

  local bytes=0 estimated=0 files=0 rolled=0 verbose='' monitor=0 end=0;
  local file name size rollSize mtime;
  while IFS= read -r -d '' file; do
    name=$( basename "${file}" );
    [[ "${name}" == stats.json* ]] && continue;
    size=$( stat --format=%s "${file}" ) || continue;
    rollSize=$(( size > LOG_ROLL_SIZE_BYTES ? size : LOG_ROLL_SIZE_BYTES ));
    # the broker's log and its rotations (./log0 … ./log19, 100 MB each, "log{}" roller of tlspuffin's log.rs)
    if [[ "${name}" == stats_puffin_main_broker.log* ]] || [[ "${file}" =~ ^\./log[0-9]+$ ]]; then
      [[ "${name}" == *.gz ]] && (( monitor += rollSize )) || (( monitor += size ));
      continue;
    fi
    (( ++files, bytes += size ));
    mtime=$( stat --format=%Y "${file}" ) && (( mtime > end )) && end=${mtime};
    if [[ "${name}" == *.gz ]]; then
      (( ++rolled, estimated += rollSize ));
    else
      (( estimated += size ));
    fi
    if (( size > 0 )) && [[ "${name}" =~ ^(debug|trace|terms|puffin)(\.[0-9]+)?\.(log|gz)$ ]]; then
      verbose+="${verbose:+, }\"${file#./}\"";
    fi
  done < <(
    find "${dirs[@]}" -maxdepth 1 -type f -print0 2>/dev/null;
    [ -n "${experiment_base}" ] &&
        find "${experiment_base}" -maxdepth 1 -type f \( -name '*.log' -o -name '*.out' \) -print0 2>/dev/null;
    find . -maxdepth 1 -type f -regex './log[0-9]+' -print0 2>/dev/null
  )

  local mega=$(( 1024 * 1024 ));
  local estimatedMB=$(( (estimated + mega - 1) / mega ));
  local monitorMB=$(( (monitor + mega - 1) / mega ));
  # MB per hour per core, in tenths
  (( end > 0 )) || end=$( date +%s );
  local minutes=1 rate10;
  [[ ${start} =~ ^[0-9]+$ ]] && (( end > start )) && minutes=$(( (end - start + 59) / 60 ));
  rate10=$(( estimated * 600 / (mega * minutes * cores) ));
  local rate="$(( rate10 / 10 )).$(( rate10 % 10 ))";
  local warning='';
  if [ -n "${warnTotalMB}" ]; then
    (( estimatedMB > warnTotalMB )) && warning="~${estimatedMB} MB of logs (threshold ${warnTotalMB} MB)";
  else
    # not before 10 min of run: the first minutes (startup) are not representative
    (( minutes >= 10 && rate10 > LOG_WARN_MB_PER_CORE_HOUR * 10 )) &&
        warning="~${estimatedMB} MB of logs, ${rate} MB per hour per core (threshold ${LOG_WARN_MB_PER_CORE_HOUR})";
  fi
  [ -n "${verbose}" ] && warning+="${warning:+; }logging below INFO (${verbose//\"/})";
  [ -n "${warning}" ] && warning="\"${warning}\"" || warning='null';

  ref_logstats="{ \"estimated_mb\": ${estimatedMB}, \"disk_bytes\": ${bytes}, \"files\": ${files}, \"rolled\": ${rolled}, \"verbose_files\": [${verbose}], \"monitor_mb\": ${monitorMB}, \"minutes\": ${minutes}, \"cores\": ${cores}, \"mb_per_core_hour\": ${rate}, \"threshold_mb_per_core_hour\": ${LOG_WARN_MB_PER_CORE_HOUR}, \"threshold_mb\": ${warnTotalMB:-null}, \"warning\": ${warning} }";
}

# Save the log stats of the current attempt next to its summary (read by *_summary_run.js)
ExperimentSaveLogStats() {
  local experiment_base="$1";
  local logStats='';
  ExperimentLogStats "${experiment_base}" logStats || return 1;
  local crashStats='';
  ExperimentCrashStats "${experiment_base}" crashStats && logStats="${logStats% \}}, \"crashes\": ${crashStats} }";
  echo "${logStats}" > "${THEJOB_OUT_PATH}/logs-${THEJOB_STEP_ID}-${THEJOB_STEP_ATTEMPT_ID}.json";
  echo "${logStats}" >> "${THEJOB_USER_STATE_FILE}";
}

# Signature of an objective replay output (stdin): "<type>\t<frame1 < frame2 < frame3>\t<SUMMARY line>\t<line of
# the report start>". Type: the AddressSanitizer error (heap-buffer-overflow, SEGV, ...), "security-violation"
# when the security oracle of the trace execution flags a claim violation (frames: its message, e.g.
# "Authentication bypass"; such objectives do not crash), "panic", "replay-error" when the fuzzer could not run or
# the replay timed out, or "no-crash" when the replay did not reproduce; frames: first functions of the first stack outside the
# sanitizer runtime and the libc memory functions (<module>+<offset> when the stack is not symbolized).
# The fuzzer's own record of its objectives, from the logs of an experiment (<experiment>/log, archived as
# <attempt>-log): the crashes it caught ("Crashed with SIG…", the input it saved, the backtrace of its crash handler,
# error.log) and the claim violations (the WARN line the harness logs when the security oracle fires, warn.log).
# FuzzerRecords <log dir> prints one record per line, sorted by time: <epoch ms> TAB crash|warn TAB <signal or
# message> TAB <top frames "a < b < c"> TAB <time as logged> TAB <input file saved, crashes>.
FuzzerRecords() {
  local dir="$1" f;
  for f in "${dir}"/error.log "${dir}"/error.*.gz "${dir}"/warn.log "${dir}"/warn.*.gz; do
    [ -e "${f}" ] || continue;
    FuzzerRecordsOf "${f}" crash;
  # by time, each record once: warn.log also has the ERROR lines, so a crash is read from error.log and from warn.log;
  # one record per time, kind and input saved (crash) or message (claim), the one with the most frames kept. Not
  # sort -u on the time: the records of the same millisecond were lost (a claim and the abort of the harness 40 us
  # later: the claim went, two clients crashing at once)
  done | sort -s -t$'\t' -k1,1n | awk -F'\t' '
      { key = $1 FS $2 FS ($2 == "crash" ? $6 : $3); n = split($4, f, " < ")
        if (!(key in best)) { order[++k] = key; best[key] = $0; frames[key] = n }
        else if (n > frames[key]) { best[key] = $0; frames[key] = n } }
      END { for (i = 1; i <= k; i++) print best[order[i]] }';
  for f in "${dir}"/*stderr*.log "${dir}"/*stderr*.gz; do
    [ -e "${f}" ] || continue;
    FuzzerRecordsOf "${f}" asan;
  done;
}

# FuzzerRecordsOf <log file> <crash|asan>: the records of one log file, as FuzzerRecords prints them. With
# FUZZER_RECORDS_CACHE (a directory), the records of a file are kept there by path, size and modification time: a file
# that does not change (a rotated .gz, the logs of an ended attempt) is read once (the live page reads the logs of
# every running attempt every few minutes; a run can write several hundred MB of them).
FuzzerRecordsOf() {
  local f="$1" what="$2" cached='';
  # only a file that no longer changes: a rotated .gz, or one not modified for 5 minutes (an ended attempt)
  if [ -n "${FUZZER_RECORDS_CACHE:-}" ] && { [[ "${f}" == *.gz ]] || (( $( date +%s ) - $( stat -c %Y "${f}" ) > 300 )); }; then
    # (v3: the version of the records; a change of what is recorded makes a new key)
    cached="${FUZZER_RECORDS_CACHE}/$( printf 'v3 %s %s %s' "$( realpath "${f}" )" "$( stat -c '%s %Y' "${f}" )" "${what}" | md5sum | cut -c1-32 )";
    [ -f "${cached}" ] && { cat "${cached}"; return; };
  fi
  { case "${f}" in *.gz) zcat "${f}" 2> /dev/null;; *) cat "${f}";; esac; } |
  if [ "${what}" == crash ]; then
    # the fuzzer's own WARN lines ("[module] ...", 99% of a warn log: 625,000 [reservoir_sample] in a run of 3 hours)
    # never make a record: grep drops them first (C locale: a UTF-8 [^\t] is several times slower). Through awk, they
    # made each check of a new objective slow: at its low priority on the fuzzer's cores, the monitor saw the expected
    # bug up to 17 minutes late, and a run that found it near its timeout ended by the timeout
    LC_ALL=C grep -av $'^[0-9][^\t]*\tWARN\t\\[' |
    awk -v kind="${f##*/}" '
      # ISO 8601 time (2026-10-08T14:37:11.123456789+02:00) -> ms since the epoch, without a process per record
      function iso2ms(s,   a, t, ms, off, sign) {
        split(substr(s, 1, 19), a, /[-T:]/); t = mktime(a[1] " " a[2] " " a[3] " " a[4] " " a[5] " " a[6], 1);
        if (t < 0) return 0;
        ms = substr(s, 20, 1) == "." ? substr(s, 21, 3) + 0 : 0;
        off = substr(s, length(s) - 5); sign = substr(off, 1, 1) == "-" ? -1 : 1;
        if (off ~ /^[+-][0-9][0-9]:[0-9][0-9]$/) t -= sign * (substr(off, 2, 2) * 3600 + substr(off, 5, 2) * 60);
        return sprintf("%d%03d", t, ms) }
      # frames of the crash handler backtrace, outside the fuzzer runtime, libc, the allocator and the sanitizer
      function skip(f) { return (f ~ /^(libafl|<unknown>|__pthread_kill|pthread_kill|gsignal|raise|__GI_|abort$|__libc_|malloc_printerr|_int_(free|malloc|realloc)|cfree|free$|malloc$|realloc$|__rust|rust_panic|std::|core::|alloc::|<alloc::|<core::|<std::|__asan|__sanitizer|__interceptor|___interceptor|__lsan|__ubsan|_ZN11__sanitizer|_ZN6__asan|_ZN6__lsan|_ZN7__ubsan)/) }
      function flush() { if (ts != "") { s = ""; for (i = 1; i <= n; i++) s = s (i > 1 ? " < " : "") fr[i];
                                          printf "%s\tcrash\t%s\t%s\t%s\t%s\n", iso2ms(ts), sig, s, ts, inp } ts = ""; n = 0; inp = "" }
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+[+-][0-9:]+\t/ {
        if (match($0, /\tERROR\tCrashed with [A-Z0-9]+/)) { flush(); ts = $1; sig = substr($0, RSTART + 20, RLENGTH - 20); next }
        if (ts != "" && match($0, /\tERROR\tinput: "[^"]+"/)) { inp = substr($0, RSTART + 15, RLENGTH - 16); next }
        # a WARN line is a claim violation, except the messages of the fuzzer itself: tagged "[module] ..." (e.g.
        # [RNG], [reservoir_sample], hundreds of thousands per run), and those of a client start (minimizer, seed
        # inputs); an unknown claim stays a record (the messages of the security oracle are plain sentences)
        if (kind ~ /^warn/ && $2 == "WARN") { m = $0; sub(/^[^\t]*\t[^\t]*\t/, "", m); gsub(/\t/, " ", m);
                                              if (m !~ /^(\[|Running without minimizer is unsupported|Input \/)/) printf "%s\twarn\t%s\t\t%s\t\n", iso2ms($1), m, $1 }
        next }
      ts != "" && /^ *[0-9]+: / { f = $0; sub(/^ *[0-9]+: /, "", f); sub(/ +$/, "", f);
                                  if (!skip(f) && n < 3) fr[++n] = f; next }
      END { flush() }' FS='\t';
  else
    awk '
      # ISO 8601 time (2026-10-08T14:37:11.123456789+02:00) -> ms since the epoch, without a process per record
      function iso2ms(s,   a, t, ms, off, sign) {
        split(substr(s, 1, 19), a, /[-T:]/); t = mktime(a[1] " " a[2] " " a[3] " " a[4] " " a[5] " " a[6], 1);
        if (t < 0) return 0;
        ms = substr(s, 20, 1) == "." ? substr(s, 21, 3) + 0 : 0;
        off = substr(s, length(s) - 5); sign = substr(off, 1, 1) == "-" ? -1 : 1;
        if (off ~ /^[+-][0-9][0-9]:[0-9][0-9]$/) t -= sign * (substr(off, 2, 2) * 3600 + substr(off, 5, 2) * 60);
        return sprintf("%d%03d", t, ms) }
      function skip(f) { return (f ~ /^(__asan|__interceptor|__sanitizer|__lsan|__ubsan|___interceptor|_ZN11__sanitizer|_ZN6__asan)/ ||
                                 f ~ /^(mem(cpy|move|set|cmp)|str(len|cpy|ncpy|cmp|ncmp|cat)|bcmp)$/) }
      # the clients share this stderr: several reports can come before the next dated line, each makes a record (the
      # first ones were lost: a crash 1 s earlier then took the report of another client, campaign 1791638282947)
      /ERROR: AddressSanitizer: / { if (inb) { np++; pt[np] = t; pf[np] = fr }
                                    t = $0; sub(/.*AddressSanitizer: /, "", t); sub(/ on .*/, "", t); sub(/ .*/, "", t); inb = 1; n = 0; fr = ""; next }
      inb && /^ *#[0-9]+ 0x[0-9a-f]+ in / { f = $0; sub(/^ *#[0-9]+ 0x[0-9a-f]+ in /, "", f); sub(/ .*/, "", f);
                                           if (!skip(f) && n < 3) { fr = fr (n ? " < " : "") f; n++ } next }
      inb && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+[+-][0-9:]+/ { ts = $0; sub(/[ \t].*/, "", ts);
                                           for (i = 1; i <= np; i++) printf "%s\tasan\t%s\t%s\t%s\t\n", iso2ms(ts), pt[i], pf[i], ts;
                                           printf "%s\tasan\t%s\t%s\t%s\t\n", iso2ms(ts), t, fr, ts; np = 0; inb = 0 }';
  fi |
  if [ -n "${cached}" ]; then mkdir -p "${FUZZER_RECORDS_CACHE}"; tee "${cached}.tmp"; mv "${cached}.tmp" "${cached}" 2> /dev/null; else cat; fi;
}

# FuzzerVerdict <records (FuzzerRecords)> <objective name, <UTC yyyymmdd-HHMMSSmmm>-<hash>>: the record the
# objective came from, "crash TAB <signal> TAB <frames> TAB <time as logged>" or "claim TAB <message> TAB TAB <time>".
# A crash names the input it saved: the same hash, close in time (its file name gets a later time). Otherwise by time:
# the objective is saved about 80 ms after a crash, at once after a claim. Empty when no record matches.
FuzzerVerdict() {
  local records="$1" name="$2";
  local t; t=$( date -u -d "$( sed -E 's/^([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{3}).*/\1-\2-\3 \4:\5:\6.\7/' <<< "${name}" )" +%s%3N 2> /dev/null ) || return 0;
  awk -F'\t' -v t="${t}" -v hash="${name##*-}" '
    # a frame as a function name: the backtrace has it mangled (_Z23MemcmpInterceptorCommonPv...), ASan demangled
    # (MemcmpInterceptorCommon(void*, ...)
    function fn(f,   n) { if (match(f, /^_Z[0-9]+/)) { n = substr(f, 3, RLENGTH - 2) + 0; f = substr(f, RLENGTH + 1, n) } sub(/\(.*/, "", f); return f }
    $2 == "crash" && $6 != "" && index($6, hash) && $1 <= t + 2000 && t - $1 <= 5000 { named = $0 }
    $2 == "crash" && $1 <= t && t - $1 <= 2000 { crash = $0 }
    $2 == "warn" && $1 <= t && t - $1 <= 500 { warn = $0 }
    $2 == "warn" && $1 <= t + 2000 && t - $1 <= 6000 { warns[++nw] = $0 }
    $2 == "asan" { asan[++na] = $0 }
    END { if (named != "") crash = named;
          # the harness aborting on a claim violation (tlspuffin before ac3b89aff logs the claim, then aborts): the claim
          if (crash != "") { split(crash, c, "\t");
            if (c[4] ~ /^puffin::fuzzer::harness/)
              for (i = nw; i >= 1; i--) { split(warns[i], w, "\t"); if (w[1] <= c[1] && c[1] - w[1] <= 1000) { crash = ""; warn = warns[i]; break } } }
          if (crash != "") { split(crash, c, "\t");
            # the ASan report of that crash (dated by the restart that follows it, within 3 s): its type and its stack,
            # more precise than the backtrace of the signal handler. Clients crash within the same second: only a report
            # whose first function is that of the backtrace; without backtrace, only a report alone in the window
            split(c[4], cf, " < "); k = pick = 0;
            for (i = 1; i <= na; i++) { split(asan[i], x, "\t"); if (x[1] >= c[1] - 1000 && x[1] - c[1] <= 3000) {
              k++; split(x[4], xf, " < "); if (!pick && (c[4] == "" || fn(xf[1]) == fn(cf[1]))) pick = i } }
            if (pick && (c[4] != "" || k == 1)) { split(asan[pick], x, "\t"); c[3] = c[3] " · ASan " x[3]; if (x[4] != "") c[4] = x[4] }
            printf "crash\t%s\t%s\t%s\n", c[3], c[4], c[5] }
          else if (warn != "") { split(warn, w, "\t"); printf "claim\t%s\t\t%s\n", w[3], w[5] } }' <<< "${records}";
}

# Claims of the security oracle that are not the target of VulnA/VulnB: a known CVE of the old library versions those
# jobs use, found besides the CVE each experiment looks for. Such an objective does not end the experiment (its time
# to find is that of the targeted CVE) and is flagged on the objectives pages, which still show it. claim -> its CVE.
# claim -> "CVE|library|below": set apart only on that library below that version (e.g. wolfssl below 5.7.2: on
# wolfSSL 5.8.0 or another library the claim is a bug); no library: everywhere. See NotTargetedCVE.
# Filled by PR_targets.sh, generated by build.sh from vuln_targets.json (_not_targeted): edit that file.
declare -gA OBJECTIVES_NOT_TARGETED=()

# BuiltLibrary <build text>: "<library> <version number>" of what was built, from the build text of the run (.build_info,
# cli.build: "C harness, wolfssl540-buf", "Rust harness, wolfssl540 (...)"): "wolfssl 540"; nothing when unknown
BuiltLibrary() {
  grep -oE '[a-z]+[0-9]{3,}' <<< "$1" | head -1 | sed -E 's/^([a-z]+)([0-9]+)$/\1 \2/';
}

# NotTargetedCVE <claim> <build text>: the CVE of the claim when it is set apart for that build (OBJECTIVES_NOT_TARGETED:
# its library, below its version; versions as in the presets, 5.7.2 = 572), else nothing and 1
NotTargetedCVE() {
  local entry="${OBJECTIVES_NOT_TARGETED[$1]:-}";
  [ -n "${entry}" ] || return 1;
  local cve library below; IFS='|' read -r cve library below <<< "${entry}";
  if [ -n "${library}" ]; then
    local builtLibrary builtVersion; read -r builtLibrary builtVersion <<< "$( BuiltLibrary "$2" )";
    [ "${builtLibrary}" == "${library}" ] && [ -n "${builtVersion}" ] || return 1;
    (( 10#${builtVersion} < 10#$( tr -d . <<< "${below}" ) )) || return 1;
  fi
  echo "${cve}";
}

# RecordLoad <summary of a run (json)>: the machine load during the run, from the samples of MonitorExperiment
# (./.load_samples): { mean, max, cores, samples, cores_of } of the 1-minute load average, so that Results can tell two
# runs made under different load apart (their execs are not comparable). cores_of "machine": the cores of the machine
# (earlier samples had the cores of the step, which made the load per core several times too high)
RecordLoad() {
  local summary="$1";
  [ -s "${summary}" ] && [ -s ./.load_samples ] || return 0;
  local load; load=$( awk 'NF >= 3 { n++; s += $2; if ($2 > m) m = $2; c = $3 } END { if (n) printf "{\"mean\":%.2f,\"max\":%.2f,\"cores\":%d,\"samples\":%d,\"cores_of\":\"machine\"}", s / n, m, c, n }' ./.load_samples );
  [ -n "${load}" ] || return 0;
  jq --argjson load "${load}" '.load = $load' "${summary}" > "${summary}.tmp" 2> /dev/null && [ -s "${summary}.tmp" ] && mv "${summary}.tmp" "${summary}" || rm -f "${summary}.tmp";
  return 0;
}

# ExpectedTarget <vendor>: "cve|kind|match" of the preset's expected bug (VULN_TARGETS, generated by build.sh from
# vuln_targets.json), empty when the preset has none declared
ExpectedTarget() {
  declare -p VULN_TARGETS > /dev/null 2>&1 || return 0;
  echo "${VULN_TARGETS[$1]:-}";
}

# TargetMatches <cve|kind|match> <kind: crash|claim> <detail> <frames "a < b < c">: true when that record (or replay
# signature) is the expected bug: a crash with the frame among its top 3 frames, or the claim with that message
TargetMatches() {
  local cve kind match; IFS='|' read -r cve kind match <<< "$1";
  [ -n "${kind}" ] || return 1;
  if [ "${kind}" == claim ]; then
    [ "$2" == claim ] && [ "$3" == "${match}" ];
  else
    [ "$2" == crash ] || return 1;
    local top; top=$( awk -F' < ' '{ for (i = 1; i <= NF && i <= 3; i++) print $i }' <<< "$4" );
    grep -qF -- "${match}" <<< "${top}";
  fi
}

# ObjectiveTargeted <records (FuzzerRecords)> <objective name> [<expected target>]: from the fuzzer's record of the
# objective, 0 targeted (the expected bug; without target declared: any bug but OBJECTIVES_NOT_TARGETED), 1 not
# targeted (OBJECTIVES_NOT_TARGETED), 2 no record of it in the fuzzer's logs (yet), 3 another bug than the expected one
ObjectiveTargeted() {
  local verdict; verdict=$( FuzzerVerdict "$1" "$2" );
  [ -n "${verdict}" ] || return 2;
  local kind detail frames; IFS=$'\t' read -r kind detail frames _ <<< "${verdict}";
  # a claim set apart for what this run built (./.build_info, written by the experiment step)
  [ "${kind}" == claim ] && NotTargetedCVE "${detail}" "$( cat ./.build_info 2> /dev/null )" > /dev/null && return 1;
  [ -z "${3:-}" ] && return 0;
  TargetMatches "$3" "${kind}" "${detail}" "${frames}" && return 0;
  return 3;
}

# NotTargetedJSON: the list above, for the objectives pages ({claim: {cve, library, below}}; bugs.js applies it per run)
NotTargetedJSON() {
  local claim json='{}';
  for claim in "${!OBJECTIVES_NOT_TARGETED[@]}"; do
    json=$( jq -c --arg c "${claim}" --arg v "${OBJECTIVES_NOT_TARGETED[${claim}]}" \
        '($v | split("|")) as $f | . + { ($c): { cve: $f[0], library: ($f[1] // ""), below: ($f[2] // "") } }' <<< "${json}" );
  done
  echo "${json}";
}

# FuzzerVerdicts <records (FuzzerRecords)> < objective names: "<name> TAB <verdict as FuzzerVerdict>" for every name, in
# one pass (records and names sorted by time): a run can have tens of thousands of objectives (a Perf run of LibreSSL had
# 28,380), FuzzerVerdict per name rescans every record
FuzzerVerdicts() {
  local records="$1";
  # names → ms since the epoch (UTC in the name), sorted by time
  awk '{ n = $1; ts = sprintf("%s %s %s %s %s %s", substr(n, 1, 4), substr(n, 5, 2), substr(n, 7, 2), substr(n, 10, 2), substr(n, 12, 2), substr(n, 14, 2));
         t = mktime(ts, 1); if (t >= 0) printf "%d%03d\t%s\n", t, substr(n, 16, 3), n }' | sort -n |
  # the records through a file (too large for an argument: a warn.log of 700 KB), then the names on stdin
  awk -F'\t' '
    # a frame as a function name, as in FuzzerVerdict
    function fn(f,   n) { if (match(f, /^_Z[0-9]+/)) { n = substr(f, 3, RLENGTH - 2) + 0; f = substr(f, RLENGTH + 1, n) } sub(/\(.*/, "", f); return f }
    BEGIN { m = 0; lo = 1 }
    FNR == NR { if ($0 != "") { m++; ms[m] = $1 + 0; kind[m] = $2; what[m] = $3; fr[m] = $4; raw[m] = $5; inp[m] = $6 } next }
    { t = $1 + 0; name = $2; hash = name; sub(/^.*-/, "", hash)
      while (lo <= m && ms[lo] < t - 5000) lo++
      named = crash = warn = 0
      for (i = lo; i <= m && ms[i] <= t + 2000; i++) {
        if (kind[i] == "crash" && inp[i] != "" && index(inp[i], hash)) named = i
        if (kind[i] == "crash" && ms[i] <= t && t - ms[i] <= 2000) crash = i
        if (kind[i] == "warn" && ms[i] <= t && t - ms[i] <= 500) warn = i
      }
      if (named) crash = named
      # the harness aborting on a claim violation (tlspuffin before ac3b89aff logs the claim, then aborts): the claim
      # (the claim and the abort are often in the same ms, the claim then sorted after the crash: the window is scanned)
      if (crash && fr[crash] ~ /^puffin::fuzzer::harness/) {
        claim = 0
        for (i = lo; i <= m && ms[i] <= ms[crash]; i++) if (kind[i] == "warn" && ms[crash] - ms[i] <= 1000) claim = i
        if (claim) { warn = claim; crash = 0 } }
      # its ASan report, as FuzzerVerdict: the first frame of the backtrace, or alone in the window without backtrace
      if (crash) { d = what[crash]; s = fr[crash]; split(s, cf, " < "); k = pick = 0
        for (i = lo; i <= m && ms[i] <= ms[crash] + 3000; i++) if (kind[i] == "asan" && ms[i] >= ms[crash] - 1000) {
          k++; split(fr[i], xf, " < "); if (!pick && (s == "" || fn(xf[1]) == fn(cf[1]))) pick = i }
        if (pick && (s != "" || k == 1)) { d = d " · ASan " what[pick]; if (fr[pick] != "") s = fr[pick] }
        printf "%s\tcrash\t%s\t%s\t%s\n", name, d, s, raw[crash] }
      else if (warn) printf "%s\tclaim\t%s\t\t%s\n", name, what[warn], raw[warn]
      else printf "%s\t\t\t\t\n", name }' <( printf '%s\n' "${records}" | sort -t$'\t' -k1,1n ) - |
  # an objective whose record is gone (the fuzzer's logs rotate: 20 files kept, a run crashing 7 times a second keeps its
  # last minutes only) takes the verdict of an objective with the same input (the hash ending its name): same input,
  # same bug; its raw field says so
  awk -F'\t' '{ line[NR] = $0; name[NR] = $1; h = $1; sub(/^.*-/, "", h); hash[NR] = h
                 if ($2 != "" && !(h in known)) known[h] = $2 "\t" $3 "\t" $4 "\t" "same input as " $1 }
               END { for (i = 1; i <= NR; i++) {
                       split(line[i], f, "\t")
                       if (f[2] == "" && (hash[i] in known)) print name[i] "\t" known[hash[i]]; else print line[i] } }' OFS='\t';
}

# FuzzerExcerpt <log dir> <time as logged> <crash|claim>: the fuzzer's log of that record, for the objectives pages:
# a crash with its input, signal and backtrace (without the registers and memory maps), or the claim line.
FuzzerExcerpt() {
  local dir="$1" ts="$2" kind="$3" f;
  [ -n "${ts}" ] || return 0;
  for f in "${dir}"/$( [ "${kind}" == crash ] && echo error || echo warn ).log "${dir}"/$( [ "${kind}" == crash ] && echo error || echo warn ).*.gz; do
    [ -e "${f}" ] || continue;
    { case "${f}" in *.gz) zcat "${f}" 2> /dev/null;; *) cat "${f}";; esac; } | awk -v ts="${ts}" -v kind="${kind}" '
      !on && index($0, ts) == 1 { on = 1; print; if (kind != "crash") exit; next }
      !on { next }
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/ { if (++stamped > 2) exit; print; next }
      /━━/ { section = $0; keep = (section ~ /CRASH|BACKTRACE/); if (keep) print; next }
      keep && ++n <= 60 { print }' && break;
  done
}

# SummaryAddBench <summary.json>: the puffin-bench version that produced the results (version.json, written by
# deploy.sh next to the board, beside the tools of the job), recorded in each library of the summary: the publisher
# merges the results per library (the newest task of each), so a commit's results can come from several versions.
# Shown by the Results page ("run on … · bench d10↗"). Leaves the summary as it is when anything is missing.
SummaryAddBench() {
  local summary="$1" version="${THEJOB_TOOLS_PATH}/../html/board/version.json";
  [ -s "${summary}" ] && [ -r "${version}" ] || return 0;
  # bench: the deployed version (services, board); jobscripts: the commit of these job scripts (build.sh), which a
  # hot copy can change without a deploy
  jq --slurpfile v "${version}" --arg jc "${PB_JOBSCRIPTS_COMMIT:-}" --arg jd "${PB_JOBSCRIPTS_DATE:-}" --arg jdirty "${PB_JOBSCRIPTS_DIRTY:-}" \
      '($v[0] | {commit, branch, date, deployed, repository}
        + (if $jc != "" then { jobscripts: { commit: $jc, date: $jd, dirty: ($jdirty == "true") } } else {} end)) as $b
      | if (.libraries | type) == "object" then .libraries |= with_entries(.value.bench = $b) else . end' \
      "${summary}" > "${summary}.tmp" 2> /dev/null && [ -s "${summary}.tmp" ] && mv "${summary}.tmp" "${summary}" || rm -f "${summary}.tmp";
  return 0;
}

ObjectiveSignature() {
  awk '
    function skip(f) { return (f ~ /^(__asan|__interceptor|__sanitizer|__lsan|__ubsan|___interceptor)/ ||
                               f ~ /^(mem(cpy|move|set|cmp)|str(len|cpy|ncpy|cmp|ncmp|cat)|bcmp)$/) }
    type == "" && match($0, /ERROR: AddressSanitizer: [A-Za-z_-]+/) {
      type = substr($0, RSTART + 25, RLENGTH - 25); start = NR; next }
    type == "" && panic == "" && /panicked at / { panic = $0; sub(/.*panicked at /, "", panic); sub(/:$/, "", panic) }
    # security oracle (claims): "error because a security violation occurred. msg: <msg>" logged by the forked
    # execution, or "Failed to execute trace <path>: SecurityClaim(\"<msg>\")" on older commits
    type == "" && violation == "" && match($0, /security violation occurred\. msg: .*/) {
      violation = substr($0, RSTART + 34); vline = $0; vstart = NR }
    type == "" && violation == "" && match($0, /SecurityClaim\("[^"]*"\)/) {
      violation = substr($0, RSTART + 15, RLENGTH - 17); vline = $0; vstart = NR }
    type != "" && !done && /^ *#[0-9]+ 0x[0-9a-f]+ in / {
      f = $0; sub(/^ *#[0-9]+ 0x[0-9a-f]+ in /, "", f); sub(/ .*/, "", f);
      if (!skip(f) && n < 3) frames[++n] = f; seen = 1; next }
    # unsymbolized frame "#N 0x... (/path/module+0xoffset)": module and offset, outside the sanitizer runtime
    type != "" && !done && /^ *#[0-9]+ 0x[0-9a-f]+ +\(/ {
      f = $0; sub(/^[^(]*\(/, "", f); sub(/\).*/, "", f); sub(/.*\//, "", f);
      if (f !~ /^libclang_rt\.|^libasan/ && n < 3) frames[++n] = f; seen = 1; next }
    type != "" && seen && /^ *$/ { done = 1 }
    type != "" && summary == "" && /^SUMMARY: AddressSanitizer:/ { summary = $0 }
    /error while loading shared libraries|binary not found:|^error: could not compile|^binary changed since the experiment/ { replayerr = $0 }
    # killed by timeout (124, or 137 after -k): the objective was not replayed, which is not "no-crash"
    replayerr == "" && /^exit status: (124|137)$/ { replayerr = "replay timed out (" $0 ")" }
    # the forked execution died of SIGSEGV or SIGABRT ("execution finished with status Crashed", tlspuffin since
    # 482ebfe1e): reproduced, but without sanitizer report nor claim message (e.g. a library built without ASAN)
    crashed == "" && /execution finished with status Crashed/ { crashed = $0; sub(/^[^\t]*\t/, "", crashed); cstart = NR }
    # the replay stopped on an error of the library or of the trace before the bug ("error in PUT : <msg>", "error
    # evaluating a term: <msg>"): not reproduced (the replay did not follow the fuzzing run), and why
    diverged == "" && match($0, /error in PUT : .*|error evaluating a term: .*/) {
      diverged = substr($0, RSTART, RLENGTH); sub(/[ \r]+$/, "", diverged); dstart = NR }
    END {
      if (type != "") { s = ""; for (i = 1; i <= n; i++) s = s (i > 1 ? " < " : "") frames[i];
                        printf "%s\t%s\t%s\t%d\n", type, s, summary, start }
      else if (violation != "") { sub(/[ \r]+$/, "", violation); gsub(/\t/, " ", vline); printf "security-violation\t%s\t%s\t%d\n", violation, vline, vstart }
      else if (panic != "") printf "panic\t%s\t\t0\n", panic
      else if (crashed != "") printf "crash\t\t%s (SIGSEGV or SIGABRT, no sanitizer report)\t%d\n", crashed, cstart
      else if (replayerr != "") printf "replay-error\t\t%s\t0\n", replayerr
      else if (diverged != "") { key = diverged; sub(/ *-->/, "", key); sub(/ *\(.*/, "", key); gsub(/\t/, " ", diverged)
                                 printf "no-crash\t%s\t%s\t%d\n", key, diverged, dstart }
      else printf "no-crash\t\t\t0\n" }'
}

# Replay the objectives of an experiment (oldest first, at most $2) with the fuzzer command of .currentcmd,
# save one report per trace in <experiment>/objective-reports and group them by signature into
# ${THEJOB_OUT_PATH}/objectives-<step>-<attempt>.json (attached to the attempts by the summary scripts).
#   $1 experiment directory, $2 maximum number of replays, $3 timeout of a replay (seconds)
# ExperimentReplayObjectives <experiment dir> [<max replays>] [<timeout>] [<file of objective names replayed first>]: the
# objectives replayed are those of the file first (e.g. the targeted ones of VulnA/VulnB: the evidence of the bug the
# experiment ended on, which may come after many others), then the others by time, up to the maximum
ExperimentReplayObjectives() {
  local experiment_base="$1";
  local maxReplays="${2:-100}";
  local replayTimeout="${3:-120}";
  local firstNames="${4:-}";
  local objectiveDir="${experiment_base}/objective";
  local reportDir="${experiment_base}/objective-reports";
  local outFile="${THEJOB_OUT_PATH}/objectives-${THEJOB_STEP_ID}-${THEJOB_STEP_ATTEMPT_ID}.json";
  local total;
  total=$( find "${objectiveDir}" -maxdepth 1 -type f -name '*.trace' ! -name '.*' 2> /dev/null | wc -l );
  (( total > 0 )) || return 0;
  if [ ! -r .currentcmd ]; then
    echo -e '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\nCan not run test on objectives found, missing .currentcmd\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
    echo "{ \"total\": ${total}, \"replayed\": 0, \"error\": \"missing .currentcmd\", \"groups\": [] }" > "${outFile}";
    return 0;
  fi
  echo "================================";
  echo "Running test on objectives found";
  echo "================================";
  mkdir -p "${reportDir}" || return 1;

  local cmd=$( < .currentcmd );
  # exactly the launch of the fuzzer (.currentlaunch): the same binary file (never cargo, which could rebuild),
  # options (e.g. --put-use-clear changes how the PUT runs: without it a replay can fail before the objective),
  # prefixes and ASAN_OPTIONS; older experiments without the record: cargo run, as they were
  local LAUNCH_BINARY='' LAUNCH_SHA256='' LAUNCH_PREFIX='' LAUNCH_NOASLR='' LAUNCH_FLAGS='' LAUNCH_ASAN_SET=false LAUNCH_ASAN_OPTIONS='';
  local launch='' changed='';
  if [ -r .currentlaunch ]; then
    source .currentlaunch;
    local asanCmd='unset ASAN_OPTIONS;';
    [ "${LAUNCH_ASAN_SET}" == true ] && printf -v asanCmd 'export ASAN_OPTIONS=%q;' "${LAUNCH_ASAN_OPTIONS}";
    local quotedBinary; printf -v quotedBinary '%q' "${LAUNCH_BINARY}";
    launch="${asanCmd} exec ${LAUNCH_PREFIX} ${quotedBinary} ${LAUNCH_FLAGS}";
    if [ -n "${LAUNCH_SHA256}" ] && [ "$( sha256sum "${LAUNCH_BINARY}" 2> /dev/null | cut -d' ' -f1 )" != "${LAUNCH_SHA256}" ]; then
      changed="binary changed since the experiment: ${LAUNCH_BINARY} (not replayed, it would run another binary)";
    fi
  fi
  local tsv="${reportDir}/.signatures.tsv";
  : > "${tsv}";
  # a replay that ends without confirming a bug is tried again: a memory corruption in a library built without ASAN
  # crashes or not depending on the memory layout. At most REPLAY_TRIES tries, and no new try after REPLAY_RETRY_BUDGET
  # seconds of retries for the whole attempt.
  local replayTries="${REPLAY_TRIES:-5}";
  local retryDeadline=$(( SECONDS + ${REPLAY_RETRY_BUDGET:-120} ));
  local obj;
  while IFS= read -r -d '' obj; do
    local name=$( basename "${obj}" .trace );
    local report="${reportDir}/${name}.txt";
    echo "=== ${obj} ===";
    local quoted;
    printf -v quoted '%q' "${obj}";
    local tries=0 sig='';
    while :; do
      tries=$(( tries + 1 ));
      # RUST_LOG=info: the security oracle reports a claim violation at INFO level (see ObjectiveSignature)
      if [ -n "${changed}" ]; then
        echo "${changed}" > "${report}";
        echo "exit status: 125" >> "${report}";
      elif [ -n "${launch}" ]; then
        RUST_LOG=info timeout -k 10 "${replayTimeout}" ${LAUNCH_NOASLR} nix-shell --run "${launch} execute ${quoted}" < /dev/null > "${report}" 2>&1;
        echo "exit status: $?" >> "${report}";
      else
        RUST_LOG=info timeout -k 10 "${replayTimeout}" $( NoAslrPrefix ) nix-shell --run "${cmd} -- execute ${quoted}" < /dev/null > "${report}" 2>&1;
        echo "exit status: $?" >> "${report}";
      fi
      sig=$( ObjectiveSignature < "${report}" );
      [ "${sig%%$'\t'*}" == no-crash ] && (( tries < replayTries )) && (( SECONDS < retryDeadline )) || break;
    done
    echo "replay tries: ${tries} of at most ${replayTries}" >> "${report}";
    cat "${report}";
    local found=$( date -r "${obj}" +%s );
    printf '%s\t%s\t%s\t%s\n' "${name}" "${found}" "${sig}" "${tries}/${replayTries}" >> "${tsv}";
  done < <(
    # rank 0: the names given first, rank 1: the others; then by time
    find "${objectiveDir}" -maxdepth 1 -type f -name '*.trace' ! -name '.*' -printf '%T@ %p\0' |
    while IFS= read -r -d '' line; do
      local path="${line#* }" rank=1;
      [ -n "${firstNames}" ] && [ -s "${firstNames}" ] && grep -qxF "$( basename "${path}" .trace )" "${firstNames}" && rank=0;
      printf '%s %s\0' "${rank}" "${line}";
    done |
    sort -z -k1,1n -k2,2n |
    head -z -n "${maxReplays}" |
    cut -z -d ' ' -f 3-
  )

  # groups: one per signature, largest first, with the first lines of the report of their oldest trace
  local groups;
  groups=$( jq -R -s --arg dir "${reportDir}" '
    split("\n") | map(select(length > 0) | split("\t")
      | { trace: .[0], found: (.[1] | tonumber), type: .[2], frames: .[3], summary: .[4], start: (.[5] | tonumber) })
    | group_by(.type + "|" + .frames)
    | map(sort_by(.found) | { type: .[0].type, frames: (.[0].frames | if . == "" then [] else split(" < ") end),
          summary: .[0].summary, count: length, first_trace: .[0].trace, first_found: .[0].found,
          last_found: (map(.found) | max), traces: (map(.trace) | .[:20]), start: .[0].start })
    | sort_by(-.count)' "${tsv}" ) || groups='[]';
  local excerpts='[]';
  local i;
  for (( i = 0; i < $( jq 'length' <<< "${groups}" ); i++ )); do
    local trace=$( jq -r ".[${i}].first_trace" <<< "${groups}" );
    local start=$( jq -r ".[${i}].start" <<< "${groups}" );
    (( start > 0 )) || start=1;
    excerpts=$( jq --arg e "$( tail -n "+${start}" "${reportDir}/${trace}.txt" | head -n 40 | cut -c1-300 )" '. + [$e]' <<< "${excerpts}" );
  done
  jq -n --argjson total "${total}" --argjson groups "${groups}" --argjson excerpts "${excerpts}" --argjson max "${maxReplays}" '
    { total: $total, replayed: ([$groups[].count] | add // 0), max_replays: $max,
      groups: [ $groups | to_entries[] | .value + { excerpt: $excerpts[.key] } | del(.start) ] }' > "${outFile}" || return 1;
  CreateArtefact "${reportDir}" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-objective-reports" "commit_id:${COMMIT_ID}";
  echo "Objectives: $( jq -r '"\(.total) found, \(.replayed) replayed, \(.groups | length) distinct: " + ([.groups[] | "\(.count) × \(.type) \(.frames | join(" < "))"] | join("; "))' "${outFile}" )";
  return 0;
}

# Saved by the experiment step before the launch, for ExperimentEnd: where the step writes its stderr (read by
# ExperimentCrashStats: with LibAFL launchers that do not redirect the clients' stderr, their crash reports end up
# there), and the start time and fuzzing cores of the run (read by ExperimentLogStats).
# Record how the fuzzer is launched (.currentlaunch, sourced by the objective replays: ExperimentReplayObjectives
# and tools/objectives_live.sh), for replays with exactly the same binary, options, prefixes and ASAN_OPTIONS:
#   <binary> <fuzzer options> <via cargo: true|false>
# LAUNCH_SHA256 lets a replay check that the binary did not change since (a rebuild would replay another binary).
# Under `cargo run`, ASAN_OPTIONS comes from the [env] of .cargo/config.toml unless already set (cargo does not
# override it); a direct run gets the variable as it is.
ExperimentSaveExecution() {
  local binary="$1" flags="$2" viaCargo="$3";
  local asanSet=false asan='';
  if [ -n "${ASAN_OPTIONS+x}" ]; then
    asanSet=true; asan="${ASAN_OPTIONS}";
  elif [ "${viaCargo}" == true ]; then
    asan=$( sed -n 's/^ *ASAN_OPTIONS *= *"\(.*\)".*/\1/p' .cargo/config.toml 2> /dev/null | head -1 );
    [ -n "${asan}" ] && asanSet=true;
  fi
  local sha='';
  [ -f "${binary}" ] && sha=$( sha256sum "${binary}" | cut -d' ' -f1 );
  {
    printf 'LAUNCH_BINARY=%q\n' "$( realpath -m "${binary}" )";
    printf 'LAUNCH_SHA256=%q\n' "${sha}";
    printf 'LAUNCH_PREFIX=%q\n' "${PREFIX_FAKETIME}";
    printf 'LAUNCH_NOASLR=%q\n' "$( NoAslrPrefix )";
    printf 'LAUNCH_FLAGS=%q\n' "${flags}";
    printf 'LAUNCH_ASAN_SET=%q\n' "${asanSet}";
    printf 'LAUNCH_ASAN_OPTIONS=%q\n' "${asan}";
  } > .currentlaunch
}

ExperimentSaveLaunchInfo() {
  echo "${THEJOB_STDERR_PATH:-}" > ./.experiment_stderr_path
  echo "$( date +%s ) ${THEJOB_NB_CORES:-1}" > ./.experiment_launch
}

# Fuzzing clients that crashed and were restarted during an experiment, as a JSON record in the referenced
# variable: "Spawning next client (id N)" with N > 0 (each client is spawned once with id 0) and AddressSanitizer
# reports, counted in every place the clients' output goes depending on the commit (log/puffin_main_broker_std*.log,
# tlspuffin.out, the stderr of the experiment step). A crash storm (e.g. a harness bug hit by most inputs) makes the
# executions of the run meaningless. Warns above CRASH_WARN_RESTARTS (task argument, default 100). Only at
# ExperimentEnd: the files can reach hundreds of MB.
ExperimentCrashStats() {
  local experiment_base="$1";
  if [ -z "$2" ]; then
    echo "Missing reference parameter for crash stats";
    return 1;
  fi
  local -n ref_crashstats=$2;

  [[ ${CRASH_WARN_RESTARTS:-} =~ ^[0-9]+$ ]] || CRASH_WARN_RESTARTS=100;

  local -a files=();
  local f;
  for f in "${experiment_base}"/log/puffin_main_broker_std{out,err}.log "${experiment_base}"/{,log/}tlspuffin.out ./log/puffin_main_broker_std{out,err}.log; do
    [ -n "${experiment_base}" ] || [[ "${f}" == ./* ]] || continue;
    [ -f "${f}" ] && files+=( "${f}" );
  done
  if [ -r ./.experiment_stderr_path ]; then
    f=$( < ./.experiment_stderr_path );
    [ -n "${f}" ] && [ -f "${f}" ] && files+=( "${f}" );
  fi

  local restarts=0 asan=0;
  if (( ${#files[@]} > 0 )); then
    read -r restarts asan < <( LC_ALL=C awk '/Spawning next client \(id [1-9]/ { r++ } /^==[0-9]+==ERROR: AddressSanitizer/ { a++ }
      END { print r + 0, a + 0 }' "${files[@]}" );
  fi
  local warning='null';
  (( restarts > CRASH_WARN_RESTARTS )) &&
      warning="\"${restarts} client restarts after a crash (${asan} ASAN reports, threshold ${CRASH_WARN_RESTARTS})\"";
  ref_crashstats="{ \"client_restarts\": ${restarts}, \"asan_reports\": ${asan}, \"files\": ${#files[@]}, \"threshold\": ${CRASH_WARN_RESTARTS}, \"warning\": ${warning} }";
}

# Sources of the vendor libraries built for the experiment (./vendor/<name>), as a JSON array in the referenced
# variable: repository, requested ref and the commit it resolves to. Fork branches (e.g. tlspuffin/libressl
# fuzz-v3.3.3) move, so the same tlspuffin commit can be built from different sources over time.
#   puffin-build: vendor/<name>/.vendor_config, [sources] repo + branch|commit (or url + hash for archives)
#   older mk_vendor: vendor/<name>/mk_vendor.conf, FETCH_ARG:URL= / FETCH_ARG:REF=
# A branch or tag is resolved with git ls-remote right after the build (commit null when that fails).
DetectVendorSources() {
  if [ -z "$1" ]; then
    echo "Missing reference parameter for vendor sources";
    return 1;
  fi
  local -n ref_sources=$1;
  ref_sources='';
  local dir;
  for dir in ./vendor/*/; do
    dir="${dir%/}";
    local repo='' ref='';
    if [ -r "${dir}/.vendor_config" ]; then
      repo=$( awk -F' = ' '/^\[/ { s = ($0 == "[sources]") } s && ($1 == "repo" || $1 == "url") { gsub(/"/, "", $2); print $2 }' "${dir}/.vendor_config" | head -1 );
      ref=$( awk -F' = ' '/^\[/ { s = ($0 == "[sources]") } s && ($1 == "branch" || $1 == "commit" || $1 == "hash") { gsub(/"/, "", $2); print $2 }' "${dir}/.vendor_config" | head -1 );
      # url sources (archives): the hash is recorded as the ref, nothing to resolve
      if grep -q '^url = ' "${dir}/.vendor_config"; then
        ref_sources+="${ref_sources:+, }{ \"name\": \"$( basename "${dir}" )\", \"url\": \"${repo}\", \"hash\": \"${ref}\", \"commit\": null }";
        continue;
      fi
    elif [ -r "${dir}/mk_vendor.conf" ]; then
      repo=$( sed -n 's/^FETCH_ARG:URL=//p' "${dir}/mk_vendor.conf" | head -1 );
      ref=$( sed -n 's/^FETCH_ARG:REF=//p' "${dir}/mk_vendor.conf" | head -1 );
    fi
    [ -n "${repo}" ] || continue;
    local commit='';
    if [[ "${ref}" =~ ^[0-9a-f]{40}$ ]]; then
      commit="${ref}";
    else
      local -a patterns=( HEAD );
      [ -n "${ref}" ] && patterns=( "refs/heads/${ref}" "refs/tags/${ref}" "refs/tags/${ref}^{}" );
      local remote;
      remote=$( timeout 60 git ls-remote "${repo}" "${patterns[@]}" 2> /dev/null );
      # a peeled tag (^{}) gives the commit of an annotated tag
      commit=$( grep -F '^{}' <<< "${remote}" | cut -f1 | head -1 );
      [ -n "${commit}" ] || commit=$( cut -f1 <<< "${remote}" | head -1 );
    fi
    ref_sources+="${ref_sources:+, }{ \"name\": \"$( basename "${dir}" )\", \"repo\": \"${repo}\", \"ref\": \"${ref}\", \"commit\": $( [ -n "${commit}" ] && echo "\"${commit}\"" || echo null ) }";
  done
  ref_sources="[${ref_sources}]";
}

# DetectVendorVulnerabilities <vendor preset "<library>:<name>">: the vulnerabilities tlspuffin declares for that build,
# from its vendorinfo.sh (puffin-build, written next to the build: KNOWN_VULNERABILITIES from the library's builder.cmake
# for its version, FIXED_VULNERABILITIES patched by the preset's "fix" list), read without running it:
# {"known": [...], "fixed": [...], "declared": known minus fixed}; null when the preset was not built here (Rust harness,
# commits before puffin-build). The objectives pages do not flag a bug as new when it is one of the declared CVEs.
DetectVendorVulnerabilities() {
  local name="${1#*:}" info;
  [ -n "${name}" ] && info=$( ls -1 ./vendor/"${name}"/build/vendorinfo.sh 2> /dev/null | head -1 );
  [ -n "${info}" ] && [ -r "${info}" ] || { echo null; return 0; }
  local known fixed;
  known=$( sed -n 's/^KNOWN_VULNERABILITIES=( *\(.*[^ ]\)\{0,1\} *)$/\1/p' "${info}" | head -1 );
  fixed=$( sed -n 's/^FIXED_VULNERABILITIES=( *\(.*[^ ]\)\{0,1\} *)$/\1/p' "${info}" | head -1 );
  jq -cn --arg k "${known}" --arg f "${fixed}" '($k | split(" ") | map(select(. != ""))) as $known
      | ($f | split(" ") | map(select(. != ""))) as $fixed
      | { known: $known, fixed: $fixed, declared: ($known - $fixed) }' 2> /dev/null || echo null;
}

ExperimentEndCommon() {
  [ -r "./.reserved_port.pid" ] && kill $( cat ./.reserved_port.pid )
  ipcrm --all
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

  echo "${THEJOB_STEP_UUID}" > .thejob_uuid

  CompatApplyFlags extra_flags;

  local binary="";
  local last_core=0;
  ExperimentSetup binary last_core "${features}" || return 1;
  CompatApplyFiles || return 1;
  local cores="";
  (( AFL_CORES_GRAMMAR == 0 )) && cores="0-${last_core}" || cores="${THEJOB_CORES}"
  # the objective replays run exactly this: binary, options, prefixes, ASAN_OPTIONS
  ExperimentSaveExecution "${binary}" "${extra_flags}" false
  ExperimentSaveLaunchInfo
  $( NoAslrPrefix ) nix-shell --run "exec ${PREFIX_FAKETIME} \"${binary}\" --cores ${cores} --port ${RESERVED_PORT} ${extra_flags} experiment -d \"${experiment}\" -t \"${experiment}\"" &
  ref_tlspuffin_pid=$!

  ref_tlspuffin_killed=0
  if ! ExperimentPostLaunchSetup ref_stats "${ref_tlspuffin_pid}" "${saveData}" "${features:-none}"; then
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

  [ -z "${PACKAGE}" ] && PACKAGE="tlspuffin"

  echo "${THEJOB_STEP_UUID}" > .thejob_uuid

  CompatApplyFlags extra_flags;

  local last_core=0;
  ExperimentSetupForCargo last_core features || return 1;
  CompatApplyFiles || return 1;
  local cores="";
  (( AFL_CORES_GRAMMAR == 0 )) && cores="0-${last_core}" || cores="${THEJOB_CORES}"
  local featuresCLI='';
  [ -n "${features}" ] && featuresCLI="--features=${features}";
  echo "nix-shell --run exec ${PREFIX_FAKETIME} cargo run --bin \"${PACKAGE}\" --release ${featuresCLI} -- --cores ${cores} --port ${RESERVED_PORT} ${extra_flags} experiment -d \"${experiment}\" -t \"${experiment}\""
  echo "exec ${PREFIX_FAKETIME} cargo run --bin \"${PACKAGE}\" --release ${featuresCLI}" > .currentcmd
  # the objective replays run exactly this: the binary cargo runs (built by ForcedBuild), options, prefixes,
  # ASAN_OPTIONS
  ExperimentSaveExecution "${CARGO_TARGET_DIR:-target}/release/${PACKAGE}" "${extra_flags}" true
  ExperimentSaveLaunchInfo
  $( NoAslrPrefix ) nix-shell --run "exec ${PREFIX_FAKETIME} cargo run --bin \"${PACKAGE}\" --release ${featuresCLI} -- --cores ${cores} --port ${RESERVED_PORT} ${extra_flags} experiment -d \"${experiment}\" -t \"${experiment}\"" &
  ref_tlspuffin_pid=$!
  echo "tlspuffin monitored pid is ${ref_tlspuffin_pid}" >&2

  ref_tlspuffin_killed=0
  if ! ExperimentPostLaunchSetup ref_stats "${ref_tlspuffin_pid}" "${saveData}" "${features:-none}"; then
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

  OLD_COMMIT_ID=$COMMIT_ID
  COMMIT_ID=$( git rev-parse --verify "${COMMIT_ID}^{commit}" ) || {
    COMMIT_ID=$OLD_COMMIT_ID
    CancelTask "Unknown commit ${OLD_COMMIT_ID}"
    return 1
  }
  #[ "${COMMIT_ID}" != "${OLD_COMMIT_ID}" ] && curl -X PATCH "http://127.0.0.1:${THEJOB_SERVER_PORT}/api/task/${THEJOB_TASK_ID}/args" --data-urlencode "args[COMMIT_ID]=${COMMIT_ID}"
  [ "${COMMIT_ID}" != "${OLD_COMMIT_ID}" ] && AddGlobalParam COMMIT_ID "${COMMIT_ID}"

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

  local -A nixVersionMap=(
    [22.11]=1j7h75a9hwkkm97jicky5rhvzkdwxsv5v46473rl6agvq2sj97y1
    [23.11]=1mbp7jydzxqgv9w3a8fqggq1x8h3cd0vh9wafri5pls52ngyww47
    [24.05]=1f8j7fh0nl4qmqlxn6lis8zf7dnckm6jri4rwmj0qm1qivhr58lv
  )
  local nixVersion=$( sed -n 's|^.*https://github.com/NixOS/nixpkgs/archive/nixos-\([0-9][0-9]\.[0-9][0-9]\).*$|\1|p' shell.nix )
  [ -n "$nixVersion" ] &&  [ -n "${nixVersionMap[$nixVersion]}" ] && \
      sed -i "s|fetchTarball \"https://github.com/NixOS/nixpkgs/archive/nixos-$nixVersion.tar.gz\"|fetchTarball {\n    url = \"https://channels.nixos.org/nixos-$nixVersion/nixexprs.tar.xz\";\n    sha256 = \"${nixVersionMap[$nixVersion]}\";\n  }|" shell.nix

  if [ ! -z "${PREFIX_FAKETIME}" ]; then
    echo "Setup faketime in shell.nix"
    sed -i 's/\(.*nativeBuildInputs = \[.*\)/\1\n    pkgs.libfaketime/' shell.nix || return 1
  fi

  [ -r "tlspuffin/harness/wolfssl/src/put.c" ] &&
    ! grep -q MyTimeoutCallBack "tlspuffin/harness/wolfssl/src/put.c" &&
    patch --dry-run "tlspuffin/harness/wolfssl/src/put.c" < "${THEJOB_USER_FILES_PATH}/wolfssl_put.c.patch" &&
    patch "tlspuffin/harness/wolfssl/src/put.c" < "${THEJOB_USER_FILES_PATH}/wolfssl_put.c.patch"

  local compatApplied='';
  CompatEvaluate "${THEJOB_OUT_PATH}/repo" "${COMMIT_ID}" compatApplied "${THEJOB_OUT_PATH}/compat.json" || return 1;
  # commit inside a declared range without the bias (e.g. a commit of the tlspuffin PR that removed it):
  # run with the probe's decision, warning shown on the scheduler board (task argument) and on the dashboard
  if [ -n "${COMPAT_MISMATCH}" ]; then
    COMPAT_WARNING="commit in the declared range of ${COMPAT_MISMATCH} but the probe does not match: rule(s) not applied, check the results"
    AddGlobalParam COMPAT_WARNING "${COMPAT_WARNING}"
  fi
  CreateArtefact "${THEJOB_OUT_PATH}/compat.json" "compat.json" "commit_id:${COMMIT_ID}"
  AddGlobalParam COMPAT_APPLIED "${compatApplied}"
  COMPAT_APPLIED="${compatApplied}"
  CompatPrepare "${THEJOB_OUT_PATH}/repo" || return 1;

  #nix-shell --run cargo >/dev/null 2>/dev/null || return 1;
  # first cargo call of the task: it may install the Rust toolchain of the commit; serialized between tasks
  # (concurrent rustup installs into the same home leave broken toolchains, e.g. without cargo)
  if ! command -v flock > /dev/null; then
    CancelTask "flock is required on the scheduler host (package util-linux)"
    return 1
  fi
  LIBAFL_VER=$( flock "${HOME:-/tmp}/.puffin-bench-rustup.lock" nix-shell --run "cd puffin; cargo pkgid libafl" | grep -i libafl | sed 's/.*@//' );
  if [ -z "${LIBAFL_VER}" ]; then
    CancelTask "Unable to get the LibAFL version (cargo pkgid libafl failed, see Init output)"
    return 1
  fi
  AddGlobalParam LIBAFL_VERSION "${LIBAFL_VER}"
  echo -e "${LIBAFL_VER}\n0.15.3" | sort -V | tail -1 | grep -Fxq 0.15.3;
  AFL_CORES_GRAMMAR=$?
  AddGlobalParam AFL_CORES_GRAMMAR "${AFL_CORES_GRAMMAR}"

  # ASAN runtimes of LLVM < 18 crash at random at startup with more than 28 bits of mmap randomization
  # (the value is only readable by root: no warning when it cannot be read)
  local rndBits=$( cat /proc/sys/vm/mmap_rnd_bits 2> /dev/null || echo 0 );
  (( rndBits <= 28 )) ||
      echo "WARNING: vm.mmap_rnd_bits=${rndBits} > 28: ASAN fuzzers built with LLVM < 18 may crash at startup (AddressSanitizer:DEADLYSIGNAL); set it to 28 on this host" >&2;

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

  [ -z "${PACKAGE}" ] && PACKAGE="tlspuffin"

  local cputs=false
  ComputeBuildRuntimeInfo "${PACKAGE}" "${vendor}" features cputs || {
      echo "Failed to compute runtime info for vendor '${vendor}' '${features}'"
      return 1;
  }

  [ -z "${COMMIT_ID}" ] && COMMIT_ID="main"
  md5sum_res=$( echo "${PACKAGE}-${COMMIT_ID}-${features}-${vendor}" | md5sum )
  cache_id="${PACKAGE}-${md5sum_res%% *}"
  echo "${PACKAGE}-${COMMIT_ID}-${features}-${vendor} = ${cache_id}"
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
    local featuresCLI='';
    [ -n "${features}" ] && featuresCLI="--features=${features}";
    nix-shell --run "cargo build --bin \"${PACKAGE}\" --release ${featuresCLI} -j ${THEJOB_NB_CORES}" || return 1
    binary=$( realpath "./target/release/${PACKAGE}" )
    SetCache "${cache_id}" "${binary}"
  else
    echo "Found in cache"
  fi
  cp "${binary}" "${THEJOB_OUT_PATH}/${PACKAGE}-${THEJOB_STEP_ID}" || return 1;

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

  [ -z "${PACKAGE}" ] && PACKAGE="tlspuffin"

  cp -apr "${THEJOB_OUT_PATH}/repo/." . || return 1;
  rm -f ./.unsupported

  local cputs=false
  ComputeBuildRuntimeInfo "${PACKAGE}" "${vendor}" features cputs || {
      echo "Failed to compute runtime info for vendor '${vendor}' '${features}'"
      return 1;
  }

  # the experiment cannot run as required: record it and skip the next steps of this attempt
  if [ -n "${COMPAT_UNSUPPORTED}" ]; then
    echo "${COMPAT_UNSUPPORTED}"
    echo "${COMPAT_UNSUPPORTED}" > ./.unsupported
    echo "{ \"package\": \"${PACKAGE}\", \"cputs\": ${cputs}, \"vendor\": \"${vendor}\", \"features\": \"${features}\", \"flags\": \"${extra_flags}\", \"unsupported\": \"${COMPAT_UNSUPPORTED}\", \"compat\": $( CompatAppliedJSON ), \"compat_warning\": $( CompatWarningJSON ) }" > "${THEJOB_OUT_PATH}/cli-${THEJOB_STEP_ID}.json"
    echo "{ \"unsupported\": \"${COMPAT_UNSUPPORTED}\" }" >> "${THEJOB_USER_STATE_FILE}"
    return 0;
  fi
  local featuresCLI='';
  [ -n "${features}" ] && featuresCLI="--features=${features}";

  if ${cputs}; then
    rm -rf ./vendor
    echo "nix-shell --run \"./tools/mk_vendor make '${vendor}'\""
    nix-shell --run "./tools/mk_vendor make '${vendor}'"
  fi

  rm -rf ./seeds
  echo "nix-shell --run \"cargo run --release --bin \"${PACKAGE}\" ${featuresCLI} -j ${THEJOB_NB_CORES} -- seed\""
  $( NoAslrPrefix ) nix-shell --run "cargo run --release --bin \"${PACKAGE}\" ${featuresCLI} -j ${THEJOB_NB_CORES} -- seed" || return 1;

  rm -rf ./experiments
  echo "nix-shell --run \"exec ${PREFIX_FAKETIME} cargo run --bin \"${PACKAGE}\" --release ${featuresCLI} -- help\""
  $( NoAslrPrefix ) nix-shell --run "exec ${PREFIX_FAKETIME} cargo run --bin \"${PACKAGE}\" --release ${featuresCLI} -- help" > ./.fuzzer_help.txt || return 1
  cat ./.fuzzer_help.txt
  CompatVerifyHelp ./.fuzzer_help.txt || return 1;

  # kept in the working directory shared with the experiment step (recorded in cli-<step>.json)
  local asanInfo='';
  DetectAsan "./target/release/${PACKAGE}" "${features}" "${vendor}" asanInfo || return 1;
  echo "ASAN: ${asanInfo}";
  echo "${asanInfo}" > ./.asan_info.json;
  local vendorSources='';
  DetectVendorSources vendorSources || return 1;
  echo "Vendor sources: ${vendorSources}";
  echo "${vendorSources}" > ./.vendor_sources.json;
  local vendorVulnerabilities; vendorVulnerabilities=$( DetectVendorVulnerabilities "${vendor}" );
  echo "Declared vulnerabilities: ${vendorVulnerabilities}";
  echo "${vendorVulnerabilities}" > ./.vendor_vulnerabilities.json;
  return 0;
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

  # on the run's cores, beside the fuzzer: lowest priority, as the other checks of the run
  renice -n 19 -p "${BASHPID}" > /dev/null 2>&1;
  local now=$(date +%s)
  # machine load during the run, a sample per call (every minute): time, 1-minute load average, cores of the machine
  # (RecordLoad; nproc without --all counts the cores of this step only)
  printf '%s %s %s\n' "${now}" "$( cut -d' ' -f1 /proc/loadavg 2> /dev/null )" "$( nproc --all 2> /dev/null )" >> ./.load_samples 2> /dev/null

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
    # the same facts as one JSON line at the end (#MONITOR_JSON), read by the board (joblauncher.js describeMonitor)
    local port='' buildInfo='' asanState='' logMB='' logRate='' logWarning='' default_put=''
    local corpus_count='' last_corpus_elapsed='' nb_errors=0 nb_crashes=0 last_lines='' objective_count=0
    local last_objective_elapsed='' recentObjectives='' liveURL=''
    echo -n "# Experiment: $exp_name" >> ${outfile}
    if [ -f "$README" ]; then
      port=$(head -n 100 "$README" | grep "Port:" | cut -d' ' -f2-)
      echo -n "  ${port}" >> ${outfile}
    fi
    echo -e "\n  Time since last stats.json update: ${elapsed}s" >> ${outfile}

    [ -s ./.build_info ] && buildInfo="$( < ./.build_info )" && echo "  Build: ${buildInfo}" >> ${outfile}
    if [ -s ./.asan_info.json ]; then
      local asanInfo=$( < ./.asan_info.json );
      asanState='? (not verified)';
      [[ "${asanInfo}" == *'"instrumented": true'* ]] && asanState="✓ ($( sed -n 's/.*"runtime": "\([^"]*\)".*/\1/p' <<< "${asanInfo}" ) runtime)";
      [[ "${asanInfo}" == *'"instrumented": false'* ]] && asanState='✗ (not instrumented)';
      echo "  ASAN: ${asanState}" >> ${outfile}
    fi

    local logStats='';
    if ExperimentLogStats "$exp" logStats; then
      logMB=$( sed -n 's/.*"estimated_mb": \([0-9]*\).*/\1/p' <<< "${logStats}" )
      logRate=$( sed -n 's/.*"mb_per_core_hour": \([0-9.]*\).*/\1/p' <<< "${logStats}" )
      logWarning=$( sed -n 's/.*"warning": "\([^"]*\)".*/\1/p' <<< "${logStats}" )
      echo "  Logs: ~${logMB} MB${logRate:+ (${logRate} MB per hour per core)}${logWarning:+ ⚠️ ${logWarning}}" >> ${outfile}
    fi

    if ! ${old_tlspuffin}; then
      # Default PUT info from log
      local log_file="$exp/log/stats_puffin_main_broker.log"
      if [ -f "$log_file" ]; then
        default_put=$(head -n 100 "$log_file" | grep "Default PUT:" | head -n1 | sed 's/^[ \t]*//' | cut -d' ' -f2-)
        if [ -n "$default_put" ]; then
          echo "  $default_put" >> ${outfile}
        else
          if [ -f "$README" ]; then
            default_put=$(head -n 100 "$README" | grep "Default PUT:" | cut -d' ' -f2-)
            echo "  ${default_put}" >> ${outfile}
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
      corpus_count=$(find "$corpus_dir" -type f -name "*.trace" ! -name ".*" | wc -l)
      local last_corpus=$(find "$corpus_dir" -type f -name "*.trace" ! -name ".*" -printf "%T@ %Tc\n" | sort -nr 2>/dev/null | head -n1 | cut -d' ' -f2-)
      local last_corpus_time=$(find "$corpus_dir" -type f -name "*.trace" ! -name ".*" -printf "%T@\n" | sort -nr 2>/dev/null | head -n1 | cut -d. -f1)
      now=$(date +%s)
      last_corpus_elapsed=$(( (now - last_corpus_time) / 60 ))
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
          nb_errors=$(grep -c ERROR "$log_file")
          echo -n "${nb_errors} errors, " >> ${outfile}
          nb_crashes=$(grep -c CRASH "$log_file")
          echo "${nb_crashes} crashes" >> ${outfile}
          last_lines=$(grep ERROR "$log_file" | grep "\[" | tail -n 1  | cut -c1-180)
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

    # clients the fuzzer could not restart after a crash (LostClients): the experiment ends at the next check
    local lost_clients; lost_clients=$( LostClients "$exp" );
    (( lost_clients > 0 )) && echo "   --> ⚠️ ${lost_clients} client(s) lost after a crash: the fuzzer could not restart them" >> ${outfile}

    # Objective info
    local objective_dir="$exp/objective"
    if [ -d "$objective_dir" ]; then
      objective_count=$(find "$objective_dir" -type f -name "*.trace" ! -name ".*" | wc -l)
      # Display the following if obejctive_count is greater than 0
      if [ "$objective_count" -gt 0 ]; then
        local last_objective=$(find "$objective_dir" -type f -name "*.trace" ! -name ".*" -printf "%T@ %Tc %p\n" | sort -nr 2>/dev/null | head -n1 | cut -d' ' -f2-)
        local last_objective_time=$(find "$objective_dir" -type f -name "*.trace" ! -name ".*" -printf "%T@\n" | sort -nr 2>/dev/null | head -n1 | cut -d. -f1)
        local now=$(date +%s)
        last_objective_elapsed=$(( (now - last_objective_time) / 60 ))
        local mark='🎉 '; [ "${OBJECTIVES_EXPECTED:-false}" == true ] && mark='';  # expected in VulnA/VulnB
        echo "    ==> ${mark}Objective: $objective_count file(s), last modified: $last_objective_elapsed minutes ago - $last_objective" >> ${outfile}
        # newest objectives; they are replayed and grouped by bug at the end of the run (ExperimentReplayObjectives)
        find "$objective_dir" -maxdepth 1 -type f -name '*.trace' ! -name '.*' -printf '%T@ %f\n' | sort -nr | head -n 5 |
        while read -r objective_time objective_name; do
          echo "        $(( (now - ${objective_time%.*}) / 60 )) min ago: ${objective_name}" >> ${outfile}
        done
        recentObjectives=$( find "$objective_dir" -maxdepth 1 -type f -name '*.trace' ! -name '.*' -printf '%T@ %f\n' |
            sort -nr | head -n 5 | while read -r objective_time objective_name; do
              echo "$(( (now - ${objective_time%.*}) / 60 )) ${objective_name}"; done )
        liveURL="http://$( hostname -f 2> /dev/null || hostname ):10083/html/objectives/live-${THEJOB_TASK_ID}.html"
        echo "        (live, grouped by bug: page objectives/live-${THEJOB_TASK_ID}.html of the publisher, ${liveURL}; at the end of the run: 🐞 on the dashboard)" >> ${outfile}
      else
        echo "    No objective yet ✓" >> ${outfile}
      fi
    else
      echo "  Objective: Directory not found" >> ${outfile}
    fi
    if command -v jq > /dev/null; then
      jq -cn --arg experiment "${exp_name}" --arg port "${port}" --arg stats_age_s "${elapsed}" \
          --arg build "${buildInfo}" --arg asan "${asanState}" --arg logs_mb "${logMB}" \
          --arg logs_rate "${logRate}" --arg logs_warning "${logWarning}" --arg put "${default_put}" \
          --arg corpus "${corpus_count}" --arg corpus_age_min "${last_corpus_elapsed}" \
          --arg errors "${nb_errors:-0}" --arg crashes "${nb_crashes:-0}" --arg last_error "${last_lines}" \
          --arg objectives "${objective_count:-0}" --arg objective_age_min "${last_objective_elapsed}" \
          --arg recent "${recentObjectives}" --arg live "${liveURL}" --arg lost "${lost_clients:-0}" '
        def num: if . == "" then null else (tonumber? // null) end;
        { experiment: $experiment, port: $port, stats_age_s: ($stats_age_s | num), build: $build, asan: $asan,
          logs: { mb: ($logs_mb | num), rate: ($logs_rate | num), warning: $logs_warning }, put: $put,
          corpus: { count: ($corpus | num), age_min: ($corpus_age_min | num) },
          errors: { count: ($errors | num), crashes: ($crashes | num), last: $last_error }, lost_clients: ($lost | num),
          objectives: { count: ($objectives | num), age_min: ($objective_age_min | num), live: $live,
                        recent: [ $recent | splits("\n") | select(length > 0)
                                  | capture("^(?<age_min>-?[0-9]+) (?<name>.*)$") | .age_min |= tonumber ] } }' |
          sed 's/^/#MONITOR_JSON /' >> ${outfile}
    fi
    echo "" >> ${outfile}
  fi
}
