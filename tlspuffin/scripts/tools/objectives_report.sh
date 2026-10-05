#!/bin/bash
#
# Objectives of a finished task, from its export: the replays printed by the ExperimentEnd steps are grouped by
# bug (same signature as ExperimentReplayObjectives: AddressSanitizer error type and top stack frames) and written
# as a self-contained HTML page served by the publisher (/html/objectives/<task>.html).
# For tasks run before the objective reports existed: their replays went to the step stdout (trace names) and
# stderr (reports), so reports cannot be matched to their trace; the groups count reports.
#
# The scheduler's history page gets a 🐞 button on the card of every task with a page (board/custom/task_links.json).
#
# Usage: bash objectives_report.sh <task id> [<task id> ...]
#        bash objectives_report.sh --all     tasks with objectives whose page is missing or outdated (cron job)
# Each page gives, per library, what was built (harness and library version, see BuildDescription in PR_common.sh)
# and whether ASAN was active.
#   PB_ROOT        install root (default /srv/puffin-bench)
#   PB_PUBLIC_URL  base URL of the publisher (default http://<host>:10083)

set -u
PB_ROOT="${PB_ROOT:-/srv/puffin-bench}"
URL="${PB_PUBLIC_URL:-http://$( hostname -f 2> /dev/null || hostname ):10083}"
OUT="${PB_ROOT}/data/html/objectives"
SCRIPTS="$( cd "$( dirname "$( realpath "${BASH_SOURCE[0]}" )" )/.." && pwd )"
source <( sed -n '/^ObjectiveSignature()/,/^}/p' "${SCRIPTS}/PR_common.sh" )
declare -F ObjectiveSignature > /dev/null || { echo "ObjectiveSignature not found in ${SCRIPTS}/PR_common.sh" >&2; exit 1; }
mkdir -p "${OUT}" || exit 1

# export of a finished task: <id>.json and <id>.zip in exports/ or exports/Canceled/ (while the scheduler archives
# a task, a copy of its json also sits in exports/<id>/ and its zip is not written yet)
TaskFile() {
  local d;
  for d in "${PB_ROOT}/data/exports" "${PB_ROOT}/data/exports/Canceled"; do
    [ -f "${d}/$1.json" ] && [ -f "${d}/$1.zip" ] && { echo "${d}/$1.json"; return; }
  done
}

Report() {
  local task="$1";
  local J;
  J=$( TaskFile "${task}" );
  [ -n "${J}" ] || { echo "${task}: export not found" >&2; return 1; }
  local Z="${J%.json}.zip";
  local tmp; tmp=$( mktemp -d );
  local commit; commit=$( jq -r '[(.task.args, .task.argsToUpdate) | (if type == "array" then .[] else empty end) | select(.key == "COMMIT_ID") | .value] | last // "?"' "${J}" );
  local libs='[]';
  local lib attempt step;
  while IFS=$'\t' read -r lib attempt step; do
    unzip -p "${Z}" "logs/stdout.${step}.txt" > "${tmp}/out" 2> /dev/null;
    unzip -p "${Z}" "logs/stderr.${step}.txt" > "${tmp}/err" 2> /dev/null;
    local found replayed;
    found=$( unzip -Z1 "${Z}" 2> /dev/null | grep -cE "^artefacts/${lib}/${attempt}-objective/[^.][^/]*\.trace$" );
    replayed=$( grep -cE '^=== .*\.trace ===$' "${tmp}/out" );
    (( found > 0 || replayed > 0 )) || continue;
    # one block per report: AddressSanitizer errors, security violations, Rust panics and replay errors (the fuzzer
    # could not run, or the replay timed out), in stdout and stderr
    rm -f "${tmp}"/block.*;
    cat "${tmp}/out" "${tmp}/err" | awk -v dir="${tmp}" '
      /==[0-9]+==ERROR: AddressSanitizer: / || /security violation occurred\. msg: / || /SecurityClaim\("/ || /panicked at / ||
        /error while loading shared libraries|binary not found:|^error: could not compile|^exit status: (124|137)$/ { n++ }
      n > 0 { print > (dir "/block." n) }'
    : > "${tmp}/sig.tsv";
    local b;
    for b in "${tmp}"/block.*; do
      [ -e "${b}" ] || continue;
      printf '%s\t%s\n' "${b##*.}" "$( ObjectiveSignature < "${b}" )" >> "${tmp}/sig.tsv";
    done
    local groups;
    groups=$( jq -R -s '
      split("\n") | map(select(length > 0) | split("\t") | { block: .[0], type: .[1], frames: .[2], summary: .[3] })
      | group_by(.type + "|" + .frames)
      | map({ type: .[0].type, frames: (.[0].frames | if . == "" then [] else split(" < ") end), summary: .[0].summary,
              count: length, block: .[0].block })
      | sort_by(-.count)' "${tmp}/sig.tsv" );
    local i;
    for (( i = 0; i < $( jq length <<< "${groups}" ); i++ )); do
      local blk; blk=$( jq -r ".[${i}].block" <<< "${groups}" );
      groups=$( jq --argjson i "${i}" --arg e "$( head -n 40 "${tmp}/block.${blk}" | cut -c1-300 )" '.[$i].excerpt = $e | del(.[$i].block)' <<< "${groups}" );
    done
    # build and ASAN of the library, from the record of the experiment step (first line of its user run state)
    local cli;
    cli=$( jq -c --arg lib "${lib}" 'first(.task.steps[] | select(.id == $lib) | .user_run_state // "" | split("\n")[]
        | (try fromjson catch null) | select(type == "object" and has("cputs"))) // {}' "${J}" 2> /dev/null ) || cli='{}';
    [ -n "${cli}" ] || cli='{}';
    libs=$( jq --arg lib "${lib}" --argjson a "${attempt}" --argjson found "${found}" --argjson replayed "${replayed}" \
        --argjson groups "${groups}" --argjson cli "${cli}" '. + [{ library: $lib, attempt: $a, found: $found, replayed: $replayed,
          reports: ([$groups[].count] | add // 0), groups: $groups,
          cli: ($cli | {build, cputs, vendor, features, library}), asan: $cli.asan.instrumented }]' <<< "${libs}" );
  done < <( jq -r '.task.steps[] | select(.name == "ExperimentEnd")
      | [.id, .attempt_id, (.executor_data.launcher_file // "" | sub(".*/"; "") | sub("-launcher$"; ""))] | @tsv' "${J}" | sort -k1,1 -k2,2n )
  rm -rf "${tmp}";

  jq --arg task "${task}" --arg commit "${commit}" --arg name "$( jq -r '.task.name // ""' "${J}" )" '{ task: $task, commit: $commit, name: $name, runs: . }' \
      <<< "${libs}" > "${OUT}/${task}.json" || return 1;
  Render "${OUT}/${task}.json" "${OUT}/${task}.html" || return 1;
  echo "${task}: $( jq -r '[.runs[] | "\(.library) run \(.attempt): \(.reports) report(s) in \(.groups | length) group(s)"] | join("; ") | if . == "" then "no objective" else . end' "${OUT}/${task}.json" )";
  echo "  ${URL}/html/objectives/${task}.html";
}

# Render <json> <html>: page of the objectives of a task ({task, commit, name, live?, updated?, runs: [...]}).
# Each run may carry cli ({build, cputs, vendor, features, library} of cli-<library>.json) and asan.
Render() {
  jq -r '
    def esc: tostring | @html;
    # what was built (BuildDescription in PR_common.sh), derived for records without "build"
    def build_of: if . == null then null elif .build then .build
      else ((.vendor // "") | split(":") | last) as $preset
      | if .cputs == true then "C harness, \($preset)"
        elif .cputs == false then "Rust harness, "
          + (if (.library.name // "NA") != "NA" then "\(.library.name)\(.library.version // "")" else "features \(.features // "")" end)
          + (if $preset != "" then " (vendor \($preset) not available at this commit)" else "" end)
        else null end end;
    "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">"
    + "<title>Objectives \(.task)</title><style>"
    + "body{font-family:sans-serif;margin:16px;color:#222}h2{margin:18px 0 4px}.run{margin:6px 0 2px;color:#555}"
    + ".type{font-family:monospace;color:#900}.frames{font-family:monospace}summary{cursor:pointer}"
    + "pre{max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-all;background:#f5f5f5;padding:6px}"
    + ".none{color:#777}</style></head><body>"
    + "<h1>Objectives of task \(.task | esc)</h1><div>\(.name | esc) — commit <code>\(.commit | esc)</code>"
    + (if .task_url then " — <a href=\"\(.task_url | esc)\" target=\"_blank\">task on the scheduler board</a>" else "" end) + "</div>"
    + "<p class=\"none\">Groups: AddressSanitizer errors (memory corruptions), security-violation (the security oracle flagged a claim violation, e.g. Authentication bypass: no crash), panic, replay-error (the replay could not run or timed out), no-crash (not reproduced by the replay).</p>"
    + (if .live then "<p class=\"none\">Task running: objectives replayed every few minutes on core 0, outside the fuzzing cores. Last update: \(.updated | esc). Reload for newer results.</p>" else "" end)
    + (if (.runs | length) == 0 then "<p class=\"none\">No objective found.</p>" else "" end)
    + ([.runs | group_by(.library)[] |
        "<h2>\(.[0].library | esc)</h2>"
        + (((.[0].cli | build_of) // .[0].put) as $build
          | if $build then "<div class=\"run\">\($build | esc) — ASAN "
             + (if .[0].asan == true then "✓" elif .[0].asan == false then "✗ (not instrumented)" else "?" end) + "</div>"
           else "" end)
        + ([.[] |
            "<div class=\"run\">run \(.attempt): \(.found) objective(s), \(.replayed) replayed, \(.reports) report(s)"
            + (if .replayed > .reports then ", \(.replayed - .reports) replay(s) without crash or violation" else "" end) + "</div>"
            + ([.groups[] |
                "<details><summary><b>\(.count) ×</b> <span class=\"type\">\(.type | esc)</span> "
                + "<span class=\"frames\">\((.frames | join(" < ")) | esc)</span></summary><pre>\(.excerpt | esc)</pre></details>"
               ] | join(""))
           ] | join(""))
       ] | join(""))
    + "</body></html>"' "$1" > "$2.tmp" && mv "$2.tmp" "$2";
}

# --all: every exported task with objective traces whose page is missing or older than its export or than this
# script (for a cron job: an update of the page format rewrites every page once)
AllTasks() {
  local J id;
  find -L "${PB_ROOT}/data/exports" "${PB_ROOT}/data/exports/Canceled" -maxdepth 1 -name '*.json' 2> /dev/null |
  grep -E '/[0-9]+\.json$' |
  while read -r J; do
    id=$( basename "${J}" .json );
    [ -f "${J%.json}.zip" ] || continue;
    [ "${OUT}/${id}.html" -nt "${J}" ] && [ "${OUT}/${id}.html" -nt "${BASH_SOURCE[0]}" ] && continue;
    unzip -Z1 "${J%.json}.zip" 2> /dev/null | grep -qE '^artefacts/[^/]+/[0-9]+-objective/[^.][^/]*\.trace$' || continue;
    echo "${id}";
  done
}

# 🐞 button on the cards of the scheduler's history page (its optional board/custom/task_links.json): one per
# task whose page lists objectives and whose export still exists. Rewritten on every call; a file whose entries
# were not written by this script is left alone.
TaskLinks() {
  local links="${PB_ROOT}/data/html/board/custom/task_links.json";
  [ -d "$( dirname "${links}" )" ] || return 0;
  if [ -s "${links}" ] && ! jq -e 'all(.[][]; .source == "objectives_report")' "${links}" > /dev/null 2>&1; then
    echo "${links}: not written by this script, left alone" >&2;
    return 0;
  fi
  local f id;
  for f in "${OUT}"/[0-9]*.json; do
    [ -e "${f}" ] || continue;
    id=$( basename "${f}" .json );
    [[ "${id}" =~ ^[0-9]+$ ]] && [ -f "${OUT}/${id}.html" ] && [ -n "$( TaskFile "${id}" )" ] || continue;
    jq -c --arg id "${id}" 'select((.runs | length) > 0)
        | { ($id): [{ label: "🐞", url: "../objectives/\($id).html", source: "objectives_report",
                     title: "Objectives of this task, grouped by bug: \([.runs[].reports] | add // 0) report(s), \([.runs[].groups | length] | add // 0) group(s) (new tab)" }] }' "${f}";
  done | jq -s 'add // {}' > "${links}.tmp" && mv "${links}.tmp" "${links}";
}

[ "${1:-}" == "--render" ] && { Render "$2" "$3"; exit $?; }
(( $# > 0 )) || { echo "Usage: $0 <task id> ... | --all" >&2; exit 1; }
tasks=( "$@" );
[ "$1" == "--all" ] && tasks=( $( AllTasks ) );
status=0;
for t in "${tasks[@]}"; do Report "${t}" || status=1; done
TaskLinks || status=1;
exit ${status}
