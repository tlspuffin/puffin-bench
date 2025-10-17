Init () {
  [ -z "${COMMIT_ID}" ] && COMMIT_ID="main"

  git clone https://github.com/tlspuffin/tlspuffin.git "${THEJOB_OUT_PATH}/repo" || return 1;

  cd "${THEJOB_OUT_PATH}/repo" || return 1;

  git checkout "${COMMIT_ID}" || return 1;

  if [ -z "${PREFIX_FAKETIME}" ]; then
#    local TLSPUFFIN_RUN_PREFIX="env FAKETIME='2022-12-24 00:00:00' \
#env LD_PRELOAD='/nix/store/vvflx70q27229r0glx2ld1ciw40rr11n-clang-wrapper-14.0.6/resource-root/lib/linux/libclang_rt.asan-x86_64.so:/nix/store/kwp6bhp67i63xpcn1xrrdrnq9ilr707l-libfaketime-0.9.10/lib/libfaketimeMT.so.1:/nix/store/kwp6bhp67i63xpcn1xrrdrnq9ilr707l-libfaketime-0.9.10/lib/libfaketime.so.1'\
#"
#    git merge-base --is-ancestor "${COMMIT_ID}" 8b29ce76d && PREFIX_FAKETIME="${TLSPUFFIN_RUN_PREFIX}" || PREFIX_FAKETIME=""
    git merge-base --is-ancestor "${COMMIT_ID}" 8b29ce76d && PREFIX_FAKETIME="faketime 2022-12-24" || PREFIX_FAKETIME=""
    AddGlobalParam PREFIX_FAKETIME "${PREFIX_FAKETIME}"
  fi

  sed -i 's$\(.*url = \)git@github.com:tlspuffin$\1https://github.com/tlspuffin$' .gitmodules 
  git submodule update --init --recursive || return 1;

  if [ ! -e "shell.nix" ]; then
    cp "${THEJOB_USER_FILES_PATH}/shell.nix" . || return 1;
  else
    sed -i 's${ pkgs ? import <nixpkgs> { } }:${ pkgs ? import (fetchTarball "https://github.com/NixOS/nixpkgs/archive/nixos-22.11.tar.gz") {} }:$' shell.nix
  fi

  if [ ! -z "${prefix_faketime}" ]; then
    sed -i 's/\(.*nativeBuildInputs = \[.*\)/\1\n    pkgs.libfaketime/' shell.nix || return 1
  fi

  nix-shell --run cargo >/dev/null 2>/dev/null || return 1;

  return 0;
}

ComputeBuildRuntimeInfo() {
  if [ ! -e "${THEJOB_OUT_PATH}/repo/tlspuffin/Cargo.toml" ]; then
    echo "Missing required file ${THEJOB_OUT_PATH}/repo/tlspuffin/Cargo.toml"
    return 1;
  fi

  local vendor=$1;
  shift;
  if [ -z "$1" ]; then
    echo "Missing features parameter"
    return 1;
  fi
  declare -n features=$1;

  shift;
  if [ -z "$1" ]; then
    echo "Missing cputs parameter"
    return 1;
  fi
  declare -n cputs=$1;
  shift;

  cputs=false;

  if [ -n "${vendor}" ] && [ -e "./tools/mk_vendor" ]; then
    local version=$( echo "${vendor}" | cut -f 2 -d ':' )
    local library=$( echo "${vendor}" | cut -f 1 -d ':' )
    if [ -e "${THEJOB_OUT_PATH}/repo/puffin-build/vendors/${library}/presets.toml" ]; then
      grep -F -q "[${version}]" "${THEJOB_OUT_PATH}/repo/puffin-build/vendors/${library}/presets.toml" && 
          grep -E -q "^[[:space:]]*cputs[[:space:]]*=" "${THEJOB_OUT_PATH}/repo/tlspuffin/Cargo.toml" && {
            cputs=true;
            features='cputs';
          }
    fi
  fi
  if ! ${cputs}; then
    for i in $( echo "${features}" | sed 's/\([^,]\)[,$]/\1\n/g' ); do
      grep -E -q "^[[:space:]]*${i}[[:space:]]*=" "${THEJOB_OUT_PATH}/repo/tlspuffin/Cargo.toml" || {
        echo "Unsupported feature $i";
        return 1;
      }
    done
  fi

  return 0;
}

Build() {
  local cputs=false
  ComputeBuildRuntimeInfo "${vendor}" feature cputs || {
      echo "Failed to compute runtime info for vendor '${vendor}' '${features}'"
      return 1;
  }

  [ -z "${COMMIT_ID}" ] && COMMIT_ID="main"
  md5sum_res=$( echo "tlspuffin-${COMMIT_ID}-${features}-${vendor}" | md5sum )
  cache_id="tlspuffin-${md5sum_res%% *}"
  echo "tlspuffin-${COMMIT_ID}-${features}-${vendor} = ${cache_id}"
  cache_ok=1
  if [[ "${COMMIT_ID}" != "main" ]]; then
    binary=$( QueryCache -q "${cache_id}" )
    cache_ok=$?
  fi
  if [[ $cache_ok -ne 0 ]]; then
    cp -apr "${THEJOB_OUT_PATH}/repo" . || return 1;
    cd repo || return 1;
    if [ ! -e "shell.nix" ]; then
      cp "${THEJOB_USER_FILES_PATH}/shell.nix" . || return 1
    fi
    if ${cputs}; then
      nix-shell --run "./tools/mk_vendor make '${vendor}'"
    fi
    nix-shell --run "cargo build --bin tlspuffin --release --features=${features}" || return 1
    binary=$( realpath ./target/release/tlspuffin )
    SetCache "${cache_id}" "${binary}"
  else
    echo "Found in cache"
  fi
  cp "${binary}" "${THEJOB_OUT_PATH}/tlspuffin-${THEJOB_STEP_ID}" || return 1;

  return 0
}

Experiment () {
  [ -z "${COMMIT_ID}" ] && COMMIT_ID="main"
  [ -z "${PREFIX_FAKETIME}" ] && PREFIX_FAKETIME="" || echo "Using faketime"
  binary="${THEJOB_OUT_PATH}/tlspuffin-${THEJOB_STEP_ID}"
  last_core=$(( THEJOB_NB_CORES - 1 ))

  if [ -x "{binary"} ]; then
    echo "No binary found ${binary}, skipping run"
    return 1
  fi

  ipcrm --all

  if [ ! -e "shell.nix" ]; then
    cp "${THEJOB_USER_FILES_PATH}/shell.nix" . || return 1
  fi

  nix-shell --run "\"${binary}\" seed" || return 1;

  # disable this if preload is set to load asan and faketime
  [ ! -z "${PREFIX_FAKETIME}" ] && echo "${features}" | grep -qi asan && PREFIX_FAKETIME="" && echo "Disable faketime, asan used"

  eval $( ${THEJOB_TOOLS_PATH}/reserve_port ) || return 1; # reserve a tcp port on if 127.0.0.1 (RESERVED_PORT, RESERVED_PORT_PID)
  nix-shell --run "exec ${PREFIX_FAKETIME} \"${binary}\" --cores 0-${last_core} --port ${RESERVED_PORT} ${extra_flags} experiment -d \"${experiment}\" -t \"${experiment}\"" &
  local tlspuffin_pid=$!

  sleep 10
  kill -0 ${tlspuffin_pid} 2>/dev/null
  if (( $? == 0 )); then
    tlspuffin_outpath=$( ls experiments/ )
    CreateArtefact "./experiments/${tlspuffin_outpath}/README.md" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-README.md" "commit_id:${COMMIT_ID}" "features:${features}"
    if [ -e "./experiments/${tlspuffin_outpath}/stats.json" ]; then
      CreateArtefact "./experiments/${tlspuffin_outpath}/stats.json" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-stats.json" "commit_id:${COMMIT_ID}" "features:${features}"
      CreateArtefact "./experiments/${tlspuffin_outpath}/tlspuffin.log" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-tlspuffin.log" "commit_id:${COMMIT_ID}" "features:${features}"
    else
      CreateArtefact "./experiments/${tlspuffin_outpath}/log/stats.json" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-stats.json" "commit_id:${COMMIT_ID}" "features:${features}"
      CreateArtefact "./experiments/${tlspuffin_outpath}/log/tlspuffin.log" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-tlspuffin.log" "commit_id:${COMMIT_ID}" "features:${features}"
    fi
  fi

  StartMonitor ${tlspuffin_pid}

  wait "${tlspuffin_pid}" 2>/dev/null
  local status=$?

  kill ${RESERVED_PORT_PID}

  ipcrm --all

  return ${status}
}

CheckObjectif () {
  outfile="$1";
  if [ -z "${outfile}" ]; then
    echo "Missing outfile"
    return 1;
  fi
  shift;
  tlspuffin_pid=$1;
  if [ -z "${tlspuffin_pid}" ]; then
    echo "Missing PID arg" > ${outfile}
    return 1;
  fi
  shift

  now=$(date +%s)

  TLSPUFFIN_OUTPATH=$( ls experiments/ )
  exp="./experiments/${TLSPUFFIN_OUTPATH}"

  old_tlspuffin=false
  README="$exp/README.md"
  stats_file="$exp/log/stats.json"
  # if stat_file does not exists then look for the file at $exp/stats.json (as in older versions of puffin)
  if [ ! -f "$stats_file" ]; then
    stats_file="$exp/stats.json"
    old_tlspuffin=true
  fi
  if [ -f "$stats_file" ]; then
    # Last modified time in epoch seconds
    mod_time=$(stat -c %Y "$stats_file")
    elapsed=$((now - mod_time))

    exp_name=$(basename "$exp")
    echo -n "# Experiment: $exp_name" >> ${outfile}
    if [ -f "$README" ]; then
      port=$(head -n 100 "$README" | grep "Port:" | cut -d' ' -f2-)
      echo -n "  ${port}" >> ${outfile}
    fi
    echo -e "\n  Time since last stats.json update: ${elapsed}s" >> ${outfile}

    if [ ! ${old_tlspuffin} ]; then
      # Default PUT info from log
      log_file="$exp/log/stats_puffin_main_broker.log"
      if [ -f "$log_file" ]; then
        default_put=$(head -n 100 "$log_file" | grep "Default PUT:" | head -n1 | sed 's/^[ \t]*//' | cut -d' ' -f2-)
        if [ -n "$default_put" ]; then
          echo "  $default_put" >> ${outfile}
        else
          if [ -f "$README" ]; then
            default_put=$(head -n 100 "$README" | grep "Default PUT:" | cut -d' ' -f2-)
            echo "  ${default_put} (asan?)" >> ${outfile}
          else
            echo "   Could not find default PUT in README or ./log/stats_puffin_main_broker.log" >> ${outfile}
          fi
        fi
      else
        echo "  Log file not found: $log_file" >> ${outfile}
      fi
    fi

    # Corpus info
    corpus_dir="$exp/corpus"
    if [ -d "$corpus_dir" ]; then
      corpus_count=$(find "$corpus_dir" -type f -name "*.trace" | wc -l)
      last_corpus=$(find "$corpus_dir" -type f -name "*.trace" -printf "%T@ %Tc\n" | sort -nr | head -n1 | cut -d' ' -f2-)
      last_corpus_time=$(find "$corpus_dir" -type f -name "*.trace" -printf "%T@\n" | sort -nr | head -n1 | cut -d. -f1)
      now=$(date +%s)
      last_corpus_elapsed=$(( (now - last_corpus_time) / 60 ))
      echo "  Corpus: $corpus_count file(s), last modified: $last_corpus_elapsed minutes ago - $last_corpus" >> ${outfile}
    else
      echo "  Corpus: Directory not found" >> ${outfile}
    fi

    # Error log
    if [ ! ${old_tlspuffin} ]; then
      log_file="$exp/log/error.log"
      if [ -f "$log_file" ]; then
        if [ -s "$log_file" ]; then
          echo -n "   --> ❌ Errors while fuzzing: " >> ${outfile}
          nb_errors=$(grep -c ERROR "$log_file")
          echo -n "${nb_errors} errors, " >> ${outfile}
          nb_crashes=$(grep -c CRASH "$log_file")
          echo "${nb_crashes} crashes" >> ${outfile}
          last_lines=$(grep ERROR "$log_file" | grep "\[" | tail -n 1  | cut -c1-180)
          if [ -n "$last_lines" ]; then
            echo "  $last_lines" >> ${outfile}
          fi
        else
          echo "    No error ✅" >> ${outfile}
        fi
      else
        echo "  Log file not found: $log_file" >> ${outfile}
      fi
    fi

    # Objective info
    objective_dir="$exp/objective"
    if [ -d "$objective_dir" ]; then
      objective_count=$(find "$objective_dir" -type f -name "*.trace" | wc -l)
      last_objective=$(find "$objective_dir" -type f -name "*.trace" -printf "%T@ %Tc %p\n" | sort -nr | head -n1 | cut -d' ' -f2-)
      last_objective_time=$(find "$objective_dir" -type f -name "*.trace" -printf "%T@\n" | sort -nr | head -n1 | cut -d. -f1)
      now=$(date +%s)
      last_objective_elapsed=$(( (now - last_objective_time) / 60 ))
      # Display the following if obejctive_count is greater than 0
      if [ "$objective_count" -gt 0 ]; then
        echo "    ==> 🎉 Objective: $objective_count file(s), last modified: $last_objective_elapsed minutes ago - $last_objective" >> ${outfile}
      else
        echo "    No objective yet ✓" >> ${outfile}
      fi
    else
      echo "  Objective: Directory not found" >> ${outfile}
    fi
    echo "" >> ${outfile}
  fi
}

ManageResults () {
  echo "${vulnerabilities}"
  python_storage="/local-unsafe/demengeo"
  if [[ ! -d "${python_storage}/puffin-bench.venv" ]]; then
    python3 -m venv "${python_storage}/puffin-bench.venv"
    source "${python_storage}/puffin-bench.venv/bin/activate"
    python3 -m pip install -r ${script}/requirements.txt
  else
    source "${python_storage}/puffin-bench.venv/bin/activate"
  fi
  python3 ${script}/cli.py generate --commit "${COMMIT_ID}" "${THEJOB_ARTEFACTS_PATH}" out.csv
  python3 ${script}/cli.py report --outdir out out.csv
  CreateArtefact "./out/report" "report" "commit_id:${COMMIT_ID}"
  return 0
}

