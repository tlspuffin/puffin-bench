#!/bin/bash

if [ ! -r "$1" ]; then
  echo "Unable to read $1"
  exit 1
fi

config=$1
shift
config=$( readlink -f ${config} )

scriptpwd="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

setsid bash -c "${scriptpwd}/runner.sh ${config} ${scriptpwd}/run $* > ${scriptpwd}/run/all.\$\$.txt 2>&1 > >( tee ${scriptpwd}/run/out.\$\$.txt ) 2> >( tee ${scriptpwd}/run/err.\$\$.txt >&2 )" &
pid=$!
sleep 1

#sid=$(ps -o sess= -p "$pid" | tr -d ' ')
sid=$pid
echo "Session: $sid"
echo ""
echo "Session output:"
tail -f -c +0 ${scriptpwd}/run/all.${sid}.txt
echo ""
echo "Session: $sid"
