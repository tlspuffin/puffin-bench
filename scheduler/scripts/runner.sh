#!/bin/bash

sid=$( echo $( ps -p $$ -o sess= ) | xargs )
cpid=
rootpwd=$( pwd )
stepID=0
subStepID=0
scriptpwd="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
  rm "${logpath}/running/${sid}" 2>/dev/null

  if declare -F CleanupUser > /dev/null; then
    CleanupUser
  fi

  rm -f "${logpath}/.env.${sid}" 2>/dev/null

  echo "End of ${sid}"
  sleep 1
  kill -TERM -"${sid}"
  exit $1
}

cleanupSig() {
  echo "Exit message : script interrupted."
  if [ -n "${cpid}" ]; then
    echo kill -TERM ${cpid// / -}
    kill -0 ${cpid} 2> /dev/null && kill -TERM ${cpid// / -} # if more than one pid, add - to all others
    sleep 1
    kill -0 ${cpid} 2> /dev/null && sleep 9
    echo kill -KILL ${cpid// / -}
    kill -0 ${cpid} 2> /dev/null && kill -KILL ${cpid// / -}
    sleep 1
    kill -0 ${cpid} 2> /dev/null && sleep 4
    echo kill -KILL ${cpid// / -}
    kill -0 ${cpid} 2> /dev/null && kill -KILL ${cpid// / -}
  fi;
  cleanup 1
}

trap cleanupSig TERM INT

paralle_execute=0

execute() {
  taskRank=$1
  shift
  CMD="$*"
  if [ "${paralle_execute}" -eq 0 ]; then
    outfile="${logpath}/out.${sid}.${stepID}.txt"
    errfile="${logpath}/err.${sid}.${stepID}.txt"
    setsid -w ${scriptpwd}/executor.sh ${src} "${logpath}/.env.${sid}" ${sid} ${taskRank} ${CMD} > >( tee -a ${outfile} ) 2> >( tee -a ${errfile} >&2 ) &
    cpid=$!
    wait ${cpid}
    retval=$?
    kill -KILL -"${cpid}" 2>/dev/null
    cpid=
    [ "${retval}" -ne 0 ] && { echo "$* failed"; cleanup 1; };
  else
    outfile="${logpath}/out.${sid}.${stepID}.${subStepID}.txt"
    errfile="${logpath}/err.${sid}.${stepID}.${subStepID}.txt"
    setsid -w ${scriptpwd}/executor.sh ${src} "${logpath}/.env.${sid}" ${sid} ${taskRank} ${CMD} >> ${outfile} 2>> ${errfile} &
    cpid_=$!
    cpid+=" ${cpid_}"
    echo "Process ${CMD} = ${cpid_}"
  fi
}

if [ ! -r "$1" ]; then
  echo "Unable to read $1"
  cleanup 1
fi
src=$1
shift
if [ ! -d "$1" ]; then
  echo "Unable to access directory $1"
  cleanup 1
fi
logpath=$1
shift

echo "$*" > "${logpath}/running/${sid}"

source $src

touch "${logpath}/.env.${sid}"

CMDS=${EXECUTION// /§}
for STEP in ${CMDS//;/ }; do
  if [[ "${STEP}" != *'||'* ]]; then
    rm out.${sid}.${stepID}.txt err.${sid}.${stepID}.txt 2> /dev/null

    STEP=$( echo ${STEP//§/ } | xargs )
    echo "* ${STEP}  (out.${sid}.${stepID}.txt)"

    paralle_execute=0
    execute 0 ${STEP}
  else
    cpid=
    paralle_execute=1
    subStepID=0
    for PSTEP in ${STEP//||/ }; do
      rm out.${sid}.${stepID}.${subStepID}.txt err.${sid}.${stepID}.${subStepID}.txt 2> /dev/null

      PSTEP=$( echo ${PSTEP//§/ } | xargs )
      echo "| $PSTEP  (out.${sid}.${stepID}.${subStepID}.txt)"

      execute "${subStepID}" ${PSTEP}

      subStepID=$( expr ${subStepID} + 1 )
    done;
    success=
    for pid in ${cpid}; do
      wait ${pid} && success+="${pid} " || echo "Failed process ${pid}"
      kill -KILL -"${pid}" 2>/dev/null
    done
    cpid=
    [ -z "${success}" ] && cleanup 1
  fi
  stepID=$( expr ${stepID} + 1 )
  echo ""
done
cleanup 0