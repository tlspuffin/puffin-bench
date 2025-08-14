#!/bin/bash

echo "task parameters: $*"

GLBPARMS=

AddParam() {
  local varname="$1"
  local key="$2"
  local value="$3"
  value="${value//\"/\\\"}"
  eval "$varname+=\ \"$key=\\\"$value\\\"\""
}

AddGlobalParam() {
  AddParam GLBPARMS "$1" "$2"
}

CreateArtefact() {
  local path=$( realpath "$1" )
  local name="$2"
  shift 2

  local artefact_file="${ROOT_PATH}/.artefacts"

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

  jq -c -n "${jq_args[@]}" "$jq_expr" >> "${artefact_file}"
}

AbortFail() {
  "$@" || ( echo "Fail: $*"; false )
}

ROOT_PATH=$( pwd )

if [ ! -r "$1" ]; then
  echo "Unable to read $1"
  exit 1
fi
SRCFILE=$1
shift

if [ ! -r "$1" ]; then
  if [ -z "$1" ]; then
    echo "Required env file is missing"
    exit 1
  fi
  touch $1
fi
ENVFILE=$1
shift

if [ ! -w "$1" ]; then
  echo "Output directory is not writable: $1"
  exit 1
fi
COMMONPATH=$1
shift

if [ ! -w "$1" ]; then
  echo "Output directory is not writable: $1"
  exit 1
fi
OUTPATH=$1
shift

if [ ! -r "$1" ]; then
  echo "Tools directory is not readable: $1"
  exit 1
fi
TOOLSPATH=$1
shift

if [ ! -r "$1" ]; then
  echo "Input directory is not readable: $1"
  exit 1
fi
INPATH=$1
shift

if [ -z "$1" ]; then
  echo "Update env info missing"
  exit 1
fi
UPDATE_ENV=$1
shift
echo "UPDATE_ENV= ${UPDATE_ENV}"

if [ -z "$1" ]; then
  echo "Missing sid"
  exit 1
fi
SID=$1
shift

if [ -z "$1" ]; then
  echo "Missing step name"
  exit 1
fi
STEP_NAME=$1
if [ "${STEP_NAME}" = "." ]; then
  STEP_NAME=
fi
shift

if [ -z "$1" ]; then
  echo "Missing attempt id"
  exit 1
fi
ATTEMPT_ID=$1
shift

if [ -z "$1" ]; then
  echo "Missing run id"
  exit 1
fi
RUN_ID=$1
shift

if [ -z "$1" ]; then
  echo "Missing cores list"
  exit 1
fi
CORES=$1
NBCORES=$(IFS=, read -ra cpus <<<"$CORES"; echo "${#cpus[@]}")
shift

if [ -z "$1" ]; then
  echo "Missing function name"
  exit 1
fi
COMMAND=$1
shift

if [ -z "$1" ]; then
  echo "Missing parameters data"
  exit 1
fi
PARAMETERSFILE=$1
shift

if [[ "$1" != "---" ]]; then
  echo "Missing end of executor parameter: $1"
  exit 1
fi
shift

source ${SRCFILE}

if ! declare -F "${COMMAND}" > /dev/null; then
  echo "${COMMAND} does not exist"
  exit 1
fi

GLBPARMS=$( cat ${ENVFILE} )
echo "task env: $( cat ${ENVFILE})"
eval ${GLBPARMS}
echo "In: ${GLBPARMS}"

RUNPARMS=$( cat ${PARAMETERSFILE} )
echo "step run params: $( cat ${PARAMETERSFILE})"
eval ${RUNPARMS}
echo "Params: ${RUNPARMS}"

pushd . >/dev/null
${COMMAND} "$@"
RETVAL=$?
popd >/dev/null

if [[ "${UPDATE_ENV}" == "1" ]]; then
  echo "Out: ${GLBPARMS}"
  echo "${GLBPARMS}" > ${ENVFILE}
fi

echo ${RETVAL} > .done
exit ${RETVAL}
