#!/bin/bash

QUIET=0
while [[ "$1" == -* ]]; do
  case "$1" in
    -q) QUIET=1; shift ;;
    *) break ;;
  esac
done

CACHE_ID="$1"
TIMEOUT="${2:-0}"
SERVER_URL="http://localhost:8080/api/cache"
DELAY=1
if [ -z "$CACHE_ID" ]; then
  echo "Usage: $0 <cache_id> [timeout_seconds]"
  exit 1
fi

[[ "$QUIET" -eq 0 ]] && echo "Waiting file '$CACHE_ID' to be ready in cache..."

START_TIME=$(date +%s)

while true; do
  RESPONSE=$(curl -s -X GET "$SERVER_URL/$CACHE_ID")

  SUCCESS=$(echo "$RESPONSE" | jq -r '.success')
  ERROR=$(echo "$RESPONSE" | jq -r '.error')
  STATE=$(echo "$RESPONSE" | jq -r '.state')
  PATH_VAL=$(echo "$RESPONSE" | jq -r '.path // empty')

  [[ "$QUIET" -eq 0 ]] && echo "Got: success=$SUCCESS, state=$STATE, error='$ERROR', path=$PATH_VAL"

  if [[ "$STATE" == "Ok" ]]; then
    [[ "$QUIET" -eq 0 ]] && echo "File ready: $PATH_VAL" || echo ${PATH_VAL}
    break
  elif [[ "$STATE" == "Locked" ]]; then
    [[ "$QUIET" -eq 0 ]] && echo "File locked, new try in $DELAY s..."
  elif [[ "$STATE" == "Not Available" ]]; then
    [[ "$QUIET" -eq 0 ]] && echo "File unavailable (Not Available). Aborting."
    exit 2
  else
    [[ "$QUIET" -eq 0 ]] && echo "Unknown state or invalid response. Raw response: $RESPONSE"
    exit 3
  fi

  if [[ "$TIMEOUT" -gt 0 ]]; then
    NOW=$(date +%s)
    ELAPSED=$((NOW - START_TIME))
    if [[ "$ELAPSED" -ge "$TIMEOUT" ]]; then
      [[ "$QUIET" -eq 0 ]] && echo "Timeout reached after $ELAPSED seconds. Aborting."
      exit 4
    fi
  fi

  sleep "$DELAY"
done
