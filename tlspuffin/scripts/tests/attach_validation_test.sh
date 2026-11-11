#!/bin/bash
# attach_validation_test.sh [<validation-<library>-<attempt>.json> [<qjs>]]: merges a validation file into a run summary
# the way the summary scripts do (data/tools/js/utils.js AttachValidation, under QuickJS) and checks the result: the
# counts per verdict, the confirmed entries and the verdict of each validated trace. Without a file (or ""): one with
# every verdict, what failed for an error, the bugs it knew and the bench that validated; then an attempt with
# objectives and no validation file (an error of the library: no validation result) and one without objectives
# (nothing).
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
file="${1:-}"; qjs="${2:-/srv/puffin-bench/data/tools/qjs}"
[ -x "${qjs}" ] || { echo "SKIP: no qjs at ${qjs}"; exit 0; }
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
if [ -z "${file}" ]; then
  file="${work}/given.json"
  cat > "${file}" <<'JSON'
{ "vendor": "wolfssl:wolfssl540-asan", "bench": { "commit": "c787eb8", "jobscripts": "2f35e8c" },
  "entries": { "CVE-2022-39173": { "state": "active", "alias": "BUF", "oracle": { "kind": "crash", "asan": "stack-buffer-overflow" } } },
  "objectives": [
  { "trace": "a", "verdict": "confirmed", "entries": ["CVE-2022-39173"] },
  { "trace": "b", "verdict": "confirmed", "entries": ["CVE-2022-39173"] },
  { "trace": "c", "verdict": "not-patched", "entries": [], "known_unpatched": ["CVE-2024-5814"] },
  { "trace": "d", "verdict": "other-signature", "entries": [], "other_signature": ["CVE-2022-42905"] },
  { "trace": "e", "verdict": "inconclusive", "entries": [] },
  { "trace": "f", "verdict": "not-validated", "entries": [] },
  { "trace": "g", "verdict": "error", "entries": [], "failure": { "build": "F", "message": "no outcome, exit status 2: error: x" } } ] }
JSON
fi
command cp -f "${file}" "${work}/validation-lib-0.json"
cat > "${work}/run.js" <<JS
import * as Utils from '${here}/../../data/tools/js/utils.js';
const lib = {}, attempt = {};
Utils.AttachValidation(lib, attempt, 'lib', 0, '${work}');
const before = JSON.stringify(lib);
Utils.AttachValidation(lib, {}, 'lib', 2, '${work}');   // no file, no objective: nothing changes
const unchanged = JSON.stringify(lib) === before;
// no file for attempt 1, which saved objectives: an error of the library
Utils.AttachValidation(lib, { clients: [{ tEnd: { objective_size: 0 } }, { tEnd: { objective_size: 4 } }] }, 'lib', 1, '${work}');
std.out.puts(JSON.stringify({ lib: lib.validation, attempt: attempt.validation, unchanged }));
JS
got=$( "${qjs}" --std -m "${work}/run.js" )
want=$( jq -c '{ verdicts: ([.objectives[].verdict] | group_by(.) | map({ (.[0]): length }) | add // {}),
  confirmed: ([.objectives[].entries[]?] | group_by(.) | map({ (.[0]): length }) | add // {}),
  traces: ([.objectives[] | { ("0/" + .trace): .verdict }] | add // {}) }' "${file}" )
fail=0
for check in verdicts confirmed; do
  [ "$( jq -cS ".lib.${check}" <<< "${got}" )" == "$( jq -cS ".${check}" <<< "${want}" )" ] &&
    echo "ok   ${check}: $( jq -c ".lib.${check}" <<< "${got}" )" || { echo "FAIL ${check}: got $( jq -c ".lib.${check}" <<< "${got}" ), want $( jq -c ".${check}" <<< "${want}" )"; fail=1; }
done
[ "$( jq -cS '.lib.byTrace | map_values(.verdict)' <<< "${got}" )" == "$( jq -cS .traces <<< "${want}" )" ] &&
  echo "ok   verdict of each trace" || { echo "FAIL verdict of each trace"; fail=1; }
[ "$( jq -c '.attempt.verdicts' <<< "${got}" )" == "$( jq -c '.lib.verdicts' <<< "${got}" )" ] &&
  echo "ok   the attempt keeps its counts" || { echo "FAIL attempt counts"; fail=1; }
[ "$( jq -r '.lib.byTrace["0/g"].failure.message' <<< "${got}" )" == "no outcome, exit status 2: error: x" ] &&
  echo "ok   an error keeps what failed" || { echo "FAIL an error keeps what failed"; fail=1; }
[ -z "${1:-}" ] && { [ "$( jq -c '[.lib.entries["CVE-2022-39173"].alias, .lib.entries["CVE-2022-39173"].oracle.asan, .lib.bench[0].jobscripts]' <<< "${got}" )" == '["BUF","stack-buffer-overflow","2f35e8c"]' ] &&
  echo "ok   the bugs it knew and the bench" || { echo "FAIL the bugs it knew and the bench: $( jq -c '[.lib.entries, .lib.bench]' <<< "${got}" )"; fail=1; }; }
[ "$( jq -c '[.unchanged, (.lib.errors | map(.attempt))]' <<< "${got}" )" == '[true,[1]]' ] &&
  echo "ok   no validation file: an error only for an attempt with objectives" || { echo "FAIL missing file: $( jq -c '[.unchanged, .lib.errors]' <<< "${got}" )"; fail=1; }
exit ${fail}
