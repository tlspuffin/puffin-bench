#!/bin/bash

echo "task parameters: $*"

THEJOB_GLBPARMS=
if [ ! -r "$1" ]; then
  echo "Unable to read configuration file $1"
  exit 1
fi
THEJOB_SH_CONFIG_FILE="$1"
shift

FUNCSPATH="$( dirname $( realpath $0 ) )/functions.sh"
source "${FUNCSPATH}"

if [ ! -r "${THEJOB_FUNCTIONS_PATH}" ]; then
  echo "Tools directory is not readable: ${THEJOB_FUNCTIONS_PATH}"
  exit 1
fi

if [ ! -w "${THEJOB_OUT_PATH}" ]; then
  echo "Output directory is not writable: ${THEJOB_OUT_PATH}"
  exit 1
fi

if [ -z "${THEJOB_ARTEFACTS_FILE}" ]; then
  echo "Artefacts metada file is missing"
  exit 1
fi

if [ ! -r "${THEJOB_ARTEFACTS_PATH}" ]; then
  echo "Artefacts directory is missing"
  exit 1
fi

if [ ! -r "${THEJOB_TOOLS_PATH}" ]; then
  echo "Tools directory is not readable: ${THEJOB_TOOLS_PATH}"
  exit 1
fi

if [ ! -r "${THEJOB_USER_FILES_PATH}" ]; then
  echo "Input directory is not readable: ${THEJOB_USER_FILES_PATH}"
  exit 1
fi

if [ -z "${THEJOB_UNIQ_STEP}" ]; then
  echo "Update env info missing"
  exit 1
fi
echo "UPDATE_ENV= ${THEJOB_UNIQ_STEP}"

if [ -z "${THEJOB_PID}" ]; then
  echo "Missing sid"
  exit 1
fi

if [ -z "${THEJOB_STEP_ID}" ]; then
  echo "Missing step name"
  exit 1
fi
if [ "${THEJOB_STEP_ID}" = "." ]; then
  THEJOB_STEP_ID="unnamed"
fi

if [ -z "${THEJOB_ATTEMPT_ID}" ]; then
  echo "Missing attempt id"
  exit 1
fi


if [ -z "${THEJOB_RUN_ID}" ]; then
  echo "Missing run id"
  exit 1
fi

if [ -z "${THEJOB_CORES}" ]; then
  echo "Missing cores list"
  exit 1
fi
THEJOB_NB_CORES=$(IFS=, read -ra cpus <<<"${THEJOB_CORES}"; echo "${#cpus[@]}")

if [ -z "${THEJOB_ENTRYPOINT}" ]; then
  echo "Missing function name"
  exit 1
fi

if [ -z "${THEJOB_PARAMETERS_PATH}" ]; then
  echo "Missing parameters data"
  exit 1
fi

if [ -z "${THEJOB_STDOUT_PATH}" ]; then
  echo "Missing stdout file"
  exit 1
fi

if [ -z "${THEJOB_STDERR_PATH}" ]; then
  echo "Missing stderr file"
  exit 1
fi

if [[ "$1" != "---" ]]; then
  echo "Missing end of executor parameter: $1"
  exit 1
fi
shift

if [ ! -r "${THEJOB_ENV_PATH}" ]; then
  if [ -z "${THEJOB_ENV_PATH}" ]; then
    echo "Required env file is missing"
    exit 1
  fi
  touch "${THEJOB_ENV_PATH}"
fi

source "${THEJOB_FUNCTIONS_PATH}"

if ! declare -F "${THEJOB_ENTRYPOINT}" > /dev/null; then
  echo "${THEJOB_ENTRYPOINT} does not exist"
  exit 1
fi

if [ ! -z "${THEJOB_MONITOR_PARAMETERS_PATH}" ]; then
  if ! declare -F "${THEJOB_MONITOR_ENTRY}" > /dev/null; then
    echo "${THEJOB_MONITOR_ENTRY} does not exist"
    exit 1
  fi
fi

echo "task env: $( cat "${THEJOB_ENV_PATH}" )"
echo "In: ${THEJOB_GLBPARMS}"

echo "step run params: $( cat "${THEJOB_PARAMETERS_PATH}" )"
echo "Params: ${THEJOB_RUNPARMS}"

pushd . >/dev/null
${THEJOB_ENTRYPOINT} "$@"
THEJOB_RETVAL=$?

StopMonitor
popd >/dev/null

if [[ "${THEJOB_UNIQ_STEP}" == "1" ]]; then
  echo "Out: ${THEJOB_GLBPARMS}"
  echo "${THEJOB_GLBPARMS}" > "${THEJOB_ENV_PATH}"
fi

echo ${THEJOB_RETVAL} > .done.tmp
mv .done.tmp .done
exit ${THEJOB_RETVAL}
