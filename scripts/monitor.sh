#!/bin/bash

scriptpwd="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

file=$2
if [ -z "$file" ]; then
  file=all
fi

tail -f -c +0 "${scriptpwd}/run/${file}.$1.txt"
