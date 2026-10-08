# VulnA/VulnB look for known bugs: an objective is the expected outcome, not news (no 🎉 in the monitor message,
# see PR_common.sh; the board, the History and the objectives pages follow the job type)
OBJECTIVES_EXPECTED=true

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
  # verdict of each objective, by name: targeted / not-targeted (OBJECTIVES_NOT_TARGETED) / pending (no record yet)
  # the bench's own checks share the run's cores with the fuzzer: lowest priority (nice 19, never starved), so that
  # they never take CPU from it; the fuzzer, started before, keeps its priority
  renice -n 19 -p "${BASHPID}" > /dev/null 2>&1;
  # the fuzzer's records read once per log file (FuzzerRecords): only the new log data on each check
  export FUZZER_RECORDS_CACHE="${PWD}/.fuzzer_records";
  local -A verdicts=();
  while true; do
    # the vital check first: a slow objective check must not delay it
    local currentProblems='';
    ExperimentCheckAllThreadsRunning "${tlspuffin_pid}" statssize lastcheck "${stats}" "${THEJOB_NB_CORES}" currentProblems || break;
    if TargetedObjectiveFound verdicts; then
      echo "FOUND OBJECTIF, END PROCESS" >&2
      ref_goal_success=1
      break;
    fi

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

# TargetedObjectiveFound <verdicts (assoc array, kept between calls)>: true when an objective of the experiment is a
# targeted one. An objective the fuzzer recorded as a claim of OBJECTIVES_NOT_TARGETED (PR_common.sh) does not count;
# one without record yet is looked at again on the next call, then counts (as before: any objective ended the run).
# The fuzzer's logs are read only when an objective has no verdict yet.
TargetedObjectiveFound() {
  local -n ref_verdicts=$1;
  local expDir trace name records rc found=1;
  # the expected bug of the preset (vuln_targets.json); none declared: any objective but OBJECTIVES_NOT_TARGETED
  local target; target=$( ExpectedTarget "${vendor:-}" );
  for expDir in experiments/*/; do
    [ -d "${expDir}objective" ] || continue;
    records='';
    while IFS= read -r trace; do
      name=$( basename "${trace}" .trace );
      case "${ref_verdicts[${name}]:-}" in
        targeted) found=0; continue;;
        not-targeted) continue;;
      esac
      [ -n "${records}" ] || records=$( FuzzerRecords "${expDir}log" );
      ObjectiveTargeted "${records}" "${name}" "${target}"; rc=$?;
      if (( rc == 1 )); then
        ref_verdicts[${name}]=not-targeted;
        echo "objective ${name}: not targeted ($( NotTargetedCVE "$( FuzzerVerdict "${records}" "${name}" | cut -f2 )" "$( cat ./.build_info 2> /dev/null )" || echo '?' )), the experiment goes on" >&2;
      elif (( rc == 3 )); then
        # another bug than the expected one: kept, the replay at the end may still find the expected bug in it
        ref_verdicts[${name}]=not-targeted;
        echo "objective ${name}: not the expected bug (${target%%|*}), the experiment goes on: $( FuzzerVerdict "${records}" "${name}" | cut -f1-3 | tr '\t' ' ' )" >&2;
      elif (( rc == 0 )); then
        ref_verdicts[${name}]=targeted; found=0;
        [ -n "${target}" ] && echo "objective ${name}: the expected bug (${target%%|*}), end of the experiment" >&2;
      elif [ "${ref_verdicts[${name}]:-}" == pending ]; then
        # still no record: as before, it ends the experiment when no target is declared, or when the fuzzer records
        # nothing at all (no log, or a fuzzer that does not log its objectives, e.g. LibAFL 0.11.2 commits such as
        # 1957fba: waiting for a record there ran every VulnA run to its timeout); with a target and a fuzzer that
        # records its objectives, the replay at the end decides
        if [ -n "${target}" ] && [ -n "${records}" ]; then
          ref_verdicts[${name}]=not-targeted;
          echo "objective ${name}: no record in the fuzzer's logs, the experiment goes on (the replay decides)" >&2;
        else
          ref_verdicts[${name}]=targeted; found=0;
          [ -n "${target}" ] && echo "objective ${name}: the fuzzer records no objective (no log of them), the first objective ends the experiment as before; the replay at the end tells the bug" >&2;
        fi
      else
        ref_verdicts[${name}]=pending;
      fi
    done < <( find "${expDir}objective" -maxdepth 1 -type f -name '*.trace' ! -name '.*' 2> /dev/null )
  done
  return "${found}";
}

# TargetedNames <experiment dir>: the names of its targeted objectives, oldest first (at most 3: enough evidence)
TargetedNames() {
  local dir="$1" trace name records target;
  target=$( ExpectedTarget "${vendor:-}" );
  records=$( FuzzerRecords "${dir}/log" );
  while IFS= read -r trace; do
    name=$( basename "${trace}" .trace );
    ObjectiveTargeted "${records}" "${name}" "${target}" && echo "${name}";
  done < <( find "${dir}/objective" -maxdepth 1 -type f -name '*.trace' ! -name '.*' -printf '%T@ %p\n' 2> /dev/null | sort -n | cut -d' ' -f2- ) | head -n 3;
}

# ObjectiveCounts <experiment dir>: "<targeted> <not targeted> <first targeted> <unexpected>" objectives of a finished
# experiment; the third field is when the fuzzer saved the first targeted objective (ms since the epoch, from its name:
# <UTC yyyymmdd-HHMMSSmmm>-<hash>), empty when none: the time to find, instead of the end of the experiment (the
# monitor looks once a minute, then the fuzzer has to stop). With an expected bug declared (vuln_targets.json), an
# objective is targeted when the fuzzer's record or its replay (objective-reports/, ExperimentReplayObjectives) is that
# bug: a crash the fuzzer logged without backtrace counts when the replay shows the expected frame
ObjectiveCounts() {
  local dir="$1" trace name targeted=0 excluded=0 unexpected=0 first='' t records rc sig rtype rframes;
  local target; target=$( ExpectedTarget "${vendor:-}" );
  records=$( FuzzerRecords "${dir}/log" );
  while IFS= read -r trace; do
    name=$( basename "${trace}" .trace );
    ObjectiveTargeted "${records}" "${name}" "${target}"; rc=$?;
    if [ -n "${target}" ] && (( rc != 0 && rc != 1 )) && [ -f "${dir}/objective-reports/${name}.txt" ]; then
      sig=$( ObjectiveSignature < "${dir}/objective-reports/${name}.txt" );
      IFS=$'\t' read -r rtype rframes _ <<< "${sig}";
      case "${rtype}" in no-crash|replay-error) ;;
        security-violation) TargetMatches "${target}" claim "${rframes}" "" && rc=0;;
        *) TargetMatches "${target}" crash "" "${rframes}" && rc=0;;
      esac
    fi
    if (( rc == 1 )); then
      excluded=$(( excluded + 1 ));
    elif [ -n "${target}" ] && (( rc != 0 )); then
      unexpected=$(( unexpected + 1 ));
    else
      targeted=$(( targeted + 1 ));
      t=$( date -u -d "$( sed -E 's/^([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{3}).*/\1-\2-\3 \4:\5:\6.\7/' <<< "${name}" )" +%s%3N 2> /dev/null ) || t='';
      [ -n "${t}" ] && { [ -z "${first}" ] || (( t < first )); } && first="${t}";
    fi
  done < <( find "${dir}/objective" -maxdepth 1 -type f -name '*.trace' ! -name '.*' 2> /dev/null )
  echo "${targeted} ${excluded} ${first:--} ${unexpected}";
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
  ExperimentSaveLogStats "${experiment_base}";

  local errorFile="${THEJOB_ARTEFACTS_PATH}/${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-log/error.log"
  local errorFilePresent='false';
  [ -r "${errorFile}" ] && grep -q "Timeout in fuzz run" "${errorFile}" && errorFilePresent='true';
  
  # every objective up to 100 (as Perf), the targeted ones first: on 2,616 VulnA/VulnB runs of cassis, pesto and cacio a
  # run found at most 33 (99 % at most 11), and a replay costs ~4 s (up to ~16 s when retried): the cap of 10 left
  # the objective a run ended on unreplayed when many of CVE-2024-5814 came before it
  local firstNames="${experiment_base}/.targeted-names";
  TargetedNames "${experiment_base}" > "${firstNames}";
  (( objective_count > 0 )) && ExperimentReplayObjectives "${experiment_base}" 100 120 "${firstNames}";

  local outFile="${THEJOB_OUT_PATH}/summary-${THEJOB_STEP_ID}-${THEJOB_STEP_ATTEMPT_ID}.json"
  local statsJSON;
  if statsJSON=$( FindFile "${experiment_base}" "stats.json" "log/stats.json" ); then
    # targeted / not targeted objectives (OBJECTIVES_NOT_TARGETED): success needs a targeted one
    local targeted excluded first unexpected;
    read -r targeted excluded first unexpected <<< "$( ObjectiveCounts "${experiment_base}" )";
    [ "${first}" == - ] && first='';
    "${THEJOB_TOOLS_PATH}/qjs" --std "${THEJOB_TOOLS_PATH}/js/vuln_experiment_end.js" task.json "${LIBAFL_VERSION}" "${statsJSON}" "${objective_count}" "${errorFilePresent}" "${experimentUUID}" "${outFile}" "${targeted:-${objective_count}}" "${excluded:-0}" "${first}" "${unexpected:-0}" "$( ExpectedTarget "${vendor:-}" | cut -d'|' -f1 )" >> "${THEJOB_USER_STATE_FILE}"
    RecordLoad "${outFile}"
  else
    echo '{ "error": "stats.json not found" }' > "${outFile}"
  fi
}

SummaryRun () {
  [ -z "${COMMIT_ID}" ] && COMMIT_ID="main"
  [ -z "${TYPE}" ] && TYPE="vuln"
  CreateArtefact "./summary.json" "summary.json" "commit_id:${COMMIT_ID}"
  "${THEJOB_TOOLS_PATH}/qjs" --std "${THEJOB_TOOLS_PATH}/js/vuln_summary_run.js" "${COMMIT_ID}" "${THEJOB_TASK_ID}" "${TYPE}" "${THEJOB_ARTEFACTS_PATH}" "${THEJOB_OUT_PATH}" ./summary.json || return 1;
  SummaryAddBench ./summary.json;
  return 0;
}
