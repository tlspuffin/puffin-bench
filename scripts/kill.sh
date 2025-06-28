#! /bin/bash

if [ "$#" -eq "0" ]; then
  echo "Usage $0"
  exit 1
fi

mpid=$( ps --ppid $1 -o pid= | xargs )
if [ -n "${mpid}" ]; then
  kill -0 "${mpid}" 2> /dev/null && kill -TERM "${mpid}"
  sleep 14;
fi
kill -0 "$1" 2> /dev/null && kill -TERM -"$1" || exit 1
sleep 14;
kill -0 "$1" 2> /dev/null && kill -KILL -"$1" || exit 1