#!/bin/bash
#
# Validation of the compat rules on a test machine: waits until the given tasks are finished, then checks each
# task (applied rules, LibAFL version, ASAN, LibreSSL support, log volume) against what is expected for its commit,
# and compares the executions of an A/B pair. Writes the report to stdout.
#
# Usage: bash validation_report.sh <task id> ...
#   PB_ROOT       install root (default /srv/puffin-bench)
#   PB_WAIT_MIN   minutes between checks while waiting (default 10)

set -u

PB_ROOT="${PB_ROOT:-/srv/puffin-bench}"
E="${PB_ROOT}/data/exports"
WAIT_MIN="${PB_WAIT_MIN:-10}"
TASKS=( "$@" )
(( ${#TASKS[@]} > 0 )) || { echo "Usage: $0 <task id> ..." >&2; exit 2; }

# expected rules per commit prefix of the validation set (comma-separated, order of COMPAT_RULES); "-" = none
ExpectedRules() {
  case "$1" in
    1957fba63*) echo "wolfssl_reseed_error,toml_cli_locked" ;;
    2f38bf22a*) echo "wo_bit,wo_trunc,log_config,reseed_warn,codec_warn,wolfssl_reseed_warn,openssl_descriptor_info,wolfssl_descriptor_info,boringssl_clear_info" ;;
    dcf9ff4e7*) echo "codec_warn,wolfssl_reseed_warn,boringssl_clear_info,stats_monitor_heartbeat" ;;
    5c588ab11*) echo "codec_warn,wolfssl_reseed_warn,boringssl_clear_info" ;;
    *) echo "?" ;;
  esac
}
ExpectedLibAFL() {
  case "$1" in
    1957fba63*|2f38bf22a*) echo "0.11.2" ;;
    dcf9ff4e7*|5c588ab11*) echo "0.15.4" ;;
    *) echo "?" ;;
  esac
}

# export of a finished task: <id>.json and <id>.zip in exports/ (or exports/Canceled/); while the scheduler archives
# a task, a copy of its json also sits in exports/<id>/ and the zip is <id>.zip.tmp: not finished yet
TaskFile() {
  local d;
  for d in "${E}" "${E}/Canceled"; do
    [ -f "${d}/$1.json" ] && [ -f "${d}/$1.zip" ] && { echo "${d}/$1.json"; return; }
  done
}
# task argument (the export stores args, and the values set by the steps in argsToUpdate, as [{key, value}])
Arg() {  # Arg <task json> <key>
  jq -r --arg k "$2" '[(.task.args, .task.argsToUpdate) | (if type == "array" then .[] elif type == "object" then to_entries[] else empty end)
    | select(.key == $k) | .value] | last // ""' "$1"
}

# ---- wait until every task is archived (zip written)
while true; do
  pending=()
  for t in "${TASKS[@]}"; do [ -n "$( TaskFile "${t}" )" ] || pending+=( "${t}" ); done
  (( ${#pending[@]} == 0 )) && break
  echo "$( date '+%F %T' ) waiting for ${#pending[@]} task(s): ${pending[*]}" >&2
  for t in "${pending[@]}"; do
    [ -d "${E}/${t}" ] || [ -d "${E}/Canceled/${t}" ] &&
        echo "  ${t}: being archived (if this lasts, look for '[Archiver]' errors in the scheduler log)" >&2
  done
  sleep $(( WAIT_MIN * 60 ))
done

nbFail=0
Check() {  # Check <ok?> <label> <detail>
  if [ "$1" == "1" ]; then echo "  OK    $2"; else echo "  FAIL  $2  ($3)"; (( ++nbFail )); fi
}

declare -A EXECS
for t in "${TASKS[@]}"; do
  J="$( TaskFile "${t}" )"
  Z="${J%.json}.zip"
  commit=$( Arg "${J}" COMMIT_ID )
  disable=$( Arg "${J}" COMPAT_DISABLE )
  applied=$( Arg "${J}" COMPAT_APPLIED )
  libafl=$( Arg "${J}" LIBAFL_VERSION )
  echo
  echo "### task ${t}  $( jq -r '.task.name // ""' "${J}" )  state=$( jq -r '.task.state // "?"' "${J}" )  ${J#${E}/}"
  echo "  commit ${commit:-?}  LIBAFL_VERSION=${libafl:-<empty>}  AFL_CORES_GRAMMAR=$( Arg "${J}" AFL_CORES_GRAMMAR )"
  echo "  COMPAT_APPLIED=${applied:-<none>}${disable:+  COMPAT_DISABLE=${disable}}"
  echo "  steps: $( jq -r '[.task.steps[] | "\(.name):\(.state)"] | group_by(.) | map("\(.[0])x\(length)") | join(" ")' "${J}" )"

  exp=$( ExpectedRules "${commit}" )
  known=0
  if [ "${exp}" != "?" ]; then
    known=1
    [ "${exp}" == "-" ] && exp=''
    if [ "${disable}" == "all" ]; then
      exp=''
    elif [ -n "${disable}" ]; then
      exp=$( tr ',' '\n' <<< "${exp}" | grep -v -x -F -f <( tr ',' '\n' <<< "${disable}" ) | paste -sd, )
    fi
    [ "${applied}" == "${exp}" ] && ok=1 || ok=0
    Check ${ok} "rules applied" "expected '${exp}', got '${applied}'"
    expv=$( ExpectedLibAFL "${commit}" )
    [ "${libafl}" == "${expv}" ] && ok=1 || ok=0
    Check ${ok} "LibAFL version ${expv}" "got '${libafl}'"
    grammar=$( Arg "${J}" AFL_CORES_GRAMMAR )
    expg=0; [ "${expv}" == "0.15.4" ] && expg=1
    [ "${grammar}" == "${expg}" ] && ok=1 || ok=0
    Check ${ok} "--cores syntax (AFL_CORES_GRAMMAR=${expg})" "got '${grammar}'"
  fi

  summary=$( unzip -Z1 "${Z}" 2> /dev/null | grep -m1 'summary\.json$' )
  if [ -z "${summary}" ]; then
    Check 0 "summary.json present" "no summary.json in ${Z##*/}"
    continue
  fi
  S="$( unzip -p "${Z}" "${summary}" )"
  # experiments end at the step timeout (TimedOut = normal end); one that ended before is a failed run (broker panic,
  # hang-detection kill, ...), except for the libraries deliberately not run (unsupported, see CompatBuildRules)
  early=$( jq -r --argjson s "${S}" '[.task.steps[] | select(.name == "ExperimentWithCargo" and .state != "TimedOut")
    | .args.experiment // "?" | select(($s.libraries[.].unsupported // null) == null)]
    | group_by(.) | map("\(.[0])x\(length)") | join(" ")' "${J}" )
  [ -z "${early}" ] && ok=1 || ok=0
  Check ${ok} "every experiment ran until the timeout" "ended before: ${early}"
  missing=$( jq -r --argjson s "${S}" '[.task.steps[] | select(.name == "ExperimentWithCargo") | .args.experiment // empty] | unique
    | map(select(($s.libraries[.] // null) == null)) | join(",")' "${J}" )
  [ -z "${missing}" ] && ok=1 || ok=0
  Check ${ok} "every library in the summary" "missing (no successful run): ${missing}"
  echo "  libraries:"
  jq -r '.libraries | to_entries[] | .value as $l
    | "    \(.key): asan=\($l.cli.asan.instrumented | if . == null then "?" else tostring end) cputs=\($l.cli.cputs | if . == null then "?" else tostring end)"
      + (if $l.unsupported then " UNSUPPORTED(\($l.unsupported))" else "" end)
      + " runs=\([$l.data[]? | .state // "error"] | join(","))"
      + " execs=\([$l.data[]? | .global[0].tEnd.total_execs? // empty] | join(","))"
      + " logs_max_mb=\($l.log_max_mb // "?") log_warning=\([$l.log_warning[]?] | join(","))"
      + " restarts=\([$l.data[]? | .logs.crashes.client_restarts // "?"] | map(tostring) | join(",")) crash_warning=\([$l.crash_warning[]?] | join(","))"
      + (if ($l.cli.vendor_sources // [] | length) > 0
         then " sources=\([$l.cli.vendor_sources[] | "\(.name):\(.ref // .hash // "")@\((.commit // "?")[0:9])"] | join(","))" else "" end)' <<< "${S}"

  # ASAN: every library that ran must be instrumented; LibreSSL before cd649d6bf must be unsupported
  bad=$( jq -r '[.libraries | to_entries[] | select((.value.unsupported | not) and (.value.cli.asan.instrumented != true)) | .key] | join(",")' <<< "${S}" )
  [ -z "${bad}" ] && ok=1 || ok=0
  Check ${ok} "ASAN on every library that ran" "not instrumented or unknown: ${bad}"
  libre=$( jq -r '.libraries | to_entries[] | select(.key | test("libre"; "i")) | .value.unsupported // ""' <<< "${S}" )
  if [[ "${commit}" == 1957fba63* ]]; then
    [[ "${libre}" == *"ASAN unsupported"* ]] && ok=1 || ok=0
    Check ${ok} "LibreSSL marked ASAN unsupported" "got '${libre}'"
  fi
  warned=$( jq -r '[.libraries | to_entries[] | select((.value.log_warning // []) | length > 0) | .key] | join(",")' <<< "${S}" )
  if [[ ",${disable}," == *,log_config,* || ",${disable}," == *,all,* ]]; then
    [ -n "${warned}" ] && ok=1 || ok=0
    Check ${ok} "log warning raised (log_config disabled)" "no library warned"
  elif (( known )); then
    [ -z "${warned}" ] && ok=1 || ok=0
    Check ${ok} "no log warning" "warned: ${warned}"
  fi

  # executions per library (mean over successful attempts) for the A/B comparison
  while read -r lib mean; do
    EXECS["${commit}|${disable}|${lib}"]="${mean}"
  done < <( jq -r '.libraries | to_entries[] | [.key, ([.value.data[]? | select(.state == "success") | .global[0].tEnd.total_execs? // empty] | if length > 0 then (add / length | floor) else "-" end)] | @tsv' <<< "${S}" )
done

# ---- A/B: same commit with and without log_config
echo
echo "### A/B log_config (mean executions of the successful attempts)"
for key in "${!EXECS[@]}"; do
  IFS='|' read -r commit disable lib <<< "${key}"
  [[ "${disable}" == *log_config* ]] || continue
  base="${EXECS["${commit}||${lib}"]:-}"
  echo "  ${commit:0:9} ${lib}: rules=${base:--} log_config_disabled=${EXECS[${key}]}$( [[ "${base}" =~ ^[0-9]+$ && "${EXECS[${key}]}" =~ ^[0-9]+$ && "${EXECS[${key}]}" -gt 0 ]] && echo "  ratio=$( awk "BEGIN { printf \"%.2f\", ${base} / ${EXECS[${key}]} }" )" )"
done

echo
echo "### ${nbFail} check(s) failed"
