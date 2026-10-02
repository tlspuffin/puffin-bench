#### COMPAT RULES START ####
#
# Commit-dependent rules keeping results comparable across the tlspuffin history.
#
# Each rule has:
#   - a probe, CompatProbe_<id>, run against the checked-out sources: it decides whether the
#     rule applies (so side-branch commits outside the declared range are handled too);
#   - a declared range [start, end) in COMPAT_RANGE: documents the intent and is used by the
#     self-test (tests/compat_selftest.sh). A commit inside the range that does not match the probe
#     (e.g. a commit of the tlspuffin pull request that removed the bias) is still run with the probe's
#     decision, with a warning shown on the scheduler board and on the dashboard (COMPAT_WARNING):
#     never an unfair experiment silently, and no experiment refused that older job scripts ran.
#     An end "-" means the range is still open (not fixed on dev yet): only the probe decides.
#
# A rule can be disabled with the task argument COMPAT_DISABLE (comma separated ids, or "all").

COMPAT_RULES=( wo_bit wo_trunc log_config reseed_warn codec_warn wolfssl_reseed_warn wolfssl_reseed_error openssl_descriptor_info wolfssl_descriptor_info boringssl_clear_info toml_cli_locked )

declare -A COMPAT_RANGE=(
  # bit-level mutations enabled by default (opt-out --wo-bit); opt-in --with-bit from e13983d
  [wo_bit]="47c97cd7ac2cdad73cd9c9b1753b69f857298c89 e13983d6a6e186cde04fffeb12914f06b4ff9b68"
  # failed trace steps truncation enabled by default (opt-out --wo-trunc); opt-in --with-trunc from 24f7f10c2
  [wo_trunc]="2ed7077aa2a3b937dcbb18d5fc80797bc43f0337 24f7f10c2425fafcddd5a6358d147e5d49487a08"
  # fuzzing clients load a debug-level client_log_config.yml; experiments ignore it from e13983d
  [log_config]="60b3f3185edd8dc6515c578e6321bf7a6f00fc2b e13983d6a6e186cde04fffeb12914f06b4ff9b68"
  # the default PUT factory logs a WARN on every execution for the tcp PUT; debug again from d1f510dcb
  [reseed_warn]="2f38bf22aee802509663609fa4ca84b8634e5574 d1f510dcbd4423914fe49966285c58fe7901efee"
  # evaluation failures FnError::Codec (e.g. unparsable mutated key shares) logged at WARN with the whole
  # term, thousands of times per minute; open until the tlspuffin fix (pr/quiet-eval-errors) is merged
  [codec_warn]="2f38bf22aee802509663609fa4ca84b8634e5574 -"
  # reseed failure of the wolfSSL Rust PUT logged at WARN before every execution; open, same fix
  [wolfssl_reseed_warn]="29e90ea7816e582d84fd3928156b84b033808549 -"
  # the wolfSSL PUT factory logs an ERROR for its unimplemented reseed before every execution (~100 MB per
  # 70 min run); the reseed is no longer exposed from a914ff56a
  [wolfssl_reseed_error]="2a0619f4ad4324cd264c76ead7e5ca208212d8c1 a914ff56a8e11acb158b7ebaa1afc007d28a1d5d"
  # the C harnesses log every agent creation ("descriptor N version: ... type: ...") at INFO, ~200,000 lines per
  # 70 min run; DEBUG from e13983d
  [openssl_descriptor_info]="207ecfde6c81380b90b1c52e31c0aec547b896ae e13983d6a6e186cde04fffeb12914f06b4ff9b68"
  [wolfssl_descriptor_info]="15e32f80427ed753744b36d5e3c588ad4a85ce72 e13983d6a6e186cde04fffeb12914f06b4ff9b68"
  # the BoringSSL Rust PUT logs "does not support clearing mode" at INFO for every PUT it creates (~140,000 lines
  # per 70 min run); open (also on dev, where benchmarks use the BoringSSL C harness)
  [boringssl_clear_info]="8d799887b891b0fa7f8ae34f3b5152a4757bb4cb -"
  # build fix: mk_vendor installs toml-cli with the commit's toolchain and without --locked: its newest
  # dependencies need a newer rustc, and its locked ones (proc-macro2 1.0.47) do not build on the commit's
  # nightly, so the C vendor libraries (e.g. OpenSSL) fail to build; installed with --locked by the stable
  # toolchain instead, installed first (rustup < 1.28, as in the nix shell, does not install a toolchain
  # named by "+stable"; serialized with the other toolchain installs), and found in ~/.cargo/bin even when it
  # is not in the PATH; mk_vendor is also run by the build scripts of the -src crates (e.g. openssl-src-111), where
  # cargo sets RUSTC to the commit's rustc, which "cargo install" would use: the variables cargo gives to build
  # scripts are cleared for the install; mk_vendor rewritten from 5586c58b1
  [toml_cli_locked]="c3a6d8a94af81ebd5f24d9420cb6c2cf17fb690b 5586c58b12a7bee021d3ae9df242df89ebefae0f"
)

# source lines patched by the rules at Init: "<file>|<text of the lines>|<from>|<to>[|<offset>]" (literal strings;
# for every line containing the text, the line <offset> lines away (default 0: the same line) gets its first <from>
# replaced by <to>; the patched lines must then be gone)
declare -A COMPAT_PATCH=(
  [reseed_warn]='puffin/src/put_registry.rs|log::warn!("[RNG] reseed failed ({}): not supported"|log::warn!|log::debug!'
  [codec_warn]='puffin/src/algebra/term.rs|log::warn!("[evaluate_config_wrap]  FnError::Codec Error on|log::warn!|log::debug!'
  [wolfssl_reseed_warn]='crates/wolfssl-sys/src/lib.rs|log::warn!("[RNG] reseed failed: not implemented for wolfssl")|log::warn!|log::debug!'
  [wolfssl_reseed_error]='tlspuffin/src/wolfssl/mod.rs|error!("[determinism_|error!(|log::debug!('
  [openssl_descriptor_info]='tlspuffin/harness/openssl/src/put.c|"descriptor %u version: %s type: %s",|_log(PUFFIN.info,|_log(PUFFIN.debug,|-1'
  [wolfssl_descriptor_info]='tlspuffin/harness/wolfssl/src/put.c|"descriptor %u version: %s type: |_log(PUFFIN.info,|_log(PUFFIN.debug,|-1'
  [boringssl_clear_info]='tlspuffin/src/rust_put/boringssl/mod.rs|log::info!("BoringSSL PUT does not support clearing mode")|log::info!|log::debug!'
  [toml_cli_locked]='tools/mk_vendor|cargo install toml-cli --version "0.2.3"|cargo install toml-cli --version "0.2.3"|PATH="${PATH}:${CARGO_HOME:-${HOME}/.cargo}/bin"; if ! command -v toml > /dev/null; then flock "${HOME:-/tmp}/.puffin-bench-rustup.lock" env -u RUSTC -u RUSTC_WRAPPER -u RUSTC_WORKSPACE_WRAPPER -u RUSTDOC -u RUSTFLAGS -u CARGO_ENCODED_RUSTFLAGS -u CARGO_TARGET_DIR -u CARGO_BUILD_TARGET -u RUSTUP_TOOLCHAIN sh -c "rustup toolchain install stable --profile minimal && cargo +stable install toml-cli --locked --version 0.2.3"; fi'
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

# Does the source contain the lines patched by rule $1 (COMPAT_PATCH)?
CompatHasPatchLine() {
  local file text rest;
  IFS='|' read -r file text rest <<< "${COMPAT_PATCH[$1]}";
  CompatCat "${file}" | grep -qF "${text}"
}

CompatProbe_reseed_warn() {
  # the default PUT factory warns; from d1f510dcb the tcp PUT has its own debug message
  CompatHasPatchLine reseed_warn && ! CompatCat "tlspuffin/src/tcp/mod.rs" | grep -qF 'reseed failed'
}

CompatProbe_codec_warn() {
  CompatHasPatchLine codec_warn
}

CompatProbe_wolfssl_reseed_warn() {
  CompatHasPatchLine wolfssl_reseed_warn
}

CompatProbe_wolfssl_reseed_error() {
  CompatCat "tlspuffin/src/wolfssl/mod.rs" | grep -qF 'error!("[determinism_reseed] Not yet implemented.")'
}

# Do all the lines containing the text of rule $1 (COMPAT_PATCH) have <from> on the line <offset> lines away?
CompatHasOffsetLine() {
  local file text from to offset;
  IFS='|' read -r file text from to offset <<< "${COMPAT_PATCH[$1]}";
  CompatCat "${file}" | awk -v text="${text}" -v from="${from}" -v off="${offset:-0}" '
    { line[NR] = $0 } index($0, text) { hits[++n] = NR }
    END { if (n == 0) exit 1; for (i = 1; i <= n; i++) if (index(line[hits[i] + off], from) == 0) exit 1; exit 0 }'
}

CompatProbe_openssl_descriptor_info() {
  CompatHasOffsetLine openssl_descriptor_info
}

CompatProbe_wolfssl_descriptor_info() {
  CompatHasOffsetLine wolfssl_descriptor_info
}

CompatProbe_boringssl_clear_info() {
  CompatHasPatchLine boringssl_clear_info
}

CompatProbe_toml_cli_locked() {
  CompatHasPatchLine toml_cli_locked
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
# Sets COMPAT_MISMATCH to the ids of the rules whose declared range contains the commit while their probe
# does not match (the probe decides; the mismatch is reported as a warning).
CompatEvaluate() {
  local COMPAT_REPO="$1";
  local commit="$2";
  local -n ref_applied=$3;
  local jsonFile="$4";

  ref_applied='';
  COMPAT_MISMATCH='';
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
    local mismatch=false;
    if ${inRange} && ! ${probe} && [ "${rangeEnd[1]}" != "-" ]; then
      echo "WARNING: compat rule ${id}: commit ${commit} is in the declared range but does not match the probe: not applied" >&2;
      mismatch=true;
      COMPAT_MISMATCH+="${COMPAT_MISMATCH:+,}${id}";
    fi
    if ${probe} && ! ${disabled}; then
      applied=true;
      ref_applied+="${ref_applied:+,}${id}";
    fi
    echo "Compat rule ${id}: probe=${probe} in_range=${inRange} disabled=${disabled} applied=${applied}";
    json+="${json:+, }\"${id}\": { \"probe\": ${probe}, \"in_range\": ${inRange}, \"disabled\": ${disabled}, \"applied\": ${applied}, \"mismatch\": ${mismatch} }";
  done

  if [ -n "${jsonFile}" ]; then
    echo "{ \"version\": 1, \"commit\": \"${commit}\", \"rules\": { ${json} } }" > "${jsonFile}";
  fi
  return 0;
}

CompatIsApplied() {
  local id="$1";
  [[ ",${COMPAT_APPLIED:-}," == *",${id},"* ]]
}

# Warning of the task (COMPAT_WARNING, set by Init) as a JSON string or null (recorded in cli-<step>.json)
CompatWarningJSON() {
  [ -n "${COMPAT_WARNING:-}" ] && echo "\"${COMPAT_WARNING//\"/\'}\"" || echo null;
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
#   rules of COMPAT_PATCH: patch their source lines (log level lowered to debug, toml-cli install --locked)
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
  local id;
  for id in "${!COMPAT_PATCH[@]}"; do
    CompatIsApplied "${id}" || continue;
    local path text from to offset;
    IFS='|' read -r path text from to offset <<< "${COMPAT_PATCH[${id}]}";
    offset="${offset:-0}";
    local file="${repo}/${path}";
    # literal strings for sed
    from=$( printf '%s' "${from}" | sed 's/[][\\.*^$/]/\\&/g' );
    to=$( printf '%s' "${to}" | sed 's/[\\/&]/\\&/g' );
    local line;
    for line in $( grep -nF "${text}" "${file}" | cut -d: -f1 ); do
      sed -i "$(( line + offset ))s/${from}/${to}/" "${file}" || return 1;
    done
    local unpatched=false;
    if (( offset == 0 )); then
      grep -qF "${text}" "${file}" && unpatched=true;
    else
      COMPAT_GIT_REV='' COMPAT_REPO="${repo}" CompatHasOffsetLine "${id}" && unpatched=true;
    fi
    if ${unpatched}; then
      echo "Compat rule ${id}: failed to patch ${file}";
      return 1;
    fi
    echo "Compat rule ${id}: ${file} patched";
  done
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

# Build rule, called by ComputeBuildRuntimeInfo (so the build and the experiment use the same features):
# perf experiments of LibreSSL must run with ASAN.
#   $1 package, $2 vendor, $3 cputs (true|false), $4 reference to the features.
# The Rust harness gets the "asan" feature if missing. Sets COMPAT_UNSUPPORTED (and returns 0) when
# ASAN is impossible: C vendor preset without ASAN, or libressl-src without ASAN support (before cd649d6bf).
CompatBuildRules() {
  local package="$1";
  local vendor="$2";
  local cputs="$3";
  local -n ref_cbr_features=$4;

  COMPAT_UNSUPPORTED='';
  [ "${TYPE:-}" == "perf" ] && [ "${package}" == "tlspuffin" ] || return 0;
  [[ "${vendor}" == libressl:* || ",${ref_cbr_features}," =~ ,libressl[0-9]*, ]] || return 0;
  CompatIsDisabled libressl_asan && return 0;

  if ${cputs}; then
    [[ "${vendor}" == *-asan ]] ||
        COMPAT_UNSUPPORTED="LibreSSL: ASAN unsupported (vendor ${vendor} is not an -asan preset)";
    return 0;
  fi
  if [[ ",${ref_cbr_features}," != *,asan,* ]]; then
    ref_cbr_features="${ref_cbr_features:+${ref_cbr_features},}asan";
    echo "Compat rule libressl_asan: asan feature added";
  fi
  if grep -qF 'ASAN not yet supported' "${THEJOB_OUT_PATH}/repo/crates/libressl-src/src/lib.rs" 2>/dev/null; then
    COMPAT_UNSUPPORTED="LibreSSL: ASAN unsupported (libressl-src cannot build with ASAN at this commit)";
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
