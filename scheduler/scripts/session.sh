#!/bin/bash

sid=$( echo $( ps -p $$ -o sess= ) | xargs )
cpid=
rootpwd=$( pwd )

cleanup() {
  cd ${rootpwd}
  rm running/${sid}
  rm -rf git.${sid}

  echo "End of ${sid}"
  kill -TERM -"${sid}"
  exit $1
}

cleanupSig() {
  echo "Exit message : script interrupted."
  if [ -n "${cpid}" ]; then
  ps -elf | grep ${cpid}
    kill -0 ${cpid} 2> /dev/null && kill -TERM -"${cpid// / -}"
    sleep 10
    kill -0 ${cpid} 2> /dev/null && { kill -KILL -"${cpid// / -}"; sleep 2; }
  fi;
  cleanup 1
}

trap cleanupSig TERM INT

commit=$1;
shift;

paralle_execute=0

execute() {
  setsid -w "$@" &
  cpid_=$!
  if [ "${paralle_execute} -eq 0" ]; then
    cpid=$cpid_
    wait ${cpid_} && cpid= || { cpid= ; echo "$* failed"; cleanup 1; };
  else
    cpid="${cpid_} ${cpid}"
    wait ${cpid_} || { echo "$* failed"; cleanup 1; };
  fi
}

echo "$*" > running/${sid}

#execute git clone https://github.com/tlspuffin/tlspuffin.git git.${sid}
execute cp -apr ../source.git git.${sid}
cd git.${sid} || { echo "cd git.${sid} failed"; cleanup 1; };  
execute git checkout $commit
execute nix-shell --run "time $*"

cleanup 0;
