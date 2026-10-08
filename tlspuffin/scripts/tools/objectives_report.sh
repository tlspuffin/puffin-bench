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
#   PB_BOARD_URL   base URL of the scheduler board (default http://<host>:10082)

set -u
PB_ROOT="${PB_ROOT:-/srv/puffin-bench}"
URL="${PB_PUBLIC_URL:-http://$( hostname -f 2> /dev/null || hostname ):10083}"
BOARD_URL="${PB_BOARD_URL:-http://$( hostname -f 2> /dev/null || hostname ):10082}"
OUT="${PB_ROOT}/data/html/objectives"
# traces of each group of objectives kept next to its page, for download (<task>-traces/<library>/<run>/)
TRACES_PER_GROUP=50
SCRIPTS="$( cd "$( dirname "$( realpath "${BASH_SOURCE[0]}" )" )/.." && pwd )"
source <( sed -n '/^ObjectiveSignature()/,/^}/p;/^FuzzerRecords()/,/^}/p;/^FuzzerRecordsOf()/,/^}/p;/^FuzzerVerdict()/,/^}/p;/^FuzzerVerdicts()/,/^}/p;/^FuzzerExcerpt()/,/^}/p;/^NotTargetedJSON()/,/^}/p' "${SCRIPTS}/PR_common.sh" )
# the expected bugs of the Vuln jobs and the CVEs set apart (the one file to edit)
TARGETS_JSON="${SCRIPTS}/../data/html/jobsscripts/tlspuffin/vuln_targets.json"
# the claims set apart (vuln_targets.json _not_targeted): claim -> "CVE|library|below" (see NotTargetedCVE)
declare -gA OBJECTIVES_NOT_TARGETED=()
source <( jq -r '"OBJECTIVES_NOT_TARGETED=(", (._not_targeted // {} | to_entries[] | "  [\(.key | @sh)]=\("\(.value.cve)|\(.value.library // "")|\(.value.below // "")" | @sh)"), ")"' "${TARGETS_JSON}" 2> /dev/null )
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
  [[ "${task}" =~ ^[0-9]+$ ]] || { echo "${task}: not a task id" >&2; return 1; }
  # the traces of the page are extracted again (rm of the task's own folder only)
  rm -rf "${OUT:?}/${task}-traces";
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
    rm -f "${tmp}"/block.*;
    : > "${tmp}/sig.tsv";
    local b k=0;
    # the report of every replayed objective, kept by ExperimentEnd (job scripts since 2026-10-02): one signature
    # each, so a replay that only crashed (no sanitizer report nor claim message) is told apart from no-crash
    local reports; reports=$( unzip -Z1 "${Z}" 2> /dev/null | grep -E "^artefacts/${lib}/${attempt}-objective-reports/[^.][^/]*\.txt$" );
    # the fuzzer's own record of each objective (its logs, <attempt>-log): what it saw when it saved it; how many log
    # files and records there were, for the objectives left without category (the page says why)
    rm -rf "${tmp}/log"; mkdir -p "${tmp}/log";
    unzip -q -o -j "${Z}" "artefacts/${lib}/${attempt}-log/*" -d "${tmp}/log" > /dev/null 2>&1;
    local records; records=$( FuzzerRecords "${tmp}/log" );
    local logFiles; logFiles=$( find "${tmp}/log" -maxdepth 1 -type f | wc -l );
    local recordCount; recordCount=$( grep -c . <<< "${records}" );
    if [ -n "${reports}" ]; then
      while IFS= read -r b; do
        unzip -p "${Z}" "${b}" > "${tmp}/block.${k}" 2> /dev/null;
        local sig verdict; sig=$( ObjectiveSignature < "${tmp}/block.${k}" );
        verdict=$( FuzzerVerdict "${records}" "$( basename "${b}" .txt )" );
        [ -n "${verdict}" ] || verdict=$'\t\t\t';
        # last column: the objective (its report is named after its trace)
        printf '%s\t%s\t%s\t%s\n' "${k}" "${sig}" "${verdict}" "$( basename "${b}" .txt )" >> "${tmp}/sig.tsv";
        k=$(( k + 1 ));
      done <<< "${reports}";
      replayed="${k}";
      # the objectives beyond the replays (the experiment replays at most 100, 10 before 2026-10-07): classified by
      # the fuzzer's record only, so that they count in their bug (e.g. the objective a VulnA run ended on, after 32
      # of CVE-2024-5814)
      # in one pass (FuzzerVerdicts): a run can have tens of thousands of objectives
      local name vk vd vf vr;
      cut -f10 "${tmp}/sig.tsv" | sort -u > "${tmp}/replayed.names";
      : > "${tmp}/block.empty";
      while IFS=$'\t' read -r name vk vd vf vr; do
        [ -n "${name}" ] || continue;
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${k}" $'not-replayed\t\tnot replayed (beyond the replays of the experiment)\t0' "${vk}" "${vd}" "${vf}" "${vr}" "${name}" >> "${tmp}/sig.tsv";
        ln -sf "${tmp}/block.empty" "${tmp}/block.${k}";
        k=$(( k + 1 ));
      done < <( unzip -Z1 "${Z}" 2> /dev/null | sed -n "s#^artefacts/${lib}/${attempt}-objective/\([^.][^/]*\)\.trace\$#\1#p" |
                grep -vxF -f "${tmp}/replayed.names" | FuzzerVerdicts "${records}" )
    else
      # one block per report: AddressSanitizer errors, security violations, Rust panics and replay errors (the fuzzer
      # could not run, or the replay timed out), in stdout and stderr
      cat "${tmp}/out" "${tmp}/err" | awk -v dir="${tmp}" '
        /==[0-9]+==ERROR: AddressSanitizer: / || /security violation occurred\. msg: / || /SecurityClaim\("/ || /panicked at / ||
          /error while loading shared libraries|binary not found:|^error: could not compile|^binary changed since the experiment|^exit status: (124|137)$/ { n++ }
        n > 0 { print > (dir "/block." n) }'
      local last=0;
      for b in "${tmp}"/block.*; do
        [ -e "${b}" ] || continue;
        printf '%s\t%s\n' "${b##*.}" "$( ObjectiveSignature < "${b}" )" >> "${tmp}/sig.tsv";
        (( ${b##*.} > last )) && last=${b##*.};
      done
      # the objectives that were not replayed (the replayed ones are named in the step output): classified by the
      # fuzzer's record only, as above
      local name vk vd vf vr;
      k=$(( last + 1 ));
      sed -n 's/^=== \(.*\)\.trace ===$/\1/p' "${tmp}/out" | sed 's#.*/##' | sort -u > "${tmp}/replayed.names";
      : > "${tmp}/block.empty";
      while IFS=$'\t' read -r name vk vd vf vr; do
        [ -n "${name}" ] || continue;
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${k}" $'not-replayed\t\tnot replayed (beyond the replays of the experiment)\t0' "${vk}" "${vd}" "${vf}" "${vr}" "${name}" >> "${tmp}/sig.tsv";
        ln -sf "${tmp}/block.empty" "${tmp}/block.${k}";
        k=$(( k + 1 ));
      done < <( unzip -Z1 "${Z}" 2> /dev/null | sed -n "s#^artefacts/${lib}/${attempt}-objective/\([^.][^/]*\)\.trace\$#\1#p" |
                grep -vxF -f "${tmp}/replayed.names" | FuzzerVerdicts "${records}" )
    fi
    local groups;
    local max="${TRACES_PER_GROUP}";
    groups=$( jq -R -s --argjson max "${max}" '
      split("\n") | map(select(length > 0) | split("\t") | { block: .[0], type: .[1], frames: .[2], summary: .[3],
          fkind: (.[5] // ""), fdetail: (.[6] // ""), fframes: (.[7] // ""), fts: (.[8] // ""), trace: (.[9] // "") })
      | def unconfirmed: .type == "no-crash" or .type == "replay-error" or .type == "not-replayed";
        # confirmed by the replay: by its signature; not confirmed: by what the fuzzer saw, the replay reasons inside
        # and always by the fuzzer record, so that the page can merge them into the bug the fuzzer saw
        group_by((if unconfirmed then .type + "|fuzzer" else .type + "|" + .frames end)
                 + "|" + .fkind + "|" + (if .fframes != "" then .fframes else .fdetail end))
      | map((.[0] | unconfirmed) as $u | {
              type: .[0].type, frames: (if $u then [] else (.[0].frames | if . == "" then [] else split(" < ") end) end),
              summary: .[0].summary, count: length, block: .[0].block,
              # its objectives (traces), the first ones kept next to the page (see TRACES_PER_GROUP), and its first
              # objective (names start with their UTC time), for the time to the bug (report_verdicts.js)
              traces: ([.[].trace | select(. != "")] | .[:$max]), first: ([.[].trace | select(. != "")] | min),
              fuzzer: (if .[0].fkind == "" then null else { kind: .[0].fkind, detail: .[0].fdetail,
                         frames: (.[0].fframes | if . == "" then [] else split(" < ") end), ts: .[0].fts } end),
              replay_reasons: (if $u then (group_by(.frames) | map({ reason: .[0].frames, count: length }) | sort_by(-.count))
                               else null end) })
      | sort_by(-.count)' "${tmp}/sig.tsv" );
    local i;
    for (( i = 0; i < $( jq length <<< "${groups}" ); i++ )); do
      local blk; blk=$( jq -r ".[${i}].block" <<< "${groups}" );
      # the fuzzer's own log of the record (crash with its backtrace, or claim), when the attempt's logs are there
      local fts fkind fexcerpt=''; fts=$( jq -r ".[${i}].fuzzer.ts // empty" <<< "${groups}" ); fkind=$( jq -r ".[${i}].fuzzer.kind // empty" <<< "${groups}" );
      [ -n "${fts}" ] && [ -d "${tmp}/log" ] && fexcerpt=$( FuzzerExcerpt "${tmp}/log" "${fts}" "${fkind}" | cut -c1-300 );
      groups=$( jq --argjson i "${i}" --arg e "$( head -n 40 "${tmp}/block.${blk}" | cut -c1-300 )" --arg f "${fexcerpt}" \
          '.[$i].excerpt = $e | del(.[$i].block) | if .[$i].fuzzer then .[$i].fuzzer.excerpt = $f | del(.[$i].fuzzer.ts) else . end' <<< "${groups}" );
    done
    # the traces of the groups, next to the page: <task>-traces/<library>/<run>/<objective>.trace
    local tracesDir="${OUT}/${task}-traces/${lib}/${attempt}" name;
    mkdir -p "${tracesDir}";
    while IFS= read -r name; do
      [[ "${name}" =~ ^[A-Za-z0-9._-]+$ ]] || continue;
      unzip -p "${Z}" "artefacts/${lib}/${attempt}-objective/${name}.trace" > "${tracesDir}/${name}.trace.tmp" 2> /dev/null &&
          [ -s "${tracesDir}/${name}.trace.tmp" ] && mv "${tracesDir}/${name}.trace.tmp" "${tracesDir}/${name}.trace" ||
          rm -f "${tracesDir}/${name}.trace.tmp";
    done < <( jq -r '.[].traces[]?' <<< "${groups}" );
    # only the traces that were extracted (an objective without its .trace in the export has no link)
    local kept; kept=$( find "${tracesDir}" -maxdepth 1 -name '*.trace' -printf '%f\n' | sed 's/\.trace$//' | jq -R . | jq -s . );
    groups=$( jq --argjson kept "${kept}" '[.[] | .traces = [.traces[]? | select(IN($kept[]))]]' <<< "${groups}" );
    rmdir "${tracesDir}" 2> /dev/null;
    # build and ASAN of the library, from the record of the experiment step (first line of its user run state)
    local cli;
    cli=$( jq -c --arg lib "${lib}" 'first(.task.steps[] | select(.id == $lib) | .user_run_state // "" | split("\n")[]
        | (try fromjson catch null) | select(type == "object" and has("cputs"))) // {}' "${J}" 2> /dev/null ) || cli='{}';
    [ -n "${cli}" ] || cli='{}';
    libs=$( jq --arg lib "${lib}" --argjson a "${attempt}" --argjson found "${found}" --argjson replayed "${replayed}" \
        --argjson logFiles "${logFiles:-0}" --argjson recordCount "${recordCount:-0}" \
        --argjson groups "${groups}" --argjson cli "${cli}" --arg traces "${task}-traces/${lib}/${attempt}" \
        '. + [{ library: $lib, attempt: $a, found: $found, replayed: $replayed, traces_dir: $traces,
          fuzzer_logs: { files: $logFiles, records: $recordCount },
          reports: ([$groups[] | select(.type != "no-crash" and .type != "replay-error" and .type != "not-replayed") | .count] | add // 0), groups: $groups,
          cli: ($cli | {build, cputs, vendor, features, library, vulnerabilities}), asan: $cli.asan.instrumented }]' <<< "${libs}" );
  done < <( jq -r '.task.steps[] | select(.name == "ExperimentEnd")
      | [.id, .attempt_id, (.executor_data.launcher_file // "" | sub(".*/"; "") | sub("-launcher$"; ""))] | @tsv' "${J}" | sort -k1,1 -k2,2n )
  rm -rf "${tmp}";

  # the task: user, type, times, every configuration with its runs, build and ASAN (also those without objective)
  # the outcome of each run in the task's summary ({configuration: {attempt: "success", "fail", or null without
  # end-of-run summary}}): success only when the run ended normally and its summary saw what it looked for; and the
  # job scripts' own verdict ({configuration: {attempt: {cve, targeted}}}: the expected bug they had, null before
  # 2026-10-07, and how many objectives they took for it), compared with the report's (report_verdicts.js)
  local summary outcomes script;
  summary=$( unzip -p "${Z}" artefacts/summary.json 2> /dev/null | jq -c '.libraries // {}' 2> /dev/null );
  [ -n "${summary}" ] || summary='{}';
  outcomes=$( jq -c 'map_values([.data[]? | select(.id != null) | { key: (.id | tostring), value: .state }] | from_entries)' <<< "${summary}" );
  script=$( jq -c 'map_values([.data[]? | select(.id != null and .state != null)
      | { key: (.id | tostring), value: { cve: (.expected_cve // null), targeted: (.nb_objective_targeted // null) } }] | from_entries)' <<< "${summary}" );
  [ -n "${outcomes}" ] || outcomes='{}';
  [ -n "${script}" ] || script='{}';
  local info;
  info=$( jq -c --arg board "${BOARD_URL}" --argjson outcomes "${outcomes}" --argjson script "${script}" '
      [.task.steps[]] as $steps
      | ([.task.steps[] | .time_points_ms // [] | .[] | select(. > 0)]) as $times
      | { name: (.task.name // ""), user: (.task.user // ""), job_type: (.task.job_type // ""),
          started: (if ($times | length) > 0 then ($times | min / 1000 | floor | todate) else null end),
          ended: (if ($times | length) > 0 then ($times | max / 1000 | floor | todate) else null end),
          task_url: "\($board)/files/board/task.html?id=\(.task.id // "")",
          libraries: ([.task.steps[] | select(.name == "ExperimentWithCargo")] | group_by(.id)
            | map((first(.[] | .user_run_state // "" | split("\n")[] | (try fromjson catch null)
                  | select(type == "object" and has("cputs"))) // null) as $cli
              | { library: .[0].id, runs: length, asan: $cli.asan.instrumented,
                  # how the scheduler ended each run (attempt: Done, TimedOut, Failed, Cancelled…): a run that found its
                  # bug is not counted as succeeded when it did not end Done (Results says why)
                  ends: (sort_by(.attempt_id) | map({ key: (.attempt_id | tostring), value: .state }) | from_entries),
                  cli: ($cli // {} | {build, cputs, vendor, features, library, vulnerabilities}) }))
          # the errors of the end-of-run summaries (vuln_experiment_end.js, in the run state of its step, e.g. "Error
          # with stats.json"), per configuration and attempt: a run without summary has no metrics, Results says why
          | map(.library as $lib | . + { end_errors: ([$steps[] | select(.name == "ExperimentEnd" and .id == $lib)
              | { key: (.attempt_id | tostring), value: first(.user_run_state // "" | split("\n")[]
                  | (try fromjson catch null) | select(type == "object" and (.error | type) == "string") | .error) }]
              | from_entries) } + (if $outcomes[.library] then { outcomes: $outcomes[.library] } else {} end)
              + (if $script[.library] then { script: $script[.library] } else {} end)) }' "${J}" 2> /dev/null ) || info='{}';
  [ -n "${info}" ] || info='{}';
  local cancelled=false;
  [[ "${J}" == */Canceled/* ]] && cancelled=true;
  # VulnA/VulnB: the claims that are not their target (PR_common.sh OBJECTIVES_NOT_TARGETED), flagged by the page
  jq --arg task "${task}" --arg commit "${commit}" --argjson info "${info}" --argjson cancelled "${cancelled}" \
      --argjson nt "$( NotTargetedJSON )" --argjson targets "$( Targets "${J}" )" --argjson cves "$( CveSignatures )" \
      '$info + { task: $task, commit: $commit, cancelled: $cancelled, runs: .,
                 not_targeted: (if ($info.job_type // "") | test("^vuln-") then $nt else {} end), targets: $targets,
                 cves: $cves }' \
      <<< "${libs}" > "${OUT}/${task}.json" || return 1;
  # the verdicts of bugs.js (the pages' code) in the report, for runs_report.py and the history page
  "${PB_ROOT}/data/tools/qjs" --std -m "${SCRIPTS}/tools/report_verdicts.js" "${OUT}/${task}.json" || return 1;
  Render "${OUT}/${task}.json" "${OUT}/${task}.html" || return 1;
  echo "${task}: $( jq -r '[.runs[] | "\(.library) run \(.attempt): \(.reports) report(s) in \(.groups | length) group(s)"] | join("; ") | if . == "" then "no objective" else . end' "${OUT}/${task}.json" )";
  echo "  ${URL}/html/objectives/${task}.html";
}

# Targets <export json>: the expected bug of each configuration of a VulnA/VulnB task, from the vendor preset of its steps
# and jobsscripts/tlspuffin/vuln_targets.json ({library: {cve, kind, match}}; {} when none is declared)
Targets() {
  local file="${TARGETS_JSON}";
  [ -r "${file}" ] || { echo '{}'; return; }
  jq -c --slurpfile t "${file}" '[.task.steps | (if type == "object" then [.[]] else . end)[]
      | select(.name == "ExperimentWithCargo" or .name == "ExperimentEnd") | { (.id): (.args.vendor // "") }] | add // {}
      | with_entries(.value = $t[0][.value]) | with_entries(select(.value != null))' "$1" 2> /dev/null || echo '{}';
}

# CveSignatures: the signature of each known CVE ({CVE: {alias, kind, match}}, objectives_page/cve_signatures.jq): a bug
# of a run that tlspuffin declares to have that CVE (cli.vulnerabilities) is not new (bugs.js NewBugs)
CveSignatures() {
  jq -c -f "${SCRIPTS}/tools/objectives_page/cve_signatures.jq" "${TARGETS_JSON}" 2> /dev/null || echo '{}';
}

# Render <json> <html>: page of the objectives of a task ({task, commit, name, live?, updated?, user?, job_type?,
# started?, ended?, cancelled?, task_url?, libraries?, runs: [...]}): a small page that loads report.js and report.css
# (objectives_page/, copied next to the pages), which render the JSON in the browser, organized by bug.
# Each run may carry cli ({build, cputs, vendor, features, library, vulnerabilities} of cli-<library>.json) and asan.
Render() {
  local dir; dir="$( dirname "$2" )";
  local asset;
  for asset in report.js report.css bugs.js; do
    if ! cmp -s "${SCRIPTS}/tools/objectives_page/${asset}" "${dir}/${asset}"; then
      cp "${SCRIPTS}/tools/objectives_page/${asset}" "${dir}/${asset}.tmp" && mv "${dir}/${asset}.tmp" "${dir}/${asset}" || return 1;
    fi
  done
  local json; json="$( basename "$1" )";
  local task; task="$( jq -r '.task // ""' "$1" | sed 's/[^0-9A-Za-z_-]//g' )";
  cat > "$2.tmp" <<EOF_HTML
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Objectives ${task}</title><link rel="stylesheet" href="report.css"></head>
<body><div id="report" data-json="${json}"><p style="padding:20px">Loading the objectives of task ${task}…</p></div>
<script type="module" src="report.js"></script></body></html>
EOF_HTML
  mv "$2.tmp" "$2";
}

# --all: every exported task with objective traces whose page is missing or older than its export or than this
# script (for a cron job: an update of the page format rewrites every page once)
AllTasks() {
  local J id first;
  find -L "${PB_ROOT}/data/exports" "${PB_ROOT}/data/exports/Canceled" -maxdepth 1 -name '*.json' 2> /dev/null |
  grep -E '/[0-9]+\.json$' |
  while read -r J; do
    id=$( basename "${J}" .json );
    [ -f "${J%.json}.zip" ] || continue;
    # first the tasks without a final report (none, or the last live page kept until it, see objectives_live.sh),
    # then the reports older than what makes them: the export, this script, the signatures (ObjectiveSignature,
    # PR_common.sh), the expected bugs (vuln_targets.json) and the verdicts (report_verdicts.js with bugs.js)
    first=1;
    if [ ! -e "${OUT}/${id}.html" ] || grep -q '"pending_final": *true' "${OUT}/${id}.json" 2> /dev/null; then
      first=0;
    elif [ "${OUT}/${id}.html" -nt "${J}" ] && [ "${OUT}/${id}.html" -nt "${BASH_SOURCE[0]}" ] &&
        [ "${OUT}/${id}.html" -nt "${SCRIPTS}/PR_common.sh" ] && [ "${OUT}/${id}.html" -nt "${TARGETS_JSON}" ] &&
        [ "${OUT}/${id}.html" -nt "${SCRIPTS}/tools/report_verdicts.js" ] &&
        [ "${OUT}/${id}.html" -nt "${SCRIPTS}/tools/objectives_page/bugs.js" ]; then
      continue;
    fi
    # a task with objectives, or a Vuln task (its 🎯 also when no run saved any objective: 0/n)
    unzip -Z1 "${J%.json}.zip" 2> /dev/null | grep -qE '^artefacts/[^/]+/[0-9]+-objective/[^.][^/]*\.trace$' ||
        jq -e '(.task.job_type // "") | test("^vuln-")' "${J}" > /dev/null 2>&1 || continue;
    echo "${first} ${id}";
  done | sort -k1,1n -k2,2nr | cut -d' ' -f2
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
    # the counts of the report's verdicts (report_verdicts.js: the pages' code): 🎯 the conclusion of a task with
    # expected bugs, as the banner of its report; 🐞 its objectives and bugs
    jq -c --arg id "${id}" 'select((.runs | length) > 0 or .verdicts.conclusion != null)
        | .verdicts as $v | ($v.conclusion) as $c
        | { ($id): ([
              (if $c then { label: "🎯 \($c.hit)/\($c.configurations) · \($c.counted)/\($c.runs) runs\(if $c.lost > 0 then " +\($c.lost) failed" else "" end)\(if .cancelled then " · cancelled" else "" end)",
                  url: "../objectives/\($id).html", source: "objectives_report", level: "expected-\($c.level)",
                  title: ("🎯 \($c.hit) of \($c.configurations) configurations found their expected bug, in \($c.counted) of \($c.runs) runs that succeeded"
                      + (if $c.lost > 0 then "\n+\($c.lost) failed: runs that found it too but did not succeed (timeout, no end-of-run summary), not counted" else "" end)
                      + (if .cancelled then "\ncancelled: the task was cancelled; its runs that had not started are not counted" else "" end)
                      + "\ngreen: every run; amber: every configuration, not every run; red: a configuration in no run\nClick: the objectives report (new tab)") }
               else empty end),
              (if (.runs | length) > 0 then { label: "🐞", url: "../objectives/\($id).html", source: "objectives_report",
                  count: $v.bugs.objectives, bugs: $v.bugs.count,
                  level: (if $v.bugs.confirmed > 0 then null else "warning" end),
                  title: (if $v.bugs.confirmed > 0
                          then "🐞 \($v.bugs.objectives) objectives, \($v.bugs.count) bug(s), \($v.bugs.confirmed) objectives reproduced by a replay\nClick: the objectives report, grouped by bug (new tab)"
                          else "🐞 \($v.bugs.objectives) objectives, but no replay reproduced a bug (not reproduced, timed out or could not run)\nClick: the objectives report (new tab)" end) }
                 | with_entries(select(.value != null))
               else empty end) ]) }' "${f}";
  done | jq -s 'add // {}' > "${links}.tmp" && mv "${links}.tmp" "${links}";
}

[ "${1:-}" == "--render" ] && { Render "$2" "$3"; exit $?; }
(( $# > 0 )) || { echo "Usage: $0 <task id> ... | --all" >&2; exit 1; }
tasks=( "$@" );
# one --all at a time (cron every 10 minutes): after an update of this script every page is rewritten, which can take
# longer than 10 minutes; overlapping runs shared core 0 and none finished
if [ "$1" == "--all" ]; then
  exec 9> "${OUT}/.report-all.lock" || exit 1;
  flock -n 9 || { echo "$( date '+%F %T' ) another --all is running"; exit 0; };
fi
[ "$1" == "--all" ] && tasks=( $( AllTasks ) );
status=0;
for t in "${tasks[@]}"; do Report "${t}" || status=1; done
TaskLinks || status=1;
# the registry of the bugs found so far, per library (🚨 new bug on the pages): known_bugs.json
if [ "$1" == "--all" ] && [ -x "${PB_ROOT}/data/tools/qjs" ]; then
  "${PB_ROOT}/data/tools/qjs" --std -m "${SCRIPTS}/tools/known_bugs.js" "${OUT}" > /dev/null || status=1;
fi
# the runs of each commit (Results' "🕘 N runs", /html/runs/): after the reports, which give the Vuln bugs
if [ "$1" == "--all" ]; then
  PB_ROOT="${PB_ROOT}" python3 -I "${SCRIPTS}/tools/runs_report.py" --all > /dev/null || status=1;
  # every page and tool tells the same about the Vuln runs (Results, the reports, history, the Runs page): the
  # differences in the log of the cron job
  PB_ROOT="${PB_ROOT}" python3 -I "${SCRIPTS}/tools/check_verdicts.py" || status=1;
fi
exit ${status}
