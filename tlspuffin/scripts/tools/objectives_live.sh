#!/bin/bash
#
# Live objectives of the running tasks: replays the objectives found since the last call and updates one page per
# task (/html/objectives/live-<task>.html) and an index (/html/objectives/live.html), served by the publisher.
#
# Meant to run from cron, pinned to the core the scheduler never assigns (core 0) at idle priority, so that it does
# not take time from the fuzzing cores:
#   */5 * * * * taskset -c 0 chrt -i 0 nice -n 19 bash objectives_live.sh
# It never calls cargo (which could rebuild the binary of a running fuzzer): it runs the binary built for the
# experiment, in a working directory of its own, with the ASAN options of the commit (.cargo/config.toml).
#
#   PB_ROOT         install root (default /srv/puffin-bench)
#   PB_PUBLIC_URL   base URL of the publisher (default http://<host>:10083)
#   PB_LIVE_BUDGET  seconds of replays per call (default 240)
#   PB_LIVE_TIMEOUT timeout of a replay in seconds (default 60)

set -u
PB_ROOT="${PB_ROOT:-/srv/puffin-bench}"
URL="${PB_PUBLIC_URL:-http://$( hostname -f 2> /dev/null || hostname ):10083}"
BOARD_URL="${PB_BOARD_URL:-http://$( hostname -f 2> /dev/null || hostname ):10082}"
BUDGET="${PB_LIVE_BUDGET:-240}"
REPLAY_TIMEOUT="${PB_LIVE_TIMEOUT:-60}"
# a replay that ends without confirming a bug is tried again, up to this many times: a memory corruption in a library
# built without ASAN crashes or not depending on the memory layout
REPLAY_TRIES="${PB_LIVE_TRIES:-5}"
OUT="${PB_ROOT}/data/html/objectives"
STATE="${PB_ROOT}/data/objectives-live"
RUNS="${PB_ROOT}/data/runs"
API="${PB_SCHEDULER_API:-http://127.0.0.1:10082}"
TOOLS="$( dirname "$( realpath "${BASH_SOURCE[0]}" )" )"
source <( sed -n '/^ObjectiveSignature()/,/^}/p;/^FuzzerRecords()/,/^}/p;/^FuzzerRecordsOf()/,/^}/p;/^FuzzerVerdict()/,/^}/p;/^FuzzerVerdicts()/,/^}/p;/^FuzzerExcerpt()/,/^}/p;/^NotTargetedJSON()/,/^}/p' "${TOOLS}/../PR_common.sh" )
# the claims set apart (vuln_targets.json _not_targeted): claim -> "CVE|library|below" (see NotTargetedCVE)
declare -gA OBJECTIVES_NOT_TARGETED=()
source <( jq -r '"OBJECTIVES_NOT_TARGETED=(", (._not_targeted // {} | to_entries[] | "  [\(.key | @sh)]=\("\(.value.cve)|\(.value.library // "")|\(.value.below // "")" | @sh)"), ")"' "${TOOLS}/../../data/html/jobsscripts/tlspuffin/vuln_targets.json" 2> /dev/null )
declare -F ObjectiveSignature > /dev/null || { echo "ObjectiveSignature not found" >&2; exit 1; }
mkdir -p "${OUT}" "${STATE}" || exit 1

# one call at a time
exec 9> "${STATE}/.lock"
flock -n 9 || exit 0

start=$( date +%s )
OverBudget() { (( $( date +%s ) - start >= BUDGET )); }
# seconds left in the budget of this call (at least 1)
BudgetLeft() { local left=$(( BUDGET - ( $( date +%s ) - start ) )); (( left > 0 )) && echo "${left}" || echo 1; }

# ASAN options of the commit (as cargo run would set them), without leak detection
AsanOptions() {
  local opts;
  opts=$( sed -n 's/^ *ASAN_OPTIONS *= *"\(.*\)".*/\1/p' "$1/.cargo/config.toml" 2> /dev/null | head -1 );
  echo "${opts:-detect_leaks=0:abort_on_error=1}";
}

# llvm-symbolizer for ASAN reports with function names and lines (provided by the commit's nix-shell; the direct
# run looks for one in the Nix store)
Symbolizer() {
  command -v llvm-symbolizer 2> /dev/null && return 0;
  ls -1d /nix/store/*-llvm-*/bin/llvm-symbolizer 2> /dev/null | sort -V | tail -1;
}

# Replay <step dir> <trace> <report>: exactly the launch of the fuzzer when it was recorded (.currentlaunch, see
# ExperimentSaveExecution in PR_common.sh: same binary file, options, prefixes and ASAN_OPTIONS; not replayed when
# the binary changed since), in a working directory of its own, inside the commit's nix-shell when possible.
# Older experiments: the binary of .currentcmd, without options.
Replay() {
  local dir="$1" trace="$2" report="$3";
  local LAUNCH_BINARY='' LAUNCH_SHA256='' LAUNCH_PREFIX='' LAUNCH_NOASLR='' LAUNCH_FLAGS='' LAUNCH_ASAN_SET='' LAUNCH_ASAN_OPTIONS='';
  local bin asan noAslr='';
  if [ -r "${dir}/.currentlaunch" ]; then
    source "${dir}/.currentlaunch";
    bin="${LAUNCH_BINARY}";
    noAslr="${LAUNCH_NOASLR}";
    asan="${LAUNCH_ASAN_OPTIONS}";
    if [ -n "${LAUNCH_SHA256}" ] && [ "$( sha256sum "${bin}" 2> /dev/null | cut -d' ' -f1 )" != "${LAUNCH_SHA256}" ]; then
      { echo "binary changed since the experiment: ${bin} (not replayed, it would run another binary)"; echo "exit status: 125"; } > "${report}";
      return 1;
    fi
  else
    bin=$( sed -n 's/.*--bin "\{0,1\}\([A-Za-z0-9_-]*\)"\{0,1\}.*/\1/p' "${dir}/.currentcmd" 2> /dev/null | head -1 );
    bin="${dir}/target/release/${bin:-tlspuffin}";
    setarch "$( uname -m )" -R true > /dev/null 2>&1 && noAslr="setarch $( uname -m ) -R";
    asan=$( AsanOptions "${dir}" );
    LAUNCH_ASAN_SET=true;
  fi
  [ -x "${bin}" ] || { echo "binary not found: ${bin}" > "${report}"; return 1; }
  local work="${report%.txt}.work";
  mkdir -p "${work}";
  local asanCmd='unset ASAN_OPTIONS;';
  [ "${LAUNCH_ASAN_SET}" == true ] && printf -v asanCmd 'export ASAN_OPTIONS=%q;' "${asan}";
  local quotedBinary quotedTrace;
  printf -v quotedBinary '%q' "${bin}";
  printf -v quotedTrace '%q' "${trace}";
  local run="${asanCmd} export RUST_LOG=info; exec ${LAUNCH_PREFIX} ${quotedBinary} ${LAUNCH_FLAGS} execute ${quotedTrace}";
  local status=1;
  # a replay never runs past the budget of the call (the next cron call would be skipped by the lock)
  local left; left=$( BudgetLeft );
  local tNix=$(( REPLAY_TIMEOUT * 2 < left ? REPLAY_TIMEOUT * 2 : left ));  # nix-shell startup included
  local tDirect=$(( REPLAY_TIMEOUT < left ? REPLAY_TIMEOUT : left ));
  if [ -r "${dir}/shell.nix" ] && command -v nix-shell > /dev/null; then
    # (the group: bash reports a replay that dies of a signal, e.g. a reproduced crash, on its own stderr)
    { ( cd "${work}" &&
      timeout -k 5 "${tNix}" ${noAslr} nix-shell "${dir}/shell.nix" \
        --run "command -v llvm-symbolizer > /dev/null && export ASAN_SYMBOLIZER_PATH=\$( command -v llvm-symbolizer ); ${run}" ) \
        < /dev/null > "${report}" 2>&1; } 2> /dev/null;
    status=$?;
  fi
  # no nix-shell, or it could not start the binary: direct run
  if [ ! -s "${report}" ] || grep -qE '^error: |error while loading shared libraries' "${report}"; then
    local symbolizer; symbolizer=$( Symbolizer );
    { ( cd "${work}" &&
      env ${symbolizer:+ASAN_SYMBOLIZER_PATH="${symbolizer}"} timeout -k 5 "${tDirect}" ${noAslr} bash -c "${run}" ) \
        < /dev/null > "${report}" 2>&1; } 2> /dev/null;
    status=$?;
  fi
  echo "exit status: ${status}" >> "${report}";
  rm -rf "${work}";
}

# Is the task running or waiting? (run directories of tasks lost by a scheduler restart stay behind)
# The state of a live task is {"task": {...}}; "success" only appears, false, when the task does not exist.
# Returns 0 when running or waiting, 1 when finished or unknown, 2 when the scheduler gives no usable answer:
# then nothing may be dropped (a slow scheduler used to make the state and page of running tasks disappear).
TaskActive() {
  local state rc;
  state=$( curl -s --max-time 20 "${API}/api/task/$1/state" ) && [ -n "${state}" ] || return 2;
  jq -e '((.success // true) != false) and ([.. | objects | .state? | strings] | any(. == "Running" or . == "Pending"))' \
      <<< "${state}" > /dev/null 2>&1;
  rc=$?;
  (( rc <= 1 )) && return "${rc}" || return 2;
}

# Library of a step directory: the step running there (scheduler state), else a library name in the experiment name
StepLibrary() {
  local stateJSON="$1" key="$2" expName="$3";
  local lib;
  lib=$( jq -r --arg k "/${key}" '[.. | objects | select(.name? == "ExperimentWithCargo" or .name? == "Experiment")
      | select((.executor_data.run_path // "") | endswith($k)) | .id][0] // empty' <<< "${stateJSON}" 2> /dev/null );
  [ -n "${lib}" ] || lib=$( grep -oiE 'boringssl|openssl|libressl|wolfssl|libssh' <<< "${expName}" | tail -1 );
  echo "${lib:-${expName}}";
}

# Commit and name of a task, from its state ($1, JSON of /api/task/<id>/state): its arguments are [{key, value}]
TaskInfo() {
  jq -r '[([.task.args[]? | select(.key? == "COMMIT_ID") | .value] + [.task.args.COMMIT_ID? // empty])[0] // "?",
          (.task.name // "")] | @tsv' <<< "$1" 2> /dev/null || printf '?\t\n';
}

liveTasks='[]'
for taskDir in "${RUNS}"/[0-9]*; do
  [ -d "${taskDir}" ] || continue;
  task=$( basename "${taskDir}" );
  TaskActive "${task}" || continue;
  taskJSON=$( curl -s --max-time 5 "${API}/api/task/${task}/state" );
  taskState="${STATE}/${task}";
  mkdir -p "${taskState}";
  # state of the format before <library>-<attempt> (keyed by step directory, e.g. 1-0-2): the same attempts again
  rm -f "${taskState}"/[0-9]*-[0-9]*-[0-9]*.*;
  # An attempt is kept under <library>-<attempt>, the name of its archive (see below), so that it is counted
  # once whether it was seen running, archived, or both.
  # Running attempts: <step dir>/experiments/<name>/objective
  while IFS= read -r objDir; do
    expDir=$( dirname "${objDir}" );
    stepDir=$( dirname "$( dirname "${expDir}" )" );
    key=$( basename "${stepDir}" );
    expName=$( basename "${expDir}" );
    library=$( StepLibrary "${taskJSON}" "${key}" "${expName}" );
    id="${library}-${key##*-}";
    tsv="${taskState}/${id}.tsv";
    touch "${tsv}";
    echo "${library}" > "${taskState}/${id}.lib";
    # (the step directory goes away when its attempt ends, possibly during this scan)
    find "${objDir}" -maxdepth 1 -type f -name '*.trace' ! -name '.*' -printf '%T@ %p\n' 2> /dev/null | sort -n > "${taskState}/${id}.allt";
    cut -d' ' -f2- "${taskState}/${id}.allt" > "${taskState}/${id}.all";
    # what the fuzzer saw when it saved each objective (its logs: crash and backtrace, or claim)
    records=$( FUZZER_RECORDS_CACHE="${taskState}/fzcache" FuzzerRecords "${expDir}/log" );
    printf '%s\n' "${records}" > "${taskState}/${id}.records";
    while IFS= read -r trace; do
      name=$( basename "${trace}" .trace );
      grep -q "^${name}	" "${tsv}" && continue;
      OverBudget && break;
      # the attempt may end (its step directory is removed) during the scan: its archive then gives the result
      found=$( date -r "${trace}" +%s 2> /dev/null ) || continue;
      report="${taskState}/${id}-${name}.txt";
      tries=0; sig='';
      while (( tries < REPLAY_TRIES )); do
        tries=$(( tries + 1 ));
        Replay "${stepDir}" "${trace}" "${report}";
        [ -e "${trace}" ] || break;
        sig=$( ObjectiveSignature < "${report}" );
        [ "${sig%%$'\t'*}" == no-crash ] && ! OverBudget || break;
      done
      [ -e "${trace}" ] || { rm -f "${report}"; continue; };
      verdict=$( FuzzerVerdict "${records}" "${name}" ); [ -n "${verdict}" ] || verdict=$'\t\t\t';
      FuzzerExcerpt "${expDir}/log" "$( cut -f4 <<< "${verdict}" )" "$( cut -f1 <<< "${verdict}" )" | cut -c1-300 \
          > "${taskState}/${id}-${name}.fuzzer.txt" 2> /dev/null;
      printf '%s\t%s\t%s\t%s\t%s\n' "${name}" "${found}" "${sig}" "${verdict}" "${tries}/${REPLAY_TRIES}" >> "${tsv}";
    done < "${taskState}/${id}.all";
  done < <( find "${taskDir}" -maxdepth 6 -type d -path '*/experiments/*/objective' 2> /dev/null )

  # Ended attempts: their step directory is removed at once, often before this scan sees it (a VulnA attempt stops
  # at its first objective), but the experiment archives the objectives and its own replays of them in the task
  # artefacts: <library>/<attempt>-objective/ and <attempt>-objective-reports/ (.signatures.tsv, <trace>.txt).
  # An archive is complete and does not change: its attempt is rebuilt from it on each call, each report signed by the
  # current ObjectiveSignature (the .signatures.tsv of the experiment comes from the job script the task started with).
  for objDir in "${taskDir}"/artefacts/*/*-objective; do
    [ -d "${objDir}" ] || continue;
    library=$( basename "$( dirname "${objDir}" )" );
    id="${library}-$( basename "${objDir}" -objective )";
    tsv="${taskState}/${id}.tsv";
    echo "${library}" > "${taskState}/${id}.lib";
    find "${objDir}" -maxdepth 1 -type f -name '*.trace' ! -name '.*' -printf '%T@ %p\n' | sort -n > "${taskState}/${id}.allt";
    cut -d' ' -f2- "${taskState}/${id}.allt" > "${taskState}/${id}.all";
    records=$( FUZZER_RECORDS_CACHE="${taskState}/fzcache" FuzzerRecords "${objDir%-objective}-log" );
    printf '%s\n' "${records}" > "${taskState}/${id}.records";
    : > "${tsv}.tmp";
    while IFS= read -r trace; do
      name=$( basename "${trace}" .trace );
      reportTxt="${objDir}-reports/${name}.txt";
      # objectives without a recorded replay stay counted as found, not replayed (no step directory to replay from)
      [ -r "${reportTxt}" ] || continue;
      found=$( awk -F'\t' -v n="${name}" '$1 == n { print $2; exit }' "${objDir}-reports/.signatures.tsv" 2> /dev/null );
      found="${found:-$( date -r "${trace}" +%s 2> /dev/null || echo 0 )}";
      # (an archive being written while this scan reads it: taken at the next call)
      cp "${reportTxt}" "${taskState}/${id}-${name}.txt" 2> /dev/null || continue;
      verdict=$( FuzzerVerdict "${records}" "${name}" ); [ -n "${verdict}" ] || verdict=$'\t\t\t';
      FuzzerExcerpt "${objDir%-objective}-log" "$( cut -f4 <<< "${verdict}" )" "$( cut -f1 <<< "${verdict}" )" | cut -c1-300 \
          > "${taskState}/${id}-${name}.fuzzer.txt" 2> /dev/null;
      # tries of the experiment's replay, recorded by job scripts since they retry (last column of .signatures.tsv)
      tries=$( awk -F'\t' -v n="${name}" '$1 == n && $NF ~ /^[0-9]+\/[0-9]+$/ { print $NF; exit }' "${objDir}-reports/.signatures.tsv" 2> /dev/null );
      printf '%s\t%s\t%s\t%s\t%s\n' "${name}" "${found}" "$( ObjectiveSignature < "${reportTxt}" )" "${verdict}" "${tries}" >> "${tsv}.tmp";
    done < "${taskState}/${id}.all";
    mv "${tsv}.tmp" "${tsv}";
  done

  # page of the task: one run per step directory with objectives
  runs='[]';
  for tsv in "${taskState}"/*.tsv; do
    [ -e "${tsv}" ] || continue;
    # (not the copies made for the page below, <run>.page.tsv)
    [[ "${tsv}" == *.page.tsv ]] && continue;
    key=$( basename "${tsv}" .tsv );
    found=$( wc -l < "${taskState}/${key}.all" 2> /dev/null || echo 0 );
    (( found > 0 )) || continue;
    # <library>-<attempt>, see above
    library=$( cat "${taskState}/${key}.lib" 2> /dev/null );
    library="${library:-${key%-*}}";
    attempt="${key##*-}";
    # the objectives not replayed yet (a few per round): classified by the fuzzer's record for the page, as the final
    # report does; the state keeps only the replays, so they are still replayed later
    page="${taskState}/${key}.page.tsv";
    cp "${tsv}" "${page}";
    cut -f1 "${tsv}" | sort -u > "${taskState}/${key}.done";
    while IFS=$'\t' read -r name vk vd vf vr; do
      [ -n "${name}" ] || continue;
      t=$( awk -v n="/${name}.trace" 'index($0, n) { split($1, a, "."); print a[1]; exit }' "${taskState}/${key}.allt" 2> /dev/null );
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${name}" "${t:-0}" $'not-replayed\t\tnot replayed yet\t0' "${vk}" "${vd}" "${vf}" "${vr}" "" >> "${page}";
    done < <( sed 's#.*/##; s/\.trace$//' "${taskState}/${key}.all" 2> /dev/null | grep -vxF -f "${taskState}/${key}.done" |
              FuzzerVerdicts "$( cat "${taskState}/${key}.records" 2> /dev/null )" )
    groups=$( jq -R -s '
      split("\n") | map(select(length > 0) | split("\t")
        | { trace: .[0], found: (.[1] | tonumber? // 0), type: .[2], frames: .[3], summary: .[4], start: ((.[5] // "0") | tonumber? // 0),
            fkind: (.[6] // ""), fdetail: (.[7] // ""), fframes: (.[8] // ""), tries: (.[10] // "") })
      | def unconfirmed: .type == "no-crash" or .type == "replay-error" or .type == "not-replayed";
        # confirmed by the replay: by its signature; not confirmed: by what the fuzzer saw, the replay reasons inside
        # and always by the fuzzer record, so that the page can merge them into the bug the fuzzer saw
        group_by((if unconfirmed then .type + "|fuzzer" else .type + "|" + .frames end)
                 + "|" + .fkind + "|" + (if .fframes != "" then .fframes else .fdetail end))
      | map(sort_by(.found) | (.[0] | unconfirmed) as $u | {
            type: .[0].type, frames: (if $u then [] else (.[0].frames | if . == "" then [] else split(" < ") end) end),
            summary: .[0].summary, count: length, first_trace: .[0].trace, start: .[0].start,
            traces: ([.[].trace] | .[:50]),
            fuzzer: (if .[0].fkind == "" then null else { kind: .[0].fkind, detail: .[0].fdetail,
                       frames: (.[0].fframes | if . == "" then [] else split(" < ") end) } end),
            replay_reasons: (if $u then (group_by(.frames) | map({ reason: .[0].frames, count: length }) | sort_by(-.count))
                             else null end),
            tries: ([.[].tries | select(. != "")] | if length == 0 then null else (group_by(.) | map({ tries: .[0], count: length })) end) })
      | sort_by(-.count)' "${page}" ) || groups='[]';
    n=$( jq length <<< "${groups}" );
    for (( i = 0; i < n; i++ )); do
      first=$( jq -r ".[${i}].first_trace" <<< "${groups}" );
      from=$( jq -r ".[${i}].start" <<< "${groups}" );
      (( from > 0 )) || from=1;
      groups=$( jq --argjson i "${i}" --arg e "$( tail -n "+${from}" "${taskState}/${key}-${first}.txt" 2> /dev/null | head -n 40 | cut -c1-300 )" \
          --arg f "$( cat "${taskState}/${key}-${first}.fuzzer.txt" 2> /dev/null )" \
          '.[$i].excerpt = ("first: " + .[$i].first_trace + ".trace\n" + $e) | del(.[$i].start)
           | if .[$i].fuzzer then .[$i].fuzzer.excerpt = $f else . end' <<< "${groups}" );
    done
    # the traces of the groups, copied next to the page (live-<task>-traces/<library>/<run>/, as the final report)
    tracesDir="${OUT}/live-${task}-traces/${library}/${attempt}";
    mkdir -p "${tracesDir}";
    while IFS= read -r name; do
      [[ "${name}" =~ ^[A-Za-z0-9._-]+$ ]] || continue;
      [ -s "${tracesDir}/${name}.trace" ] && continue;
      path=$( grep -m1 "/${name}\.trace\$" "${taskState}/${key}.all" 2> /dev/null );
      [ -n "${path}" ] && cp "${path}" "${tracesDir}/${name}.trace.tmp" 2> /dev/null &&
          mv "${tracesDir}/${name}.trace.tmp" "${tracesDir}/${name}.trace" || rm -f "${tracesDir}/${name}.trace.tmp";
    done < <( jq -r '.[].traces[]?' <<< "${groups}" );
    kept=$( find "${tracesDir}" -maxdepth 1 -name '*.trace' -printf '%f\n' | sed 's/\.trace$//' | jq -R . | jq -s . );
    groups=$( jq --argjson kept "${kept}" '[.[] | .traces = [.traces[]? | select(IN($kept[]))]]' <<< "${groups}" );
    # build (harness and library version) and ASAN, as recorded for the experiment (ExperimentSetupForCargo)
    cli=$( cat "${taskDir}/output/cli-${library}.json" 2> /dev/null );
    jq -e . <<< "${cli}" > /dev/null 2>&1 || cli='{}';
    runs=$( jq --arg lib "${library}" --argjson a "${attempt:-0}" --argjson found "${found}" --argjson g "${groups}" \
        --argjson cli "${cli}" --arg traces "live-${task}-traces/${library}/${attempt}" \
        '. + [{ library: $lib, attempt: $a, found: $found, replayed: ([$g[] | select(.type != "not-replayed") | .count] | add // 0), traces_dir: $traces,
                reports: ([$g[] | select(.type != "no-crash" and .type != "replay-error" and .type != "not-replayed") | .count] | add // 0), groups: $g,
                cli: ($cli | {build, cputs, vendor, features, library, vulnerabilities}), asan: $cli.asan.instrumented }]' <<< "${runs}" );
  done
  [ "$( jq length <<< "${runs}" )" -gt 0 ] || continue;
  IFS=$'\t' read -r commit name <<< "$( TaskInfo "${taskJSON}" )";
  jq --arg task "${task}" --arg name "${name}" --arg commit "${commit}" --arg updated "$( date '+%F %T' )" \
      --arg taskUrl "${BOARD_URL}/files/board/task.html?id=${task}" \
      --arg jobType "$( jq -r '.task.job_type // ""' <<< "${taskJSON}" 2> /dev/null )" \
      --argjson nt "$( NotTargetedJSON )" \
      --argjson cves "$( jq -c -f "${TOOLS}/objectives_page/cve_signatures.jq" "${TOOLS}/../../data/html/jobsscripts/tlspuffin/vuln_targets.json" 2> /dev/null || echo '{}' )" \
      --argjson targets "$( jq -c --slurpfile t "${TOOLS}/../../data/html/jobsscripts/tlspuffin/vuln_targets.json" '[.task.steps | (if type == "object" then [.[]] else . end)[]
          | select(.name == "ExperimentWithCargo") | { (.id): (.args.vendor // "") }] | add // {} | with_entries(.value = $t[0][.value]) | with_entries(select(.value != null))' <<< "${taskJSON}" 2> /dev/null || echo '{}' )" \
      --argjson libraries "$( jq -c '[.task.steps | (if type == "object" then [.[]] else . end)[]
          | select(.name == "ExperimentWithCargo")] | group_by(.id) | map({ library: .[0].id, runs: length })' <<< "${taskJSON}" 2> /dev/null || echo '[]' )" \
      '{ task: $task, task_url: $taskUrl, commit: $commit, name: $name, job_type: $jobType, live: true, updated: $updated,
         not_targeted: (if $jobType | test("^vuln-") then $nt else {} end), targets: $targets, cves: $cves,
         # every configuration with its number of runs, also the runs without objective yet (the 🎯 count: k/runs)
         libraries: $libraries,
         runs: sort_by(.library, .attempt) }' \
      <<< "${runs}" > "${OUT}/live-${task}.json";
  bash "${TOOLS}/objectives_report.sh" --render "${OUT}/live-${task}.json" "${OUT}/live-${task}.html";
  # row of live.html and of the top bar pill (nav.js): counts of the task; configurations = its experiment steps
  nconf=$( jq '[.. | objects | select(.name? == "ExperimentWithCargo" or .name? == "Experiment") | .id] | unique | length' \
      <<< "${taskJSON}" 2> /dev/null ) || nconf=0;
  liveTasks=$( jq --slurpfile t "${OUT}/live-${task}.json" --arg url "live-${task}.html" --argjson nconf "${nconf:-0}" '
      ($t[0]) as $l
      | ([$l.runs[] | .library as $lib | .groups[] | select(.type != "no-crash" and .type != "replay-error")
          | if .type == "crash" and (.frames | length) == 0 then "crash|" + $lib else .type + "|" + (.frames | join("<")) end])
        as $confirmed
      | . + [{ task: $l.task, name: $l.name, commit: $l.commit, job_type: $l.job_type, task_url: $l.task_url, url: $url,
               found: ([$l.runs[].found] | add // 0), replayed: ([$l.runs[].replayed] | add // 0),
               reproduced: ([$l.runs[].reports] | add // 0),
               bugs: ($confirmed | unique | length),
               hit: ([$l.runs[] | select(any(.groups[]; .type != "no-crash" and .type != "replay-error")) | .library] | unique),
               configurations: ([$nconf, ([$l.runs[].library] | unique | length)] | max) }]' <<< "${liveTasks}" ) ||
      liveTasks='[]';
done

# index of the running tasks; state of finished tasks is dropped (their final page comes from objectives_report.sh)
declare -A active=()
for taskDir in "${RUNS}"/[0-9]*; do
  [ -d "${taskDir}" ] || continue;
  TaskActive "$( basename "${taskDir}" )";
  (( $? != 1 )) && active["$( basename "${taskDir}" )"]=1;
done
for taskState in "${STATE}"/[0-9]*; do
  [ -d "${taskState}" ] || continue;
  [ -n "${active[$( basename "${taskState}" )]:-}" ] || rm -rf "${taskState}";
done
for page in "${OUT}"/live-[0-9]*.html; do
  [ -e "${page}" ] || continue;
  id=$( basename "${page}" .html ); id="${id#live-}";
  [ -n "${active[${id}]:-}" ] && continue;
  # a task that ended: until its final report is written (objectives_report.sh --all, every 10 minutes, after the
  # tasks without report), its address shows the last live page with a note, instead of nothing
  if [ ! -e "${OUT}/${id}.html" ] && [ -s "${OUT}/live-${id}.json" ]; then
    jq '.live = false | .pending_final = true' "${OUT}/live-${id}.json" > "${OUT}/${id}.json.tmp" &&
        mv "${OUT}/${id}.json.tmp" "${OUT}/${id}.json" &&
        bash "${TOOLS}/objectives_report.sh" --render "${OUT}/${id}.json" "${OUT}/${id}.html";
  fi
  # the live page stays until the final report replaces the copy (the pages and Results fall back to it meanwhile)
  grep -q '"pending_final": *true' "${OUT}/${id}.json" 2> /dev/null || rm -f "${page}" "${OUT}/live-${id}.json";
  # and its final report at once when its export is there and no --all run holds the lock (that run handles the
  # tasks without report first anyway), in the background: a few minutes instead of up to the next cron run
  if [ -f "${PB_ROOT}/data/exports/${id}.zip" ] || [ -f "${PB_ROOT}/data/exports/Canceled/${id}.zip" ]; then
    ( flock -n 9 && bash "${TOOLS}/objectives_report.sh" "${id}" > /dev/null 2>&1 ) 9> "${OUT}/.report-all.lock" &
  fi
done
# the traces of the tasks that ended (their final report has its own), once that report is written
for dir in "${OUT}"/live-[0-9]*-traces; do
  [ -d "${dir}" ] || continue;
  id=$( basename "${dir}" -traces ); id="${id#live-}";
  [[ "${id}" =~ ^[0-9]+$ ]] && [ -z "${active[${id}]:-}" ] && ! grep -q '"pending_final": *true' "${OUT}/${id}.json" 2> /dev/null &&
      rm -rf "${OUT:?}/live-${id}-traces";
done
# index of the running tasks with objectives: live.json, shown by live.html (objectives_page/live.js, same look as the
# task pages) and by the pill of the top bar on every page (nav.js; not for VulnA/VulnB, where objectives are expected)
jq -n --argjson tasks "${liveTasks}" --arg updated "$( date '+%F %T' )" '{ updated: $updated, tasks: $tasks }' \
    > "${OUT}/live.json.tmp" && mv "${OUT}/live.json.tmp" "${OUT}/live.json";
# the files of every objectives page, kept in sync with the checkout at each call (otherwise only a page being
# rendered copies them, and a fix waits for the next report)
for asset in live.js report.js report.css bugs.js; do
  cmp -s "${TOOLS}/objectives_page/${asset}" "${OUT}/${asset}" ||
      { cp "${TOOLS}/objectives_page/${asset}" "${OUT}/${asset}.tmp" && mv "${OUT}/${asset}.tmp" "${OUT}/${asset}"; };
done
cat > "${OUT}/live.html.tmp" <<HTML
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live objectives</title><link rel="stylesheet" href="report.css"></head>
<body><div id="report"><p style="padding:20px">Loading the live objectives…</p></div>
<script type="module" src="live.js"></script></body></html>
HTML
mv "${OUT}/live.html.tmp" "${OUT}/live.html"

# the button this script used to put on the scheduler board (its optional board/custom/header.html) is replaced by
# the pill of the top bar: the header is emptied, if it was written by this script.
HEADER="${PB_ROOT}/data/html/board/custom/header.html"
MARK='<!-- written by objectives_live.sh -->'
if [ -s "${HEADER}" ] && grep -qF "${MARK}" "${HEADER}" && [ "$( cat "${HEADER}" )" != "${MARK}" ]; then
  echo "${MARK}" > "${HEADER}.tmp" && mv "${HEADER}.tmp" "${HEADER}";
fi
