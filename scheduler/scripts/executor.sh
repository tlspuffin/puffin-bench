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

AbortFail() {
  "$@" || ( echo "Fail: $*"; false )
}

if [ ! -r "$1" ]; then
  echo "Unable to read $1"
  exit 1
fi
SRCFILE=$1
shift

if [ ! -r "$1" ]; then
  #echo "Unable to read env $1"
  #exit 1
  touch $1
fi
ENVFILE=$1
shift

if [ ! -w "$1" ]; then
  echo "Output directory is not writable: $1"
  exit 1
fi
OUTPATH=$1
shift

if [ -z "$1" ]; then
  echo "Missing sid"
  exit 1
fi
sid=$1
shift

if [ -z "$1" ]; then
  echo "Missing rank id"
  exit 1
fi
rankid=$1
shift

if [ -z "$1" ]; then
  echo "Missing function name"
  exit 1
fi
COMMAND=$1
shift

source ${SRCFILE}

if ! declare -F "${COMMAND}" > /dev/null; then
  echo "${COMMAND} does not exist"
  exit 1
fi

GLBPARMS=$( cat ${ENVFILE} )
echo "task env: $( cat ${ENVFILE})"
eval ${GLBPARMS}

${COMMAND} "$@"
RETVAL=$?

echo "${GLBPARMS}" > ${ENVFILE}

exit ${RETVAL}
