#### COMPAT RULES START ####
#
# Commit-dependent rules keeping results comparable across the tlspuffin history.
#
# Each rule has:
#   - a probe, CompatProbe_<id>, run against the checked-out sources: it decides whether the
#     rule applies (so side-branch commits outside the declared range are handled too);
#   - a declared range [start, end) in COMPAT_RANGE: documents the intent, is used by the
#     self-test (tests/compat_selftest.sh), and makes the task fail when a commit inside the
#     range does not match the probe (never run an unfair experiment silently).
#     An end "-" means the range is still open (not fixed on dev yet): only the probe decides.
#
# A rule can be disabled with the task argument COMPAT_DISABLE (comma separated ids, or "all").

COMPAT_RULES=( wo_bit wo_trunc log_config )

declare -A COMPAT_RANGE=(
  # bit-level mutations enabled by default (opt-out --wo-bit); opt-in --with-bit from e13983d
  [wo_bit]="47c97cd7ac2cdad73cd9c9b1753b69f857298c89 e13983d6a6e186cde04fffeb12914f06b4ff9b68"
  # failed trace steps truncation enabled by default (opt-out --wo-trunc); opt-in --with-trunc from 24f7f10c2
  [wo_trunc]="2ed7077aa2a3b937dcbb18d5fc80797bc43f0337 24f7f10c2425fafcddd5a6358d147e5d49487a08"
  # fuzzing clients load a debug-level client_log_config.yml; experiments ignore it from e13983d
  [log_config]="60b3f3185edd8dc6515c578e6321bf7a6f00fc2b e13983d6a6e186cde04fffeb12914f06b4ff9b68"
)

# fuzzer flags added by the rules
declare -A COMPAT_FLAG=(
  [wo_bit]="--wo-bit"
  [wo_trunc]="--wo-trunc"
)


# reference client_log_config.yml (identical to the current dev version)
COMPAT_LOG_CONFIG_REF="e13983d6a6e186cde04fffeb12914f06b4ff9b68"
COMPAT_LOG_CONFIG_BLOB="fb844b8b74f5089b02ca66669662e85689247514"

# Print a file of the sources: from revision COMPAT_GIT_REV when set, else from the work tree.
CompatCat() {
  local path="$1";
  if [ -n "${COMPAT_GIT_REV}" ]; then
    git -C "${COMPAT_REPO}" show "${COMPAT_GIT_REV}:${path}" 2>/dev/null
  else
    cat "${COMPAT_REPO}/${path}" 2>/dev/null
  fi
}

CompatProbe_wo_bit() {
  local cli;
  cli=$( CompatCat "puffin/src/cli.rs" ) || return 1;
  grep -qF 'arg!(--"wo-bit" "Disable bit-level mutations")' <<< "${cli}" &&
      ! grep -qF 'arg!(--"with-bit"' <<< "${cli}"
}

CompatProbe_wo_trunc() {
  local cli;
  cli=$( CompatCat "puffin/src/cli.rs" ) || return 1;
  grep -qF 'arg!(--"wo-trunc" "Disable failed trace steps truncation")' <<< "${cli}" &&
      ! grep -qF 'arg!(--"with-trunc"' <<< "${cli}"
}

CompatProbe_log_config() {
  local setup;
  CompatCat "client_log_config.yml" > /dev/null || return 1;
  setup=$( CompatCat "puffin/src/fuzzer/libafl_setup.rs" ) || return 1;
  grep -qF 'load_fuzzing_client()' <<< "${setup}" &&
      ! grep -qF 'set_experiment_fuzzing_client' <<< "${setup}"
}

# Is commit $2 in the declared range of rule $1? (start is ancestor, end is not)
CompatInDeclaredRange() {
  local id="$1";
  local commit="$2";
  local range=( ${COMPAT_RANGE[${id}]} );
  git -C "${COMPAT_REPO}" merge-base --is-ancestor "${range[0]}" "${commit}" 2>/dev/null || return 1;
  [ "${range[1]}" == "-" ] && return 0;
  ! git -C "${COMPAT_REPO}" merge-base --is-ancestor "${range[1]}" "${commit}" 2>/dev/null
}

CompatIsDisabled() {
  local id="$1";
  [[ ",${COMPAT_DISABLE:-}," == *",all,"* || ",${COMPAT_DISABLE:-}," == *",${id},"* ]]
}

# Evaluate every rule for a commit.
#   $1 repository path, $2 commit, $3 reference to the output list of applied rule ids,
#   $4 (optional) JSON output file.
# Returns 1 when a commit of a declared range does not match the probe of its rule.
CompatEvaluate() {
  local COMPAT_REPO="$1";
  local commit="$2";
  local -n ref_applied=$3;
  local jsonFile="$4";

  ref_applied='';
  local status=0;
  local json='';
  local id;
  for id in "${COMPAT_RULES[@]}"; do
    local probe=false;
    local inRange=false;
    local disabled=false;
    local applied=false;
    CompatProbe_${id} && probe=true;
    CompatInDeclaredRange "${id}" "${commit}" && inRange=true;
    CompatIsDisabled "${id}" && disabled=true;
    local rangeEnd=( ${COMPAT_RANGE[${id}]} );
    if ${inRange} && ! ${probe} && [ "${rangeEnd[1]}" != "-" ]; then
      echo "Compat rule ${id}: commit ${commit} is in the declared range but does not match the probe" >&2;
      status=1;
    fi
    if ${probe} && ! ${disabled}; then
      applied=true;
      ref_applied+="${ref_applied:+,}${id}";
    fi
    echo "Compat rule ${id}: probe=${probe} in_range=${inRange} disabled=${disabled} applied=${applied}";
    json+="${json:+, }\"${id}\": { \"probe\": ${probe}, \"in_range\": ${inRange}, \"disabled\": ${disabled}, \"applied\": ${applied} }";
  done

  if [ -n "${jsonFile}" ]; then
    echo "{ \"version\": 1, \"commit\": \"${commit}\", \"rules\": { ${json} } }" > "${jsonFile}";
  fi
  return ${status};
}

CompatIsApplied() {
  local id="$1";
  [[ ",${COMPAT_APPLIED:-}," == *",${id},"* ]]
}

# Applied rules as a JSON array (recorded in cli-<step>.json)
CompatAppliedJSON() {
  local json='';
  local id;
  for id in ${COMPAT_APPLIED//,/ }; do
    json+="${json:+, }\"${id}\"";
  done
  echo "[${json}]";
}

# Init: prepare what the applied rules need later on (the sources are then copied by the build steps).
#   log_config: extract the reference client_log_config.yml into ${THEJOB_OUT_PATH}/compat/
CompatPrepare() {
  local repo="$1";
  if CompatIsApplied log_config; then
    local blob=$( git -C "${repo}" rev-parse "${COMPAT_LOG_CONFIG_REF}:client_log_config.yml" 2>/dev/null );
    if [ "${blob}" != "${COMPAT_LOG_CONFIG_BLOB}" ]; then
      echo "Compat rule log_config: reference client_log_config.yml not found (blob '${blob}')";
      return 1;
    fi
    mkdir -p "${THEJOB_OUT_PATH}/compat" || return 1;
    git -C "${repo}" show "${COMPAT_LOG_CONFIG_REF}:client_log_config.yml" > "${THEJOB_OUT_PATH}/compat/client_log_config.yml" || return 1;
    echo "Compat rule log_config: reference client_log_config.yml saved";
  fi
  return 0;
}

# Before launching the fuzzer: fuzzer flags of the applied rules (COMPAT_FLAG), merged once into the
# referenced flags.
#   wo_bit: not added with --wo-dy, as tlspuffin refuses to disable both bit-level and DY mutations
CompatApplyFlags() {
  local -n ref_flags=$1;
  local id;
  for id in "${COMPAT_RULES[@]}"; do
    local flag="${COMPAT_FLAG[${id}]}";
    [ -n "${flag}" ] && CompatIsApplied "${id}" || continue;
    if [ "${id}" == "wo_bit" ] && [[ " ${ref_flags} " == *" --wo-dy "* ]]; then
      echo "Compat rule ${id}: ${flag} not added, --wo-dy is set";
    elif [[ " ${ref_flags} " != *" ${flag} "* ]]; then
      ref_flags="${ref_flags:+${ref_flags} }${flag}";
      echo "Compat rule ${id}: ${flag} added";
    fi
  done
}

# Before launching the fuzzer, in its working directory: files of the applied rules.
#   log_config: overwrite ./client_log_config.yml with the reference one
CompatApplyFiles() {
  if CompatIsApplied log_config; then
    cp "${THEJOB_OUT_PATH}/compat/client_log_config.yml" ./client_log_config.yml || {
      echo "Compat rule log_config: failed to install the reference client_log_config.yml";
      return 1;
    }
    echo "Compat rule log_config: reference client_log_config.yml installed";
  fi
  return 0;
}

# After the build, on the output of "<fuzzer> help": the flags added by the rules must exist.
CompatVerifyHelp() {
  local helpFile="$1";
  local id;
  for id in "${COMPAT_RULES[@]}"; do
    local flag="${COMPAT_FLAG[${id}]}";
    [ -n "${flag}" ] && CompatIsApplied "${id}" || continue;
    if ! grep -q -- "${flag}" "${helpFile}"; then
      echo "Compat rule ${id}: the fuzzer has no ${flag} option";
      return 1;
    fi
  done
  return 0;
}

#### COMPAT RULES END ####
