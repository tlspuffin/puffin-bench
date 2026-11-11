#!/bin/bash
# attach_validation_test.sh [<validation-<library>-<attempt>.json> [<qjs>]]: merges a validation file into a run summary
# the way the summary scripts do (data/tools/js/utils.js AttachValidation, under QuickJS) and checks the result: the
# counts per verdict, the confirmed entries and the verdict of each validated trace. Without a file (or ""): one with
# every verdict.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
file="${1:-}"; qjs="${2:-/srv/puffin-bench/data/tools/qjs}"
[ -x "${qjs}" ] || { echo "SKIP: no qjs at ${qjs}"; exit 0; }
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
if [ -z "${file}" ]; then
  file="${work}/given.json"
  cat > "${file}" <<'JSON'
{ "vendor": "wolfssl:wolfssl540-asan", "objectives": [
  { "trace": "a", "verdict": "confirmed", "entries": ["CVE-2022-39173"] },
  { "trace": "b", "verdict": "confirmed", "entries": ["CVE-2022-39173"] },
  { "trace": "c", "verdict": "not-patched", "entries": [], "known_unpatched": ["CVE-2024-5814"] },
  { "trace": "d", "verdict": "other-signature", "entries": [], "other_signature": ["CVE-2022-42905"] },
  { "trace": "e", "verdict": "inconclusive", "entries": [] },
  { "trace": "f", "verdict": "not-validated", "entries": [] } ] }
JSON
fi
command cp -f "${file}" "${work}/validation-lib-0.json"
cat > "${work}/run.js" <<JS
import * as Utils from '${here}/../../data/tools/js/utils.js';
const lib = {}, attempt = {};
Utils.AttachValidation(lib, attempt, 'lib', 0, '${work}');
Utils.AttachValidation(lib, {}, 'lib', 1, '${work}');   // no file for attempt 1: nothing changes
std.out.puts(JSON.stringify({ lib: lib.validation, attempt: attempt.validation }));
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
exit ${fail}
