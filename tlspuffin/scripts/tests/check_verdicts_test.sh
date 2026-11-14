#!/bin/bash
# check_verdicts_test.sh: tools/check_verdicts.py, the cron's cross-check of the pages and tools on the Vuln runs, on
# reports made here (PB_ROOT a scratch root: no summary, no Runs record):
#   - a run whose job scripts did not see the expected bug, which the report finds and counts untimed (the pages say why):
#     explained, counted apart, exit status 0 (else every pass fails on the same old runs);
#   - a run the job scripts found it in and the report not, or one they did not see it in that the report counts with
#     a time to find: a difference, exit status 1;
#   - 🎯 counted runs that are not the runs that found it, and History's 🎯 against the report's conclusion: differences.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
# Case <name> <libraries verdict JSON> <outcomes JSON> [<History's 🎯 label>]: a root with one final report (task 1)
Case() {
  local root="${work}/$1"; mkdir -p "${root}/data/html/objectives" "${root}/data/html/board/custom/tlspuffin"
  # the conclusion as bugs.js ExpectedConclusion gives it, and History's 🎯 as TaskLinks writes it (unless given)
  jq -n --argjson v "$2" --argjson o "$3" '($v.counted | length) as $k | ($o | length) as $n
    | { task: "1", runs: [], libraries: [{ library: "X", outcomes: $o }],
        verdicts: { libraries: { X: $v }, conclusion: { configurations: 1, hit: (if $k > 0 then 1 else 0 end), counted: $k, runs: $n,
                                                        level: (if $k == 0 then "none" elif $k < $n then "partial" else "all" end) } } }' \
    > "${root}/data/html/objectives/1.json"
  jq --arg pill "${4:-}" '.verdicts.conclusion as $c | { "1": [{ source: "objectives_report", level: "expected-\($c.level)",
      label: (if $pill != "" then $pill else "🎯 \($c.hit)/\($c.configurations) · \($c.counted)/\($c.runs) runs" end) }] }' \
    "${root}/data/html/objectives/1.json" > "${root}/data/html/board/custom/tlspuffin/task_links.json"
  echo "${root}"
}
Check() { # <what> <expected status> <expected pattern of the summary> <root> [<pattern of a line>]
  local out status=0
  out=$( PB_ROOT="$4" python3 -I "${here}/../tools/check_verdicts.py" --explained ) || status=$?
  if [ "${status}" -eq "$2" ] && grep -qE "$3" <<< "${out}" && { [ -z "${5:-}" ] || grep -qE "$5" <<< "${out}"; }; then
    echo "ok   $1"
  else
    echo "FAIL $1 (status ${status}): ${out}"; fail=1
  fi
}
explained=$( Case explained '{ "cve": "C", "runs": [0, 1], "found": [0, 1], "counted": [0, 1], "untimed": [{ "attempt": 1 }],
  "script_disagrees": [{ "attempt": 1, "script": false, "report": true }] }' '{ "0": "success", "1": "fail" }' )
Check 'job scripts did not see it, the report finds it and counts the run untimed: explained, status 0' 0 \
  '0 difference\(s\), 1 run\(s\) explained' "${explained}" '^explained: 1 X run 1: job scripts did not find'
scripts=$( Case scripts '{ "cve": "C", "runs": [0], "found": [], "counted": [], "untimed": [],
  "script_disagrees": [{ "attempt": 0, "script": true, "report": false }] }' '{ "0": "success" }' )
Check 'the job scripts found it, the report not: a difference, status 1' 1 '1 difference\(s\)' "${scripts}" '^1 X run 0: job scripts found'
timed=$( Case timed '{ "cve": "C", "runs": [0], "found": [0], "counted": [0], "untimed": [],
  "script_disagrees": [{ "attempt": 0, "script": false, "report": true }] }' '{ "0": "success" }' )
Check 'job scripts did not see it, the report counts it with a time: a difference' 1 '1 difference\(s\)' "${timed}"
counted=$( Case counted '{ "cve": "C", "runs": [0, 1], "found": [0], "counted": [0, 1], "untimed": [] }' '{ "0": "success", "1": "success" }' )
Check '🎯 counts a run that did not find it: a difference' 1 '1 difference\(s\)' "${counted}" 'counted \[0, 1\] but found are \[0\]'
history=$( Case history '{ "cve": "C", "runs": [0], "found": [0], "counted": [0], "untimed": [] }' '{ "0": "success" }' '🎯 0/1 · 0/1 runs' )
Check "History's 🎯 is not the report's conclusion: a difference" 1 '1 difference\(s\)' "${history}" 'history 🎯'
exit "${fail}"
