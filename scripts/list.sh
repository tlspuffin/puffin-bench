#!/bin/bash

scriptpwd="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for i in $( ls -rt "${scriptpwd}/run/running" ); do
  echo "- $i"
  cat run/running/$i
done