#!/bin/bash

THEJOB_UTILS_PATH="$( realpath "${BASH_SOURCE[0]}" )"

QueryCache() {
  local quiet=0
  while [[ "$1" == -* ]]; do
    case "$1" in
      -q) quiet=1; shift ;;
      *) break ;;
    esac
  done

  local cache_id="$1"
  local timeout="${2:-0}"
  local server_url="http://localhost:${THEJOB_CACHE_PORT}/api/cache"
  local delay=1
  if [ -z "$cache_id" ]; then
    #echo "Usage: $0 <cache_id> [timeout_seconds]"
    echo "Missing requiered parmeter cache id"
    return 1
  fi

  [[ "$quiet" -eq 0 ]] && echo "Waiting file '$cache_id' to be ready in cache..."

  START_TIME=$(date +%s)

  while true; do
    local response=$(curl -s -X GET "$server_url/$cache_id")

    local success=$(echo "$response" | jq -r '.success')
    local error=$(echo "$response" | jq -r '.error')
    local state=$(echo "$response" | jq -r '.state')
    local path_val=$(echo "$response" | jq -r '.path // empty')

    [[ "$quiet" -eq 0 ]] && echo "Got: success=$success, state=$state, error='$error', path=$path_val"

    if [[ "$state" == "Ok" ]]; then
      [[ "$quiet" -eq 0 ]] && echo "File ready: $path_val" || echo ${path_val}
      break
    elif [[ "$state" == "Locked" ]]; then
      [[ "$quiet" -eq 0 ]] && echo "File locked, new try in $delay s..."
    elif [[ "$state" == "Not Available" ]]; then
      [[ "$quiet" -eq 0 ]] && echo "File unavailable (Not Available). Aborting."
      return 2
    else
      [[ "$quiet" -eq 0 ]] && echo "Unknown state or invalid response. Raw response: $response"
      return 3
    fi

    if [[ "$timeout" -gt 0 ]]; then
      NOW=$(date +%s)
      ELAPSED=$((NOW - START_TIME))
      if [[ "$ELAPSED" -ge "$timeout" ]]; then
        [[ "$quiet" -eq 0 ]] && echo "Timeout reached after $ELAPSED seconds. Aborting."
        return 4
      fi
    fi

    sleep "$delay"
  done

  return 0
}

SetCache() {
  local cache_id="$1"
  [ -z "${cache_id}" ] && return 64;
  shift
  local file="$1"
  [ ! -r "${file}" ] && return 64;
  shift
  curl -s -X PUT "http://localhost:${THEJOB_CACHE_PORT}/api/cache/${cache_id}" -H "Content-Type: application/json" --data-binary "{\"path\": \"${file}\"}"
  return $?
}

AddParam() {
  local varname="$1"
  local key="$2"
  local value="$3"
  value="${value//\"/\\\"}"
  eval "$varname+=\ \"$key=\\\"$value\\\"\""
}

AddGlobalParam() {
  AddParam THEJOB_GLBPARMS "$1" "$2"
}

CreateArtefact() {
  local path=$( realpath "$1" )
  local name="$2"
  shift 2

  local jq_expr='{"path": $path, "name": $name}'
  local jq_args=(--arg path "$path" --arg name "$name")

  if [ "$#" -gt 0 ]; then
    jq_expr+=' | .metadata = {}'
    for pair in "$@"; do
      key="${pair%%:*}"
      value="${pair#*:}"
      if [[ "$value" =~ ^[0-9]+$ ]]; then
        jq_expr+=" | .metadata[\"$key\"] = \$meta_${key}"
        jq_args+=(--argjson "meta_${key}" "$value")
      elif [[ "$value" =~ ^(true|false|null)$ ]]; then
        jq_expr+=" | .metadata[\"$key\"] = \$meta_${key}"
        jq_args+=(--argjson "meta_${key}" "$value")
      else
        jq_expr+=" | .metadata[\"$key\"] = \$meta_${key}"
        jq_args+=(--arg "meta_${key}" "$value")
      fi
    done
  fi

  jq -c -n "${jq_args[@]}" "$jq_expr" >> "${THEJOB_ARTEFACTS_FILE}"
}

EndDirectChild() {
  local pid=$1;
  if [ -z "${pid}" ]; then
    echo "EndDirectChild require a pid as parameter" >&2
    return 0;
  fi
  if ! kill -0 ${pid} 2>/dev/null; then
    echo "EndDirectChild: ${pid} is not running" >&2
    return 0;
  fi
  local ppid=$( ps -o ppid= -p ${pid} 2>/dev/null | tr -d ' ' )
  if [ "${ppid}" != "$$" ]; then
    echo "EndDirectChild: running ${pid} is not a direct child of $$" >&2
    return 0;
  fi
  local sleepTime=0.5
  local maxAttempt=8
  for sig in TERM KILL; do
    kill -${sig} ${pid} 2>/dev/null
    local attempt=0
    while (( $attempt < $maxAttempt )); do
      sleep ${sleepTime}
      if ! kill -0 ${pid} 2>/dev/null; then
        wait ${pid} 2>/dev/null
        return 0;
      fi
      attempt=$(( $attempt + 1))
    done
  done
  echo "EndDirectChild: Failed to kill process ${pid} after all attempts" >&2
  return 0;
}

StartMonitor() {
  if [ -z "${THEJOB_MONITOR_PARAMETERS_PATH}" ]; then
    echo "No monitor entry point for this step" >&2
    return 0
  fi
  if [ ! -z "${THEJOB_MONITOR_PID}" ]; then
    echo "Monitor already running, pid: ${THEJOB_MONITOR_PID}" >&2
    return 0
  fi
  local monitor_entry monitor_interval_s monitor_timeout_s monitor_delay_s monitor_output
  read -r monitor_entry monitor_interval_s monitor_timeout_s monitor_delay_s monitor_output <<< "${THEJOB_MONITOR_PARAMETERS_PATH}"
  {
    monitor_output_tmp="${monitor_output}.tmp.${BASHPID}"
    sleep ${monitor_delay_s}
    while true ; do
      if [ -z "${monitor_timeout_s}" ]; then
        ${monitor_entry} "${monitor_output_tmp}" $@
      else 
        timeout ${monitor_timeout_s} /bin/bash -c "THEJOB_SH_CONFIG_FILE=\"${THEJOB_SH_CONFIG_FILE}\"; source \"${THEJOB_UTILS_PATH}\"; source \"${THEJOB_FUNCTIONS_PATH}\"; ${monitor_entry} \"${monitor_output_tmp}\" \$@" -- $@;
        case $? in
          124)
            echo "monitor has timeouted" >> "${monitor_output_tmp}"
            ;;
          125)
            echo "timeout internal fail" >> "${monitor_output_tmp}"
            ;;
          *)
            ;;
        esac
      fi
      mv "${monitor_output_tmp}" "${monitor_output}"
      sleep ${monitor_interval_s}
    done
  }&
  THEJOB_MONITOR_PID=$!
}

StopMonitor() {
  if [ ! -z "${THEJOB_MONITOR_PID}" ]; then
    EndDirectChild ${THEJOB_MONITOR_PID}
  fi
  if [ -z "${THEJOB_MONITOR_PARAMETERS_PATH}" ]; then
    return 0
  fi
  local monitor_entry monitor_interval_s monitor_timeout_s monitor_delay_s monitor_output
  read -r monitor_entry monitor_interval_s monitor_timeout_s monitor_delay_s monitor_output <<< "${THEJOB_MONITOR_PARAMETERS_PATH}"
  monitor_output_tmp="${monitor_output}.tmp.${THEJOB_MONITOR_PID}"
  if [ -z "${monitor_timeout_s}" ]; then
    ${monitor_entry} "${monitor_output_tmp}" $@
  else
    timeout ${monitor_timeout_s} /bin/bash -c "THEJOB_SH_CONFIG_FILE=\"${THEJOB_SH_CONFIG_FILE}\"; source \"${THEJOB_UTILS_PATH}\"; source \"${THEJOB_FUNCTIONS_PATH}\"; ${monitor_entry} \"${monitor_output_tmp}\" \$@" -- $@;
    case $? in
      124)
        echo "monitor has timeouted" >> "${monitor_output_tmp}"
        ;;
      125)
        echo "timeout internal fail" >> "${monitor_output_tmp}"
        ;;
      *)
        ;;
    esac
  fi
  mv "${monitor_output_tmp}" "${monitor_output}"
}

SetupEnv() {
  THEJOB_SH_CONFIG_DATA=$( cat ${THEJOB_SH_CONFIG_FILE} )
  eval ${THEJOB_SH_CONFIG_DATA}

  if [ -r "${THEJOB_ENV_PATH}" ]; then
    THEJOB_GLBPARMS=$( cat "${THEJOB_ENV_PATH}" )
    eval ${THEJOB_GLBPARMS}
  fi

  if [ -r "${THEJOB_PARAMETERS_PATH}" ]; then
    THEJOB_RUNPARMS=$( cat "${THEJOB_PARAMETERS_PATH}" )
    eval ${THEJOB_RUNPARMS}
  fi

  if [ ! -z "${THEJOB_MONITOR_PARAMETERS_PATH}" ]; then
    THEJOB_MONITOR_ENTRY="${THEJOB_MONITOR_PARAMETERS_PATH%% *}"
  fi
}

AbortFail() {
  echo "$@"
  "$@" || ( echo "Fail: $*"; false )
}


SetupEnv
