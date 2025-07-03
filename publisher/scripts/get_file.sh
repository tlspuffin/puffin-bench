#!/bin/bash

CACHE_ID="$1"
TIMEOUT="${2:-0}"
SERVER_URL="http://localhost:8080/cache_get"
DELAY=1
if [ -z "$CACHE_ID" ]; then
  echo "Usage: $0 <cache_id> [timeout_seconds]"
  exit 1
fi

echo "Waiting file '$CACHE_ID' to be ready in cache..."

while true; do
  RESPONSE=$(curl -s -X POST "$SERVER_URL" -F "id=$CACHE_ID")

  SUCCESS=$(echo "$RESPONSE" | jq -r '.success')
  ERROR=$(echo "$RESPONSE" | jq -r '.error')
  STATE=$(echo "$RESPONSE" | jq -r '.state')
  PATH_VAL=$(echo "$RESPONSE" | jq -r '.path // empty')

  echo "Got: success=$SUCCESS, state=$STATE, error='$ERROR', path=$PATH_VAL"

  if [[ "$STATE" == "Ok" ]]; then
    echo "File ready: $PATH_VAL"
    break
  elif [[ "$STATE" == "Locked" ]]; then
    echo "File locked, new try in $DELAY s..."
  elif [[ "$STATE" == "Not Available" ]]; then
    echo "File unavailable (Not Available). Aborting."
    exit 2
  else
    echo "Unknown state or invalid response. Raw response: $RESPONSE"
    exit 3
  fi

  if [[ "$TIMEOUT" -gt 0 ]]; then
    NOW=$(date +%s)
    ELAPSED=$((NOW - START_TIME))
    if [[ "$ELAPSED" -ge "$TIMEOUT" ]]; then
      echo "⏱️ Timeout reached after $ELAPSED seconds. Aborting."
      exit 4
    fi
  fi

  sleep "$DELAY"
done
