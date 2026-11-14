#!/bin/bash
# live_validation_test.sh: the verdicts a live objectives page shows while a task runs (LiveValidation,
# tools/objectives_live.sh): those of the ended attempts (output/validation-<library>-<attempt>.json) and those being
# given in the step folders (validation/verdicts), by "<attempt>/<trace>" per configuration; for the runs of Perf
# validated after all of them (PerfObjectives), in run-<n> under their run numbers. And its configurations (LiveLibraries):
# each with its number of runs and the target of a custom benchmark's experiment (output/cli-<library>.json), also one
# without objective yet (its 🎯 0/n).
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
source <( sed -n '/^StepLibrary()/,/^}/p; /^LiveValidation()/,/^}/p; /^LiveLibraries()/,/^}/p' "${here}/../tools/objectives_live.sh" )

task="${work}/task"
mkdir -p "${task}/output" "${task}/executor/WolfSSL-0/validation/verdicts" "${task}/executor/OpenSSL-0/run-2/validation/verdicts" \
  "${task}/executor/OpenSSL-0/run-3/validation/verdicts"
echo '{ "catalogue": { "source": "dev", "commit": "c" }, "objectives": [ { "trace": "t0", "verdict": "confirmed", "entries": ["CVE-1"] } ] }' \
  > "${task}/output/validation-WolfSSL-0.json"
for d in WolfSSL-0 OpenSSL-0/run-2 OpenSSL-0/run-3; do echo '{ "source": "dev", "catalogueCommit": "c" }' > "${task}/executor/${d}/validation/state.json"; done
echo '{ "trace": "t1", "verdict": "not-patched", "entries": [], "known_unpatched": ["CVE-2"] }' > "${task}/executor/WolfSSL-0/validation/verdicts/t1.json"
echo '{ "trace": "a", "verdict": "inconclusive", "entries": [] }' > "${task}/executor/OpenSSL-0/run-2/validation/verdicts/a.json"
echo '{ "trace": "b", "verdict": "confirmed", "entries": ["CVE-3"] }' > "${task}/executor/OpenSSL-0/run-3/validation/verdicts/b.json"
state='{ "task": { "steps": { "1": { "name": "ExperimentWithCargo", "id": "WolfSSL", "executor_data": { "run_path": "/runs/7/executor/WolfSSL-0" } },
                              "2": { "name": "PerfObjectives", "id": "OpenSSL", "executor_data": { "run_path": "/runs/7/executor/OpenSSL-0" } } } } }'
got=$( LiveValidation "${task}" "${state}" )
check 'an ended attempt: its verdicts' 'jq -e ".WolfSSL.byTrace[\"0/t0\"].verdict == \"confirmed\"" <<< "${got}" > /dev/null'
check 'an attempt running: its verdicts so far, during the attempt' 'jq -e ".WolfSSL.byTrace[\"0/t1\"] | .verdict == \"not-patched\" and .during_attempt" <<< "${got}" > /dev/null'
check 'Perf after its runs: each run under its run number, not "during the run"' 'jq -e ".OpenSSL.byTrace | .[\"2/a\"].verdict == \"inconclusive\" and .[\"3/b\"].verdict == \"confirmed\" and (.[\"2/a\"].during_attempt | not)" <<< "${got}" > /dev/null'
# a verdict of an ended attempt's result is kept over the same one being given
echo '{ "objectives": [ { "trace": "a", "verdict": "confirmed", "entries": ["CVE-9"] } ] }' > "${task}/output/validation-OpenSSL-2.json"
got=$( LiveValidation "${task}" "${state}" )
check 'the result of an ended run wins over its verdicts being given' 'jq -e ".OpenSSL.byTrace[\"2/a\"].verdict == \"confirmed\"" <<< "${got}" > /dev/null'

# the configurations: a custom one (its target as its experiment recorded it), twin steps (2 runs each), one without cli
echo '{ "vendor": "wolfssl:wolfssl552-asan-only-CVE-2023-6936", "custom": { "benchmark": "custom", "target": "CVE-2023-6936", "oracle": { "kind": "crash", "asan": "heap-buffer-overflow" } } }' \
  > "${task}/output/cli-custom_CALLB.json"
echo '{ "vendor": "wolfssl:wolfssl540-asan" }' > "${task}/output/cli-Twin.json"
state='{ "task": { "steps": [ { "name": "ExperimentWithCargo", "id": "custom_CALLB" }, { "name": "ExperimentWithCargo", "id": "custom_CALLB" },
                              { "name": "TwinExperiment", "id": "Twin" }, { "name": "ExperimentWithCargo", "id": "NoCli" }, { "name": "PerfObjectives", "id": "Twin" } ] } }'
got=$( LiveLibraries "${task}" "${state}" )
check 'LiveLibraries: a custom configuration without objective yet has its target (cli.custom), its runs' \
  'jq -e "(.[] | select(.library == \"custom_CALLB\")) | .runs == 2 and .cli.custom.target == \"CVE-2023-6936\"" <<< "${got}" > /dev/null'
check 'LiveLibraries: twin steps count 2 runs, no target without cli.custom, none without cli' \
  'jq -e "map({ (.library): [.runs, (.cli.custom.target // null)] }) | add == { Twin: [2, null], NoCli: [1, null], custom_CALLB: [2, \"CVE-2023-6936\"] }" <<< "${got}" > /dev/null'
check 'LiveLibraries: a state that cannot be read gives no configuration' '[ "$( LiveLibraries "${task}" "not json" )" == "[]" ]'
exit "${fail}"
