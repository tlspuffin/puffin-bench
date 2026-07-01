Experiment () {
  local tlspuffin_pid=0;
  local tlspuffin_killed=0;
  local stats="";
  ExperimentRun tlspuffin_pid tlspuffin_killed stats 1 "${@}" || return 1;

  local status=1
  (( tlspuffin_killed == 0 )) && {
    status=$( ExperimentCheckRun "${tlspuffin_pid}" "${stats}" )
  }

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

  return ${status}
}

SummaryRun () {
  [ -z "${COMMIT_ID}" ] && COMMIT_ID="main"

  local flagObjective='false';
  local json='{ "type": "perf", "libraries": [ ';
  local firstlib=1;
  while read -r libresults; do
    local lib=${libresults#"$THEJOB_ARTEFACTS_PATH"/}
    if (( ! firstlib )); then
      json+=","
    fi
    firstlib=0

    local cli_json='null'
    local trust_objective=1
    [ -s "${THEJOB_OUT_PATH}/cli-${lib}.json" ] && {
      cli_json=$( cat "${THEJOB_OUT_PATH}/cli-${lib}.json" );
      trust_objective=$( echo "${cli_json}" | 
          jq 'if .library.name == "wolfssl" then if ((.library.version | tonumber?) // 541) > 540 then 1 else -1 end else 1 end' );
    }

    json+=" { \"name\": \"${lib}\", \"cli\": ${cli_json}, \"trust_objective\": ${trust_objective}, \"data\": [ ";
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
      if [ -z "${objectiveSize}" ]; then
        objectiveSize=0;
      elif (( trust_objective == 1 && objectiveSize > 0 )); then
        flagObjective='true'
      fi

      if [ -n "$( head -c 1M "${i}" | sed 's/}{/}\n{/g' | jq -c --argjson n "${nbClients}" 'select(.id == $n)' 2>/dev/null | head -1 )" ] \
          || [ -n "$( tail -c 1M "${i}" | sed 's/}{/}\n{/g' | jq -c --argjson n "${nbClients}" 'select(.id == $n)' 2>/dev/null | head -1 )" ]; then
        (( ++nbClients ))
      fi

      local coverages=''
      local nbDuration=0
      local avgDuration=0
      local endClientsInfos=$( tail -c 1M "${i}" | sed 's/}{/}\n{/g' | grep '{"type":"client".*}$' );
      for (( client=1; client<nbClients; ++client )); do

        local startClientInfos=$( head -c 2M "${i}" | sed 's/}{/}\n{/g' | grep "\"id\":${client}" | head -1 );
        local clientStartTime=$( echo "$startClientInfos" | jq -r '.time.secs_since_epoch' )

        local endClientInfos=$( echo "${endClientsInfos}" | grep "\"id\":${client}" | tail -1 );
        echo "${endClientInfos}" | jq  >/dev/null 2>&1 || endClientInfos=$( echo "${endClientsInfos}" | grep "\"id\":${client}" | tail -2 | head -1 );

        local clientCovHit=''
        clientCovHit=$( echo "$endClientInfos" | jq -e -r '.coverage.hit // .coverage.discovered // empty' ) || clientCovHit='';
        local clientCovMax=''
        clientCovMax=$( echo "$endClientInfos" | jq -e -r '.coverage.max // empty' ) || clientCovMax='';
        local clientCoverage=0

        [ -n "${clientCovHit}" ] && {
          [ -n "${clientCovMax}" ] && {
            clientCoverage=$( echo "scale=8; ( ${clientCovHit} / ${clientCovMax} ) * 100" | bc | LC_ALL=C xargs printf "%.6f\n" )
            [ -n "${coverages}" ] && coverages+=","
            coverages+="${clientCoverage}"
          }
        }

        local clientEndTime=$( echo "$endClientInfos" | jq -r '.time.secs_since_epoch' )
        local clientDuration=;
        [ -n "${clientStartTime}" ] && [ -n "${clientEndTime}" ] && clientDuration=$(( clientEndTime - clientStartTime  ))
        [ -n "${clientDuration}" ] && {
          (( avgDuration += clientDuration ));
          (( ++nbDuration ));
        }
      done
      [ -z "${coverages}" ] && coverages=''
      (( nbDuration > 0)) && avgDuration=$(( avgDuration / nbDuration )) || avgDuration='"NA"';

      if (( ! firstRun )); then
        json+=","
      fi
      firstRun=0;
      json+=" { \"id\": \"${idRun}\", \"duration\": ${runTime}, \"corpus_size\": ${corpus}, \"total_execs\": ${execs}, \"coverage\": [ ${coverages} ], \"objective_size\": ${objectiveSize}, \"client_average_duration_s\": ${avgDuration} }";

    done < <(find "${libresults}" -name "*.json" | sort -V)
    json+=" ] }";
  done < <(find "${THEJOB_ARTEFACTS_PATH}"  -maxdepth 1 -mindepth 1 -type d | sort -V)
  json+=" ], \"flag_objective\": ${flagObjective} }";
  echo "${json}" > summary.json;
  CreateArtefact "./summary.json" "summary.json" "commit_id:${COMMIT_ID}"
  if [ "${flagObjective}" == 'true' ]; then
    Flag '{"color": "#6f6f00"}';
  fi
  return 0;
}
