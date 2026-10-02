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
OUT="${PB_ROOT}/data/html/objectives"
STATE="${PB_ROOT}/data/objectives-live"
RUNS="${PB_ROOT}/data/runs"
API="http://127.0.0.1:10082"
TOOLS="$( dirname "$( realpath "${BASH_SOURCE[0]}" )" )"
source <( sed -n '/^ObjectiveSignature()/,/^}/p' "${TOOLS}/../PR_common.sh" )
declare -F ObjectiveSignature > /dev/null || { echo "ObjectiveSignature not found" >&2; exit 1; }
mkdir -p "${OUT}" "${STATE}" || exit 1

# one call at a time
exec 9> "${STATE}/.lock"
flock -n 9 || exit 0

start=$( date +%s )
OverBudget() { (( $( date +%s ) - start >= BUDGET )); }

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

# Replay <step dir> <trace> <report>: the experiment's binary (never cargo), in a working directory of its own,
# inside the commit's nix-shell when possible
Replay() {
  local dir="$1" trace="$2" report="$3";
  local bin;
  bin=$( sed -n 's/.*--bin "\{0,1\}\([A-Za-z0-9_-]*\)"\{0,1\}.*/\1/p' "${dir}/.currentcmd" 2> /dev/null | head -1 );
  bin="${dir}/target/release/${bin:-tlspuffin}";
  [ -x "${bin}" ] || { echo "binary not found: ${bin}" > "${report}"; return 1; }
  local work="${report%.txt}.work";
  mkdir -p "${work}";
  local noAslr='';
  setarch "$( uname -m )" -R true > /dev/null 2>&1 && noAslr="setarch $( uname -m ) -R";
  local asan; asan=$( AsanOptions "${dir}" );
  local status=1;
  if [ -r "${dir}/shell.nix" ] && command -v nix-shell > /dev/null; then
    ( cd "${work}" &&
      timeout -k 5 "$(( REPLAY_TIMEOUT * 2 ))" ${noAslr} nix-shell "${dir}/shell.nix" \
        --run "export ASAN_OPTIONS='${asan}'; command -v llvm-symbolizer > /dev/null && export ASAN_SYMBOLIZER_PATH=\$( command -v llvm-symbolizer ); exec '${bin}' execute '${trace}'" ) \
        < /dev/null > "${report}" 2>&1;
    status=$?;
  fi
  # no nix-shell, or it could not start the binary: direct run
  if [ ! -s "${report}" ] || grep -qE '^error: |error while loading shared libraries' "${report}"; then
    local symbolizer; symbolizer=$( Symbolizer );
    ( cd "${work}" &&
      ASAN_OPTIONS="${asan}" ${symbolizer:+ASAN_SYMBOLIZER_PATH="${symbolizer}"} \
        timeout -k 5 "${REPLAY_TIMEOUT}" ${noAslr} "${bin}" execute "${trace}" ) < /dev/null > "${report}" 2>&1;
    status=$?;
  fi
  echo "exit status: ${status}" >> "${report}";
  rm -rf "${work}";
}

# Is the task running or waiting? (run directories of tasks lost by a scheduler restart stay behind)
# The state of a live task is {"task": {...}}; "success" only appears, false, when the task does not exist.
TaskActive() {
  curl -s --max-time 5 "${API}/api/task/$1/state" |
      jq -e '((.success // true) != false) and ([.. | objects | .state? | strings] | any(. == "Running" or . == "Pending"))' > /dev/null 2>&1
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

declare -A seen=()
index=''
for taskDir in "${RUNS}"/[0-9]*; do
  [ -d "${taskDir}" ] || continue;
  task=$( basename "${taskDir}" );
  TaskActive "${task}" || continue;
  taskJSON=$( curl -s --max-time 5 "${API}/api/task/${task}/state" );
  taskState="${STATE}/${task}";
  mkdir -p "${taskState}";
  # experiments of the task: <step dir>/experiments/<name>/objective
  while IFS= read -r objDir; do
    expDir=$( dirname "${objDir}" );
    stepDir=$( dirname "$( dirname "${expDir}" )" );
    key=$( basename "${stepDir}" );
    seen["${task}/${key}"]=1;
    tsv="${taskState}/${key}.tsv";
    touch "${tsv}";
    echo "$( basename "${expDir}" )" > "${taskState}/${key}.name";
    find "${objDir}" -maxdepth 1 -type f -name '*.trace' ! -name '.*' -printf '%T@ %p\n' | sort -n | cut -d' ' -f2- > "${taskState}/${key}.all";
    while IFS= read -r trace; do
      name=$( basename "${trace}" .trace );
      grep -q "^${name}	" "${tsv}" && continue;
      OverBudget && break;
      report="${taskState}/${key}-${name}.txt";
      Replay "${stepDir}" "${trace}" "${report}";
      printf '%s\t%s\t%s\n' "${name}" "$( date -r "${trace}" +%s )" "$( ObjectiveSignature < "${report}" )" >> "${tsv}";
    done < "${taskState}/${key}.all";
  done < <( find "${taskDir}" -maxdepth 6 -type d -path '*/experiments/*/objective' 2> /dev/null )

  # page of the task: one run per step directory with objectives
  runs='[]';
  for tsv in "${taskState}"/*.tsv; do
    [ -e "${tsv}" ] || continue;
    key=$( basename "${tsv}" .tsv );
    found=$( wc -l < "${taskState}/${key}.all" 2> /dev/null || echo 0 );
    (( found > 0 )) || continue;
    expName=$( cat "${taskState}/${key}.name" 2> /dev/null );
    # experiment names are <date>-<library>-<n>; the step directory ends with the attempt
    library=$( StepLibrary "${taskJSON}" "${key}" "${expName}" );
    attempt="${key##*-}";
    groups=$( jq -R -s '
      split("\n") | map(select(length > 0) | split("\t")
        | { trace: .[0], found: (.[1] | tonumber), type: .[2], frames: .[3], summary: .[4], start: ((.[5] // "0") | tonumber) })
      | group_by(.type + "|" + .frames)
      | map(sort_by(.found) | { type: .[0].type, frames: (.[0].frames | if . == "" then [] else split(" < ") end),
            summary: .[0].summary, count: length, first_trace: .[0].trace, start: .[0].start })
      | sort_by(-.count)' "${tsv}" ) || groups='[]';
    n=$( jq length <<< "${groups}" );
    for (( i = 0; i < n; i++ )); do
      first=$( jq -r ".[${i}].first_trace" <<< "${groups}" );
      from=$( jq -r ".[${i}].start" <<< "${groups}" );
      (( from > 0 )) || from=1;
      groups=$( jq --argjson i "${i}" --arg e "$( tail -n "+${from}" "${taskState}/${key}-${first}.txt" 2> /dev/null | head -n 40 | cut -c1-300 )" \
          '.[$i].excerpt = ("first: " + .[$i].first_trace + ".trace\n" + $e) | del(.[$i].start)' <<< "${groups}" );
    done
    # library under test, harness and ASAN, as recorded for the experiment (ExperimentSetupForCargo)
    cli=$( cat "${taskDir}/output/cli-${library}.json" 2> /dev/null );
    jq -e . <<< "${cli}" > /dev/null 2>&1 || cli='{}';
    runs=$( jq --arg lib "${library}" --argjson a "${attempt:-0}" --argjson found "${found}" --argjson g "${groups}" \
        --argjson cli "${cli}" \
        '. + [{ library: $lib, attempt: $a, found: $found, replayed: ([$g[].count] | add // 0),
                reports: ([$g[] | select(.type != "no-crash") | .count] | add // 0), groups: $g,
                put: ($cli | if .library then "\(.library.name) \(.library.version), "
                        + (if .cputs then "C harness (vendor \(.vendor))" else "Rust harness (features \(.features))" end)
                      else null end),
                asan: $cli.asan.instrumented }]' <<< "${runs}" );
  done
  [ "$( jq length <<< "${runs}" )" -gt 0 ] || continue;
  IFS=$'\t' read -r commit name <<< "$( TaskInfo "${taskJSON}" )";
  jq --arg task "${task}" --arg name "${name}" --arg commit "${commit}" --arg updated "$( date '+%F %T' )" \
      --arg taskUrl "${BOARD_URL}/files/board/task.html?id=${task}" \
      '{ task: $task, task_url: $taskUrl, commit: $commit, name: $name, live: true, updated: $updated,
         runs: sort_by(.library, .attempt) }' \
      <<< "${runs}" > "${OUT}/live-${task}.json";
  bash "${TOOLS}/objectives_report.sh" --render "${OUT}/live-${task}.json" "${OUT}/live-${task}.html";
  index+="<li><a href=\"live-${task}.html\">${task}</a> $( jq -r '.name | @html' "${OUT}/live-${task}.json" ): $( jq -r '[.runs[] | .found] | add' "${OUT}/live-${task}.json" ) objective(s)</li>";
done

# index of the running tasks; state of finished tasks is dropped (their final page comes from objectives_report.sh)
declare -A active=()
for taskDir in "${RUNS}"/[0-9]*; do [ -d "${taskDir}" ] && TaskActive "$( basename "${taskDir}" )" && active["$( basename "${taskDir}" )"]=1; done
for taskState in "${STATE}"/[0-9]*; do
  [ -d "${taskState}" ] || continue;
  [ -n "${active[$( basename "${taskState}" )]:-}" ] || rm -rf "${taskState}";
done
for page in "${OUT}"/live-[0-9]*.html; do
  [ -e "${page}" ] || continue;
  id=$( basename "${page}" .html ); id="${id#live-}";
  [ -n "${active[${id}]:-}" ] || rm -f "${page}" "${OUT}/live-${id}.json";
done
cat > "${OUT}/live.html.tmp" <<HTML
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Live objectives</title><style>body{font-family:sans-serif;margin:16px}</style></head><body>
<h1>Objectives of the running tasks</h1>
<p>Updated $( date '+%F %T' ). Replays run on core 0 at idle priority, outside the fuzzing cores. Finished tasks: page objectives/&lt;task&gt;.html.</p>
<ul>${index:-<li>No running task with objectives.</li>}</ul></body></html>
HTML
mv "${OUT}/live.html.tmp" "${OUT}/live.html"

# button on the scheduler board (its optional board/custom/header.html, loaded with the board page) when running
# tasks have objectives; empty otherwise. A header not written by this script is left alone.
HEADER="${PB_ROOT}/data/html/board/custom/header.html"
MARK='<!-- written by objectives_live.sh -->'
if [ -d "$( dirname "${HEADER}" )" ] && { [ ! -s "${HEADER}" ] || grep -qF "${MARK}" "${HEADER}"; }; then
  nbLive=$( ls "${OUT}"/live-[0-9]*.html 2> /dev/null | wc -l );
  {
    echo "${MARK}";
    if (( nbLive > 0 )); then
      echo "<a href=\"../objectives/live.html\" target=\"_blank\" style=\"display:inline-block;margin:4px 8px;padding:4px 10px;border-radius:6px;background:#5a3e1b;color:#fff;text-decoration:none\" title=\"Objectives of the running tasks, replayed and grouped by bug\">🐞 Live objectives (${nbLive} task(s))</a>";
    fi
  } > "${HEADER}.tmp" && mv "${HEADER}.tmp" "${HEADER}";
fi
