Experiment () {
  local tlspuffin_pid=0;
  local tlspuffin_killed=0;
  local stats="";
  ExperimentRun tlspuffin_pid tlspuffin_killed stats 1 "${@}" || return 1;

  local status=1
  (( tlspuffin_killed == 0 )) && {
    status=$( ExperimentCheckRun "${tlspuffin_pid}" "${stats}" )
  }

  ExperimentEnd

  return ${status}
}

ExperimentWithCargo () {
  local tlspuffin_pid=0;
  local tlspuffin_killed=0;
  local stats="";
  ExperimentRunWithCargo tlspuffin_pid tlspuffin_killed stats 1 "${@}" || return 1;

  local status=1
  (( tlspuffin_killed == 0 )) && {
    status=$( ExperimentCheckRun "${tlspuffin_pid}" "${stats}" )
  }

  ExperimentEnd

  return ${status}
}

SummaryRun () {
  [ -z "${COMMIT_ID}" ] && COMMIT_ID="main"

  local json='{ "type": "perf", "libraries": [ ';
  local firstlib=1;
  while read -r libresults; do
    local lib=${libresults#"$THEJOB_ARTEFACTS_PATH"/}
    if (( ! firstlib )); then
      json+=","
    fi
    firstlib=0
    json+=" { \"name\": \"${lib}\", \"data\": [ ";
    local firstRun=1;
    while read -r i; do
      local idRun=$( echo "${i}" | sed 's:.*/\([0-9][0-9]*\)-stats.json$:\1:' )

      local startInfos=$( head -c 1M "${i}" | sed 's/}{/}\n{/g' | head -1 );
      local startTime=$( echo "${startInfos}" | jq -r '.time.secs_since_epoch' );
      local endInfos=$( tail -c 1M "${i}" | sed 's/}{/}\n{/g' | tail -1 );
      echo "${endInfos}" | jq >/dev/null 2>&1 || endInfos=$( tail -c 1M "${i}" | sed 's/}{/}\n{/g' | tail -2 | head -1 );
      local endTime=$( echo "${endInfos}" | jq -r '.time.secs_since_epoch' );
      local runTime=$(( endTime - startTime ));

      local endGlobalInfos=$( tail -c 1M "${i}" | sed 's/}{/}\n{/g' | grep '{"type":"global".*}$' | tail -1 );
      echo "${endGlobalInfos}" | jq >/dev/null 2>&1 || endGlobalInfos=$( tail -c 1M "${i}" | sed 's/}{/}\n{/g' | grep '{"type":"global".*}$' | tail -2 | head -1 );

      local corpus=$( echo "${endGlobalInfos}" | jq -r '.corpus_size' )
      [ -z "${corpus}" ] && corpus='null';
      local execs=$( echo "${endGlobalInfos}" | jq -r '.total_execs' )
      [ -z "${execs}" ] && execs='null';
      local nbClients=$( echo "${endGlobalInfos}" | jq -r '.clients' )
      [ -z "${nbClients}" ] && nbClients=0;
      local objectiveSize=$( echo "${endGlobalInfos}" | jq -r '.objective_size' )
      [ -z "${objectiveSize}" ] && objectiveSize=0;

      local hit=0
      local hitCount=0
      local avgDuration=0
      local endClientsInfos=$( tail -c 1M "${i}" | sed 's/}{/}\n{/g' | grep '{"type":"client".*}$' );
      for (( client=1; client<nbClients; ++client )); do

        local startClientInfos=$( head -c 2M "${i}" | sed 's/}{/}\n{/g' | grep "\"id\":${client}" | head -1 );
        local clientStartTime=$( echo "$startClientInfos" | jq -r '.time.secs_since_epoch' )

        local endClientInfos=$( echo "${endClientsInfos}" | grep "\"id\":${client}" | tail -1 );
        echo "${endClientInfos}" | jq  >/dev/null 2>&1 || endClientInfos=$( echo "${endClientsInfos}" | grep "\"id\":${client}" | tail -2 | head -1 );

        local clientHit;
        clientHit=$( echo "$endClientInfos" | jq -e -r '.coverage.hit' ) || clientHit=$(echo "$endClientInfos" | jq -r '.coverage.discovered' )

        [ -n "${clientHit}" ] && {
          (( ++hitCount ));
          hit=$(( hit + clientHit ));
        }

        local clientEndTime=$( echo "$endClientInfos" | jq -r '.time.secs_since_epoch' )
        local clientDuration=;
        [ -n "${clientStartTime}" ] && [ -n "${clientEndTime}" ] && clientDuration=$(( clientEndTime - clientStartTime  ))
        [ -n "${clientDuration}" ] && {
          (( avgDuration += clientDuration ));
        }
      done
      (( hitCount > 0)) && hit=$(( hit / hitCount )) || hit='"NA"';
      (( nbDuration > 0)) && avgDuration=$(( avgDuration / ( nbClients - 1 ) )) || avgDuration='"NA"';

      if (( ! firstRun )); then
        json+=","
      fi
      firstRun=0;
      json+=" { \"id\": \"${idRun}\", \"duration\": ${runTime}, \"corpus_size\": ${corpus}, \"total_execs\": ${execs}, \"coverage\": ${hit}, \"objective_size\": ${objectiveSize},  \"client_average_duration_s\": ${avgDuration} }";

    done < <(find "${libresults}" -name "*.json" | sort -n)
    json+=" ] }";
  done < <(find "${THEJOB_ARTEFACTS_PATH}"  -maxdepth 1 -mindepth 1 -type d | sort -n)
  json+=" ] }";
  echo "${json}" > summary.json;
  CreateArtefact "./summary.json" "summary.json" "commit_id:${COMMIT_ID}"
  return 0;
}
