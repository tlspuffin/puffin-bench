#! /bin/bash

if [ ! -f "$1" ]; then
  echo "Required module file is missing"
  exit 1
fi
MODULE="$1";
shift;

if [ -z "$1" ]; then
  echo "Required entry point is missing"
  exit 1
fi
ENTRYPOINT="$1";
shift;

if [ -z "$1" ]; then
  echo "Required output file name is missing"
  exit 1
fi
OUTPUT="$1";
OUTPUT_TMP="${1}.tmp"
if [ -f "${OUTPUT_TMP}" ]; then
  rm "${OUTPUT_TMP}"
fi
shift;

source ${MODULE}

if ! declare -F "${ENTRYPOINT}" > /dev/null; then
  echo "entrypoint \(${ENTRYPOINT}\) does not exist"
  exit 1
fi

${ENTRYPOINT} "${OUTPUT_TMP}"

[ -f "${OUTPUT_TMP}" ] && mv "${OUTPUT_TMP}" "${OUTPUT}" || rm "${OUTPUT}"
exit $( [ -f "${OUTPUT}" ] && 0 || 1 )