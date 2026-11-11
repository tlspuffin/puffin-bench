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
  [ -r ./.unsupported ] && { echo "Skipped: $( < ./.unsupported )"; return 0; }
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
  [ -r ./.unsupported ] && { echo "Skipped: $( < ./.unsupported )"; return 0; }
  ExperimentEndCommon || return 1;

  local experimentUUID=-1;
  local experiment_base='';
  local objective_count=0;
  ExperimentReport experimentUUID experiment_base objective_count || return 1;
  ExperimentSaveLogStats "${experiment_base}";
  local outFile="${THEJOB_OUT_PATH}/summary-${THEJOB_STEP_ID}-${THEJOB_STEP_ATTEMPT_ID}.json"
  local statsJSON;
  if [ ! -s task.json ]; then
    echo '{ "error": "task.json not available" }' > "${outFile}"
  elif statsJSON=$( FindFile "${experiment_base}" "stats.json" "log/stats.json" ); then
    "${THEJOB_TOOLS_PATH}/qjs" --std "${THEJOB_TOOLS_PATH}/js/perf_experiment_end.js" task.json "${LIBAFL_VERSION}" "${statsJSON}" "${objective_count}" "${experimentUUID}" "${outFile}" >> "${THEJOB_USER_STATE_FILE}"
    RecordLoad "${outFile}"
  else
    echo '{ "error": "stats.json not found" }' > "${outFile}"
  fi
  (( objective_count > 0 )) || return 0;
  ExperimentReplayObjectives "${experiment_base}" 100 120;

  return 0;
}

SummaryRun () {
  [ -z "${COMMIT_ID}" ] && COMMIT_ID="main"
  [ -z "${TYPE}" ] && TYPE="perf"
  [ -z "${CAMPAIGN_ID}" ] && CAMPAIGN_ID="N/A"
  CreateArtefact "./summary.json" "summary.json" "commit_id:${COMMIT_ID}"
  "${THEJOB_TOOLS_PATH}/qjs" --std "${THEJOB_TOOLS_PATH}/js/perf_summary_run.js" "${COMMIT_ID}" "${THEJOB_USER}" "${THEJOB_TASK_ID}" "${TYPE}" "${CAMPAIGN_ID}" "${THEJOB_ARTEFACTS_PATH}" "${THEJOB_OUT_PATH}" ./summary.json
  local flagObjective=$?
  SummaryAddBench ./summary.json;
  (( flagObjective == 2 )) && return 1;
  if [ "${flagObjective}" == '0' ]; then
    Flag '{"color": "#6f6f00"}';
  fi
  return 0;
}

# ── Perf runs: one build per library, two runs per physical core ──
# BuildOnce builds the library once (ForcedBuild, in SharedBuildDir) for all the runs of the task. Each TwinExperiment
# step holds the 2 threads of one physical core (SMT_MODE=pairs, set by the job's flow) and runs two independent
# one-client fuzzers of that build, one per thread, started together and stopped together (the step's timeout),
# recorded as runs 2k and 2k+1 (k: the attempt of the step), each in its own folder (twin0, twin1). On the same cores,
# twice as many runs as one 2-client run per core, all with the same neighbour: a smaller change is seen (a run
# varies by about 12 %, from its fuzzing path). See docs/tlspuffin-job-scripts.md.

SharedBuildDir() { echo "${THEJOB_OUT_PATH}/build-${THEJOB_STEP_ID}"; }

BuildOnce() {
  local dir; dir=$( SharedBuildDir )
  rm -rf "${dir}" && mkdir -p "${dir}" || return 1
  ( cd "${dir}" && ForcedBuild "${@}" )
}

# the folder of one run: the build's binary, seeds and vendor libraries linked, its records and nix shell copied
TwinRunDir() {
  local build entry; build=$( SharedBuildDir )
  [ -r "${build}/.unsupported" ] && { cp "${build}/.unsupported" .; return 0; }
  [ -x "${build}/target/release/${PACKAGE:-tlspuffin}" ] || { echo "no build in ${build}"; return 1; }
  for entry in seeds target vendor; do
    [ -e "${build}/${entry}" ] && ln -sfn "${build}/${entry}" "./${entry}"
  done
  for entry in .asan_info.json .vendor_sources.json .vendor_vulnerabilities.json client_log_config.yml shell.nix; do
    [ -e "${build}/${entry}" ] && cp -a "${build}/${entry}" .
  done
  return 0
}

# one fuzzer of the build on THEJOB_CORES, from this folder: what ExperimentRunWithCargo runs, without cargo (the
# binary it would run, with the ASAN_OPTIONS cargo would give it); the fuzzer's stderr also kept in ./.fuzzer_stderr
TwinLaunch() {
  local -n ref_twin_pid=$1 ref_twin_killed=$2 ref_twin_stats=$3
  local build; build=$( SharedBuildDir )
  [ -z "${PACKAGE}" ] && PACKAGE="tlspuffin"
  echo "${THEJOB_STEP_UUID}" > .thejob_uuid
  CompatApplyFlags extra_flags;
  local last_core=0;
  ExperimentSetupForCargo last_core features || return 1;
  CompatApplyFiles || return 1;
  local cores="";
  (( AFL_CORES_GRAMMAR == 0 )) && cores="0-${last_core}" || cores="${THEJOB_CORES}"
  local binary="./target/release/${PACKAGE}"
  if [ -z "${ASAN_OPTIONS+x}" ]; then
    local asan; asan=$( CargoAsanOptions "${build}" )
    [ -n "${asan}" ] && export ASAN_OPTIONS="${asan}"
  fi
  echo "nix-shell --run exec ${PREFIX_FAKETIME} ${binary} --cores ${cores} --port ${RESERVED_PORT} ${extra_flags} experiment -d \"${experiment}\" -t \"${experiment}\" (ASAN_OPTIONS=${ASAN_OPTIONS:-unset})"
  # (the replays need .currentcmd and run what .currentlaunch records)
  echo "exec ${PREFIX_FAKETIME} ${binary}" > .currentcmd
  ExperimentSaveExecution "${binary}" "${extra_flags}" false
  THEJOB_STDERR_PATH="${PWD}/.fuzzer_stderr" ExperimentSaveLaunchInfo
  $( NoAslrPrefix ) nix-shell --run "exec ${PREFIX_FAKETIME} \"${binary}\" --cores ${cores} --port ${RESERVED_PORT} ${extra_flags} experiment -d \"${experiment}\" -t \"${experiment}\"" \
      2> >( tee -a ./.fuzzer_stderr >&2 ) &
  ref_twin_pid=$!
  echo "tlspuffin monitored pid is ${ref_twin_pid} (CPU ${THEJOB_CORES})" >&2
  ref_twin_killed=0
  if ! ExperimentPostLaunchSetup ref_twin_stats "${ref_twin_pid}" 1 "${features:-none}"; then
    echo "KILLING tlspuffin, experiment post launch setup failed" >&2
    kill -9 "${ref_twin_pid}" 2> /dev/null;
    ref_twin_killed=1
  fi
  return 0
}

TwinRun() {
  TwinRunDir || return 1
  [ -r ./.unsupported ] && { echo "Skipped: $( < ./.unsupported )"; return 0; }
  local pid=0 killed=0 stats=''
  TwinLaunch pid killed stats || return 1
  # (ExperimentCheckRun prints nothing on stdout: its exit status, the fuzzer's when it had to end it, is the result)
  local status=1
  (( killed == 0 )) && { ExperimentCheckRun "${pid}" "${stats}"; status=$?; }
  # ended before the step's timeout (its fuzzer died, hung or did not start) while the other run may go on: its own
  # end, for ExperimentReport
  echo "${status}" > ./.run_ended
  return ${status}
}

# TwinEach <function>: the function run for both runs of the step at once, each in its folder, on its CPU only (all its
# processes: older LibAFL takes --cores 0-0 as the first CPU it may use), with its run number and one client
# (./.step_run, for ExperimentReport), its output prefixed with its run. Two CPUs of one physical core: CPU sharing
# "twin" (recorded with the run); otherwise (a machine without hardware threads, a pool without whole cores) the mode
# the scheduler gave, so that Results shows the runs as not comparable.
TwinEach() {
  local fn="$1" cpus i rc=0 mode="${THEJOB_SMT_MODE:-any}"
  IFS=, read -r -a cpus <<< "${THEJOB_CORES}"
  (( ${#cpus[@]} == 2 )) || { echo "a twin step needs 2 CPUs, got ${THEJOB_CORES}"; return 1; }
  local siblings; siblings=$( cat "/sys/devices/system/cpu/cpu${cpus[0]}/topology/thread_siblings_list" 2> /dev/null )
  [[ ",${siblings//-/,}," == *",${cpus[1]},"* ]] && [ -z "${THEJOB_CORES_IDLE}" ] && mode=twin
  local -a pids=()
  for i in 0 1; do
    local run=$(( THEJOB_STEP_ATTEMPT_ID * 2 + i ))
    mkdir -p "twin${i}" && echo "${run} 1" > "twin${i}/.step_run" || return 1
    ( taskset -cp "${cpus[i]}" "${BASHPID}" > /dev/null && cd "twin${i}" &&
        THEJOB_CORES="${cpus[i]}" THEJOB_NB_CORES=1 THEJOB_CORES_IDLE='' THEJOB_SMT_MODE="${mode}" \
        THEJOB_STEP_ATTEMPT_ID="${run}" THEJOB_MONITOR_PARAMETERS_PATH='' "${fn}" ) \
        > >( sed -u "s/^/[run ${run}] /" ) 2> >( sed -u "s/^/[run ${run}] /" >&2 ) &
    pids+=( $! )
  done
  for i in "${pids[@]}"; do wait "${i}" || rc=1; done
  return ${rc}
}

# the step's monitor, for both runs (TwinExperimentMonitor), started once here: the runs do not start their own
TwinExperiment() {
  [ -n "${THEJOB_MONITOR_PARAMETERS_PATH}" ] && StartMonitor
  TwinEach TwinRun
}

TwinExperimentEnd() { TwinEach ExperimentEnd; }

# ValidateObjectives (PR_validate.sh) of both runs, one after the other in its folder under its run number (its result:
# validation-<step>-<run>.json, as ExperimentEnd's): with the cores of this step, not one CPU each; the libraries and the
# binary of the validation are built once, the second run takes them from their caches
TwinValidateObjectives() {
  local i run rc=0
  for i in 0 1; do
    [ -r "twin${i}/.step_run" ] || continue
    read -r run _ < "twin${i}/.step_run"
    ( cd "twin${i}" && THEJOB_STEP_ATTEMPT_ID="${run}" ValidateObjectives ) || rc=1
  done
  return ${rc}
}

# MonitorExperiment of both runs: their messages one after the other, and the facts of the two for the board (one
# #MONITOR_JSON line: counts added up, the oldest stats and corpus, the newest objectives)
TwinExperimentMonitor() {
  local outfile; outfile=$( realpath -m "$1" )
  local i run part facts=''
  for i in 0 1; do
    [ -r "twin${i}/.step_run" ] || continue
    read -r run _ < "twin${i}/.step_run"
    part="${outfile}.twin${i}"
    : > "${part}"
    ( cd "twin${i}" && MonitorExperiment "${part}" )
    echo "## Run ${run}" >> "${outfile}"
    grep -v '^#MONITOR_JSON ' "${part}" >> "${outfile}"
    facts+="$( sed -n 's/^#MONITOR_JSON //p' "${part}" )"$'\n'
    rm -f "${part}"
  done
  command -v jq > /dev/null && [ -n "${facts//$'\n'/}" ] || return 0
  jq -cs 'def total(f): [.[] | f | numbers] | add; def most(f): [.[] | f | numbers] | max;
      def least(f): [.[] | f | numbers] | min; def texts(f): [.[] | f | select(. != null and . != "")] | unique | join("; ");
    { experiment: texts(.experiment), port: texts(.port), stats_age_s: most(.stats_age_s), build: .[0].build,
      asan: (first(.[] | .asan | select(. != "" and (startswith("✓") | not))) // .[0].asan),
      logs: { mb: total(.logs.mb), rate: most(.logs.rate), warning: texts(.logs.warning) }, put: .[0].put,
      corpus: { count: total(.corpus.count), age_min: most(.corpus.age_min) },
      errors: { count: total(.errors.count), crashes: total(.errors.crashes), last: texts(.errors.last) },
      lost_clients: total(.lost_clients),
      objectives: { count: total(.objectives.count), age_min: least(.objectives.age_min),
                    live: (first(.[] | .objectives.live | select(. != null and . != "")) // ""),
                    recent: ([.[].objectives.recent[]?] | sort_by(.age_min) | .[:5]) } }' <<< "${facts}" |
      sed 's/^/#MONITOR_JSON /' >> "${outfile}"
}
