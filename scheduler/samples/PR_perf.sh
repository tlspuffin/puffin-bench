Experiment () {
  local tlspuffin_pid=0;
  local tlspuffin_killed=0;
  local stats="";
  ExperimentRun tlspuffin_pid tlspuffin_killed stats "${@}" || return 1;

  (( tlspuffin_killed == 0 )) && ExperimentCheckRun && tlspuffin_killed=1;

  wait "${tlspuffin_pid}" 2>/dev/null
  local status=$?

  ExperimentEnd

  (( tlspuffin_killed == 1 )) && return 1 || return ${status}
}

ExperimentWithCargo () {
  local tlspuffin_pid=0;
  local tlspuffin_killed=0;
  local stats="";
  ExperimentRunWithCargo tlspuffin_pid tlspuffin_killed stats "${@}" || return 1;

  (( tlspuffin_killed == 0 )) && ExperimentCheckRun && tlspuffin_killed=1;

  wait "${tlspuffin_pid}" 2>/dev/null
  local status=$?

  ExperimentEnd

  (( tlspuffin_killed == 1 )) && return 1;
  return ${status}
}

SummaryRun () {
  if [ -z "${features}" ]; then
    echo "Missing required global variable: features"
    return 1
  fi
  [ -z "${COMMIT_ID}" ] && COMMIT_ID="main"

  local json='{ "type": "perf", "libraries": [ ';
  local firstlib=1;
  while read -r libresults; do
    local lib=${libresults#"$THEJOB_ARTEFACTS_PATH"/}
    if (( ! firstlib )); then
      json+=","
    fi
    firstlib=0
    json+=" { \"${lib}\": [ ";
    local firstRun=1;
    while read -r i; do
      local idRun=$( echo "${i}" | sed 's:.*/\([0-9][0-9]*\)-stats.json$:\1:' )
      local startGlobalInfos=$( head -c 1M "${i}" | sed 's/}{/}\n{/g' | grep '{"type":"global"' | head -1 );
      local startTime=$( echo "${startGlobalInfos}" | sed 's/.*"secs_since_epoch":\([0-9][0-9]*\),.*/\1/' );
      local endGlobalInfos=$( tail -c 1M "${i}" | sed 's/}{/}\n{/g' | grep '{"type":"global".*}$' | tail -1 );
      local endTime=$( echo "${endGlobalInfos}" | sed 's/.*"secs_since_epoch":\([0-9][0-9]*\),.*/\1/' );
      local runTime=$(( endTime - startTime ));

      local corpus=$( echo "${endGlobalInfos}" | sed -n 's/.*"corpus_size":\([0-9][0-9]*\),.*/\1/p' )
      [ -z "${corpus}" ] && corpus='null';
      local execs=$( echo "${endGlobalInfos}" | sed -n 's/.*"total_execs":\([0-9][0-9]*\),.*/\1/p' )
      [ -z "${execs}" ] && execs='null';
      local nbClients=$( echo "${endGlobalInfos}" | sed -n 's/.*"clients":\([0-9][0-9]*\),.*/\1/p' )
      [ -z "${nbClients}" ] && nbClients=0;

      local hit=0
      local hitCount=0
      local endClientsInfos=$( tail -c 1M "${i}" | sed 's/}{/}\n{/g' | grep '{"type":"client".*}$' );
      for (( client=1; client<=nbClients; client++ )); do
        local endClientInfos=$( echo "${endClientsInfos}" | grep "\"id\":${client}"  | tail -1 );
        local clientCoverage=$( echo "${endClientInfos}" | sed -n 's/.*"coverage":{\([^}]*\)}.*/\1/p' );
        local clientHit=$( echo "${clientCoverage}" | sed -n 's/.*"discovered":\([0-9][0-9]*\),.*/\1/p' );
        [ -z "${clientHit}" ] && clientHit=$( echo "${clientCoverage}" | sed -n 's/.*"hit":\([0-9][0-9]*\),.*/\1/p' );

        [ -n "${clientHit}" ] && {
          (( ++hitCount ));
          hit=$(( hit + clientHit ));
        }
      done
      (( hitCount > 0)) && hit=$(( hit / hitCount )) || hit='"NA"';

      if (( ! firstRun )); then
        json+=","
      fi
      firstRun=0;
      json+=" { \"${idRun}\": { \"duration\": ${runTime} }, \"corpus_size\": ${corpus}, \"total_execs\": ${execs}, \"coverage\": ${hit} }";

    done < <(find "${libresults}" -name "*.json" | sort -n)
    json+=" ] }";
  done < <(find "${THEJOB_ARTEFACTS_PATH}"  -maxdepth 1 -mindepth 1 -type d | sort -n)
  json+=" ] }";
  echo "${json}" > summary.json;
  CreateArtefact "./summary.json" "summary.json" "commit_id:${COMMIT_ID}" "features:${features}"
  return 0;
}
