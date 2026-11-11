# Validation of objectives against tlspuffin's vulnerability catalogue (patch differential).
#
# At the campaign's commit, with ASan, the validation set of the campaign's preset (`mk_vendor list`): F, every active
# bug that has a patch patched (`<preset>-fix-all`), and V_X, F without the patch of X (`<preset>-only-<X>`); a build
# derived from the catalogue (a custom benchmark's `<preset>-only-<ID>`) is validated on the set of its base preset. The
# catalogue is dev's (the default: the vulnerabilities.toml files of origin/dev and the patches they name replace the
# commit's) or the commit's (VALIDATION_CATALOGUE=commit, else the experiment's catalogue_source). An objective runs up to
# VALIDATION_RUNS times (3) on F, then on each V_X, with the campaign's flags:
#   - an objective on F: "not-patched" (a new bug, or a known bug without patch, named when its oracle matches:
#     known_unpatched; or the claim or panic of a bug with a patch here, which does not remove it: signature_of_patched,
#     to review; a crash oracle is too weak to name such a bug: any crash of its type would);
#   - else an objective on V_X matching X's oracle: "confirmed" X;
#   - else an objective on V_X with another signature: "other-signature" (removed by X's patch, to review, never X);
#   - else, when an execution could not run (no outcome: the binary refused its command line, crashed before the trace,
#     timed out): "error", with what failed (no replay result, never read as "not reproduced");
#   - else "inconclusive" (not reproduced on the validation builds).
# Controls: the witness of each X must give X's oracle on V_X and not on F (`tlspuffin witness`).
#
# ValidationPrepare: the checkout (validation/tree), the builds (the libraries in a folder shared by the tasks, one
# binary cached by the scheduler, both named after what they are made from rather than the commit) and
# the controls, recorded in validation/state.json, once per attempt: by PrepareValidation, a step before the experiment
# (experiments naming their bug, target_bug: custom benchmarks, Vuln group A and B; the monitor then confirms the
# experiment's objectives during the attempt, ConfirmObjective), else
# by ValidateObjectives. ValidationVerdict: the verdict of one objective, kept in validation/verdicts/.
# ValidateObjectives, after ExperimentEnd: the verdicts of the attempt's objectives (the targeted ones first, at most
# VALIDATION_MAX, within VALIDATION_BUDGET seconds of executions, and not past VALIDATION_DEADLINE when given (a value of
# $SECONDS: the end of PerfObjectives' budget): the others are "not-validated"), recorded in
# ${THEJOB_OUT_PATH}/validation-<step>-<attempt>.json, every execution as an artefact (<step>/<attempt>-validation); it
# removes the checkout. Commits without the catalogue are recorded as unsupported.

# tlspuffin's oracle matching (puffin::outcome::matches), on the outcome JSON of `execute --outcome`
VALIDATION_JQ='def matches($o): . as $out | $o != null
  and (($o.kind == "claim" and $out.outcome == "claim") or ($o.kind == "crash" and $out.outcome == "crash"))
  and ($o.signal == null or $o.signal == $out.signal)
  and ($o.asan == null or $o.asan == ($out.asan.type // null))
  and ($o.violation == null or $o.violation == $out.violation)
  and ($o.panic == null or $o.panic == $out.panic);
def objective: .outcome == "crash" or .outcome == "claim";
def failed: .outcome == "failed";'

# ASan options of the executions: an ASan report aborts at once (its type is the oracle's), no leak report; those of the
# campaign's launch when it set them (ValidationEnv)
VALIDATION_ASAN_DEFAULT="verify_asan_link_order=1:detect_leaks=0:abort_on_error=1"

# ValidationOverlayDev <tree> <repository>: dev's catalogue files in <tree>; prints dev's commit
ValidationOverlayDev() {
  local tree="$1" repo="$2" dev dir file;
  dev=$( git -C "${repo}" rev-parse --verify --quiet 'origin/dev^{commit}' ) || return 1;
  for dir in $( git -C "${repo}" ls-tree --name-only "${dev}" -- puffin-build/vendors/ ); do
    [ -d "${tree}/${dir}" ] || continue;
    if ! git -C "${repo}" show "${dev}:${dir}/vulnerabilities.toml" > "${tree}/${dir}/vulnerabilities.toml" 2> /dev/null; then
      rm -f "${tree}/${dir}/vulnerabilities.toml"; continue;
    fi
    for file in $( python3 -I -c 'import sys, tomllib
for entry in tomllib.load(open(sys.argv[1], "rb")).values():
    for patch in entry.get("patches", []):
        print("\n".join(patch.get("files", [])))' "${tree}/${dir}/vulnerabilities.toml" ) ; do
      mkdir -p "$( dirname "${tree}/${dir}/${file}" )";
      git -C "${repo}" show "${dev}:${dir}/${file}" > "${tree}/${dir}/${file}" || return 1;
    done
  done
  echo "${dev}";
}

# ValidationExecute <binary> <put> <trace> <tag>: one execution of an objective; prints its outcome (one JSON line):
# tlspuffin's (`execute --outcome`: crash, claim, error of the PUT, none), else {"outcome": "failed", "message": …}
# when the execution gave none (it could not run: its exit status or timeout, and the first error line of its log)
ValidationExecute() {
  local binary="$1" put="$2" trace="$3" tag="$4";
  local file="${VALIDATION_WORK}/runs/${tag}.json" log="${VALIDATION_WORK}/runs/${tag}.log" status=0;
  # the flags as the fuzzer's command line had them: a fragment of shell, which nix-shell --run read again (the job
  # configurations quote them: '--put-use-clear'): its words
  local -a flags=();
  eval "flags=( ${LAUNCH_FLAGS:-} )" 2> /dev/null || flags=();
  # shellcheck disable=SC2086 # LAUNCH_NOASLR is a word list
  ASAN_OPTIONS="${VALIDATION_ASAN_OPTIONS}" timeout -k 10 "${VALIDATION_TIMEOUT:-120}" ${LAUNCH_NOASLR:-} \
    "${binary}" --put "${put}" "${flags[@]}" execute --outcome "${file}" "${trace}" \
    < /dev/null > "${log}" 2>&1 || status=$?;
  jq -c '.[0].outcome // empty' "${file}" 2> /dev/null | grep . && return 0;
  local why;
  case "${status}" in
    124|137) why="timed out after ${VALIDATION_TIMEOUT:-120} s";;
    *) why="exit status ${status}: $( { grep -m1 -iE 'error|not found|no such|denied|panicked' "${log}" || grep -m1 . "${log}" || true; } 2> /dev/null |
                                       sed 's/^[0-9T:.+-]*[[:space:]]*//' | cut -c1-200 )";;
  esac
  jq -nc --arg m "no outcome, ${why}" '{ outcome: "failed", message: $m }';
}

# ValidationRuns <binary> <put> <trace> <tag>: up to VALIDATION_RUNS executions, until one gives an objective or one
# could not run (it would not the next time either); prints the outcomes as a JSON array
ValidationRuns() {
  local outcomes='[]' run outcome;
  for (( run = 1; run <= ${VALIDATION_RUNS:-3}; run++ )); do
    outcome=$( ValidationExecute "$1" "$2" "$3" "$4-${run}" );
    outcomes=$( jq -c --argjson o "${outcome}" '. + [$o]' <<< "${outcomes}" );
    jq -e "${VALIDATION_JQ} objective or failed" <<< "${outcome}" > /dev/null && break;
  done
  echo "${outcomes}";
}

# ValidationState <status> <message> [<fields (JSON object)>]: validation/state.json
ValidationState() {
  jq -n --arg status "$1" --arg message "$2" --argjson fields "${3:-{\}}" '{ status: $status, message: $message } + $fields' \
    > "${PWD}/validation/state.json";
}

# ValidationFail <message>: a validation that cannot be prepared (recorded as an error; the attempt does not fail)
ValidationFail() {
  ValidationState error "$1"; ValidationCleanup; return 0;
}

# ValidationCleanup: the checkout of the attempt goes (the binary first in the cache, when built here: it copies in
# the background)
ValidationCleanup() {
  # (VALIDATION_KEEP_CHECKOUT=1: the checkout is shared by several validations, removed by the caller once they ended)
  [ "${VALIDATION_KEEP_CHECKOUT:-}" == 1 ] && return 0;
  local state="${PWD}/validation/state.json" tree="${PWD}/validation/tree";
  if [ "$( jq -r '.cached // false' "${state}" 2> /dev/null )" == true ]; then
    local wait cacheId; cacheId=$( jq -r .cacheId "${state}" );
    for (( wait = 0; wait < 120; wait += 2 )); do QueryCache -q "${cacheId}" > /dev/null && break; sleep 2; done
  fi
  git -C "${THEJOB_OUT_PATH}/repo" worktree remove --force "${tree}" > /dev/null 2>&1;
  return 0;
}

# ValidationInputsHash <tree> <path>...: a hash of the contents of the files under these paths of the checkout (a
# missing path counts by its name): what the libraries or the binary of a validation set are made from, whatever the
# commit (a commit that changes none of them reuses them; the catalogue of dev overlaid on the checkout counts as it is)
ValidationInputsHash() {
  local tree="$1"; shift;
  ( cd "${tree}" && for input in "$@"; do
      if [ -e "${input}" ]; then find "${input}" -type f ! -path '*/target/*' ! -path '*/.git/*' -print0 | sort -z | xargs -0 -r sha256sum;
      else echo "missing ${input}"; fi
    done ) | sha256sum | cut -c1-32;
}

# ValidationPrepare: the validation of this attempt ready (validation/state.json, status ready, unsupported or error),
# once per attempt
ValidationPrepare() {
  export VALIDATION_WORK="${PWD}/validation";
  local state="${VALIDATION_WORK}/state.json";
  if [ -s "${state}" ]; then
    case "$( jq -r .status "${state}" )" in
      ready) [ -x "$( jq -r .binary "${state}" )" ] && [ -d "$( jq -r .tree "${state}" )" ] && return 0;;
      unsupported|error) return 0;;
    esac
  fi
  rm -rf "${VALIDATION_WORK}"; mkdir -p "${VALIDATION_WORK}/runs" "${VALIDATION_WORK}/verdicts";
  local repo="${THEJOB_OUT_PATH}/repo" tree="${VALIDATION_WORK}/tree";
  local lib="${vendor%%:*}" preset="${vendor#*:}";
  local unsupported='';
  git -C "${repo}" worktree add --force --detach "${tree}" "${COMMIT_ID}" > /dev/null 2>&1 ||
    unsupported="cannot check out ${COMMIT_ID}";
  if [ -z "${unsupported}" ] && { [ ! -r "${tree}/puffin-build/vendors/${lib}/vulnerabilities.toml" ] ||
       ! grep -q 'CheckPatches' "${tree}/puffin-build/src/tools/mk_vendor.rs" 2> /dev/null; }; then
    unsupported="tlspuffin ${COMMIT_ID:0:10} has no vulnerability catalogue (before pr/vuln-catalogue)";
  fi
  # the catalogue: VALIDATION_CATALOGUE, else that of the experiment (custom benchmarks: catalogue_source), else dev's
  local source="${VALIDATION_CATALOGUE:-${catalogue_source:-dev}}" catalogueCommit="${COMMIT_ID}";
  if [ -z "${unsupported}" ] && [ "${source}" == dev ]; then
    catalogueCommit=$( ValidationOverlayDev "${tree}" "${repo}" ) || unsupported="cannot read dev's catalogue";
    [ -z "${unsupported}" ] && [ ! -r "${tree}/puffin-build/vendors/${lib}/vulnerabilities.toml" ] &&
      unsupported="dev (${catalogueCommit:0:10}) has no catalogue for ${lib} yet (VALIDATION_CATALOGUE=commit: the commit's own)";
  fi
  if [ -n "${unsupported}" ]; then
    ValidationState unsupported "${unsupported}"; ValidationCleanup; return 0;
  fi

  # the validation set and the binary bundling it (mk_vendor list builds nothing: an empty vendor folder until the
  # libraries' folder is known, below)
  export VENDOR_DIR="${VALIDATION_WORK}/vendor";
  ( cd "${tree}" && nix-shell --run "./tools/mk_vendor list '${vendor}' --json" ) > "${VALIDATION_WORK}/list.json" ||
    { ValidationFail "mk_vendor list ${vendor} failed"; return 0; };
  # a build derived from the catalogue (<vendor>:<ID>, <preset>-only-<IDs>, -fix-…: custom benchmarks): the validation
  # set of its base preset, shared with every experiment on that preset
  local base; base=$( jq -r '.derived.base // empty' "${VALIDATION_WORK}/list.json" );
  command cp -f "${VALIDATION_WORK}/list.json" "${VALIDATION_WORK}/list-build.json";
  if [ -n "${base}" ]; then
    preset="${base}";
    ( cd "${tree}" && nix-shell --run "./tools/mk_vendor list '${lib}:${base}' --json" ) > "${VALIDATION_WORK}/list.json" ||
      { ValidationFail "mk_vendor list ${lib}:${base} failed"; return 0; };
  fi
  local -a builds; mapfile -t builds < <( jq -r '.validation_set[]' "${VALIDATION_WORK}/list.json" );
  local fixAll="${preset}-fix-all";
  local set; set="$( jq -r .catalogue "${VALIDATION_WORK}/list.json" ) ${lib}:${preset} ${builds[*]}";
  # the libraries of the set: built once into a folder shared by the tasks, named after what they are made from
  # (puffin-build's build code, the vendor's files with the catalogue and its patches, the toolchain), whatever the
  # commit; puffin-build locks each library while it builds or reads it, and builds only what is missing or stale
  local libsRoot="${VALIDATION_LIBS_ROOT:-${THEJOB_TOOLS_PATH}/../validation-libs}";
  local libsKey; libsKey=$( { ValidationInputsHash "${tree}" puffin-build/cmake puffin-build/src puffin-build/Cargo.toml \
      "puffin-build/vendors/${lib}" shell.nix tools/mk_vendor; echo "${set}"; } | sha256sum | cut -c1-32 );
  export VENDOR_DIR="${libsRoot}/${libsKey}";
  mkdir -p "${VENDOR_DIR}" && touch "${VENDOR_DIR}/.used";
  # the folders no task used for 30 days (.used: touched at each use)
  find "${libsRoot}" -mindepth 2 -maxdepth 2 -name .used -mtime +30 -printf '%h\0' 2> /dev/null | xargs -0 -r rm -rf;
  # the binary: cached per what it is made from (the crates, the build files, the toolchain) and the set it bundles
  local cacheId="validation-$( { ValidationInputsHash "${tree}" .cargo Cargo.lock Cargo.toml rust-toolchain.toml shell.nix crates \
      puffin puffin-build puffin-macros tlspuffin tlspuffin-claims extractable-macro tools; echo "${set}"; } | md5sum | cut -d' ' -f1 )";
  local binary cached=false; binary=$( QueryCache -q "${cacheId}" ) || binary='';
  if [ -z "${binary}" ] || [ ! -x "${binary}" ]; then
    local build;
    for build in "${builds[@]}"; do
      ( cd "${tree}" && nix-shell --run "./tools/mk_vendor make --asan '${lib}:${build}'" ) ||
        { ValidationFail "cannot build ${lib}:${build}"; return 0; };
    done
    ( cd "${tree}" && nix-shell --run "cargo build --bin tlspuffin --release --features=cputs -j ${THEJOB_NB_CORES:-1}" ) ||
      { ValidationFail "cannot build the validation binary"; return 0; };
    binary="${tree}/target/release/tlspuffin";
    SetCache "${cacheId}" "${binary}" > /dev/null;
    cached=true;
  fi
  echo "Validation set of ${vendor}: ${builds[*]} (binary ${binary})";

  # candidates: the active bugs with a patch, whose objectives replay; known bugs left active everywhere: no patch
  local candidates unpatched;
  candidates=$( jq -c '[.entries[] | select(.state == "active" and .patchable and .replayable)]' "${VALIDATION_WORK}/list.json" );
  unpatched=$( jq -c '[.entries[] | select(.state == "active" and (.patchable | not))]' "${VALIDATION_WORK}/list.json" );

  # controls: each candidate's witness, when this commit has one (the binary reads the catalogue of this checkout)
  local -x PUFFIN_BUILD_DIR="${tree}/puffin-build";
  local witnesses; witnesses=$( ASAN_OPTIONS="${VALIDATION_ASAN_DEFAULT}" "${binary}" catalogue --json 2> /dev/null | jq -c '[.witnesses[].entry] | unique' ) || witnesses='[]';
  local controls='[]' id;
  for id in $( jq -r '.[].id' <<< "${candidates}" ); do
    if ! jq -e --arg id "${id}" 'index($id) != null' <<< "${witnesses}" > /dev/null; then
      controls=$( jq -c --arg id "${id}" '. + [{ entry: $id, ok: null, note: "no witness at this commit" }]' <<< "${controls}" ); continue;
    fi
    local put good bad;
    for put in "${preset}-only-${id}" "${fixAll}"; do
      ASAN_OPTIONS="${VALIDATION_ASAN_DEFAULT}" timeout -k 10 "${VALIDATION_TIMEOUT:-120}" "${binary}" --put "${put}" witness "${id}" \
        --runs "${VALIDATION_RUNS:-3}" --outcome "${VALIDATION_WORK}/runs/control-${id}-${put}.json" \
        < /dev/null > "${VALIDATION_WORK}/runs/control-${id}-${put}.log" 2>&1;
    done
    good=$( jq -c '[.[].matches_oracle] | any' "${VALIDATION_WORK}/runs/control-${id}-${preset}-only-${id}.json" 2> /dev/null || echo null );
    bad=$( jq -c '[.[].matches_oracle] | any' "${VALIDATION_WORK}/runs/control-${id}-${fixAll}.json" 2> /dev/null || echo null );
    controls=$( jq -c --arg id "${id}" --argjson good "${good}" --argjson bad "${bad}" \
      '. + [{ entry: $id, triggers_unpatched: $good, triggers_patched: $bad, ok: ($good == true and $bad == false) }]' <<< "${controls}" );
  done

  ValidationState ready '' "$( jq -n --arg binary "${binary}" --arg tree "${tree}" --arg lib "${lib}" --arg preset "${preset}" \
    --arg fixAll "${fixAll}" --arg source "${source}" --arg catalogueCommit "${catalogueCommit}" --arg cacheId "${cacheId}" \
    --argjson cached "${cached}" --argjson candidates "${candidates}" --argjson unpatched "${unpatched}" --argjson controls "${controls}" \
    --slurpfile list "${VALIDATION_WORK}/list.json" \
    '{ binary: $binary, tree: $tree, lib: $lib, preset: $preset, fixAll: $fixAll, source: $source, catalogueCommit: $catalogueCommit,
       cacheId: $cacheId, cached: $cached, candidates: $candidates, unpatched: $unpatched, controls: $controls,
       entries: [$list[0].entries[] | { id, state, patchable, replayable, oracle }] }' )";
  return 0;
}

# ValidationEnv: what the executions need, from the prepared validation and the campaign's launch (.currentlaunch,
# written by the experiment step: its flags, ASLR, ASan options): VALIDATION_WORK, VALIDATION_BINARY, PUFFIN_BUILD_DIR
# (the binary reads its catalogue at run time: that of this checkout, a cached binary was built in another one, from
# the same sources and catalogue, which are in the cache key), LAUNCH_FLAGS, LAUNCH_NOASLR, VALIDATION_ASAN_OPTIONS. 1: not
# ready. Sets globals: run it in a subshell where they must not stay (the monitor)
ValidationEnv() {
  VALIDATION_WORK="${PWD}/validation";
  local state="${VALIDATION_WORK}/state.json";
  [ "$( jq -r .status "${state}" 2> /dev/null )" == ready ] || return 1;
  VALIDATION_BINARY=$( jq -r .binary "${state}" );
  export PUFFIN_BUILD_DIR; PUFFIN_BUILD_DIR="$( jq -r .tree "${state}" )/puffin-build";
  LAUNCH_FLAGS=''; LAUNCH_NOASLR=''; LAUNCH_ASAN_SET=false; LAUNCH_ASAN_OPTIONS='';
  # shellcheck disable=SC1091
  [ -r .currentlaunch ] && source .currentlaunch;
  VALIDATION_ASAN_OPTIONS="${VALIDATION_ASAN_DEFAULT}";
  [ "${LAUNCH_ASAN_SET}" == true ] && [ -n "${LAUNCH_ASAN_OPTIONS}" ] && VALIDATION_ASAN_OPTIONS="${LAUNCH_ASAN_OPTIONS}";
  return 0;
}

# ValidationVerdict <trace> [during]: the verdict of an objective (JSON: trace, verdict, entries, known_unpatched,
# other_signature, the executions), computed once (validation/verdicts/<name>.json; "during": by the monitor, during
# the attempt). Needs ValidationEnv
ValidationVerdict() {
  local trace="$1" name; name=$( basename "$1" .trace );
  local file="${VALIDATION_WORK}/verdicts/${name}.json" state="${VALIDATION_WORK}/state.json";
  [ -s "${file}" ] && { cat "${file}"; return 0; };
  local fixAll preset candidates unpatched;
  fixAll=$( jq -r .fixAll "${state}" ); preset=$( jq -r .preset "${state}" );
  candidates=$( jq -c .candidates "${state}" ); unpatched=$( jq -c .unpatched "${state}" );
  local onF; onF=$( ValidationRuns "${VALIDATION_BINARY}" "${fixAll}" "${trace}" "${name}-F" );
  local result id;
  if jq -e "${VALIDATION_JQ} any(.[]; objective)" <<< "${onF}" > /dev/null; then
    result=$( jq -c --arg t "${name}" --argjson f "${onF}" --argjson unpatched "${unpatched}" --argjson candidates "${candidates}" "${VALIDATION_JQ}
      ([\$f[] | select(objective)][0]) as \$o
      | { trace: \$t, verdict: \"not-patched\", entries: [], known_unpatched: [\$unpatched[] | select(.oracle as \$or | \$o | matches(\$or)) | .id],
          signature_of_patched: [\$candidates[] | select(.oracle.kind != \"crash\") | select(.oracle as \$or | \$o | matches(\$or)) | .id], f: \$f }" <<< 'null' );
  elif jq -e "${VALIDATION_JQ} any(.[]; failed)" <<< "${onF}" > /dev/null; then
    # F could not run it: nothing to compare the builds without a patch with
    result=$( jq -c --arg t "${name}" --argjson f "${onF}" "${VALIDATION_JQ}
      { trace: \$t, verdict: \"error\", entries: [], known_unpatched: [],
        failure: { build: \"F\", message: ([\$f[] | select(failed) | .message][0]) }, f: \$f }" <<< 'null' );
  else
    local onV='{}';
    for id in $( jq -r '.[].id' <<< "${candidates}" ); do
      onV=$( jq -c --arg id "${id}" --argjson runs "$( ValidationRuns "${VALIDATION_BINARY}" "${preset}-only-${id}" "${trace}" "${name}-${id}" )" '. + { ($id): $runs }' <<< "${onV}" );
    done
    # confirmed, else another signature, else an error when a build could not run it (that bug was not checked), else
    # inconclusive
    result=$( jq -c --arg t "${name}" --argjson f "${onF}" --argjson v "${onV}" --argjson candidates "${candidates}" "${VALIDATION_JQ}
      [\$candidates[] | .id as \$id | .oracle as \$or | select(any(\$v[\$id][]?; matches(\$or))) | \$id] as \$confirmed
      | [\$candidates[] | .id as \$id | .oracle as \$or | select((any(\$v[\$id][]?; matches(\$or)) | not) and any(\$v[\$id][]?; objective)) | \$id] as \$other
      | [\$v | to_entries[] | .key as \$id | .value[] | select(failed) | { build: \$id, message }] as \$failed
      | { trace: \$t, verdict: (if (\$confirmed | length) > 0 then \"confirmed\" elif (\$other | length) > 0 then \"other-signature\"
                               elif (\$failed | length) > 0 then \"error\" else \"inconclusive\" end),
          entries: \$confirmed, other_signature: \$other, f: \$f, v: \$v }
      + (if (\$confirmed | length) == 0 and (\$other | length) == 0 and (\$failed | length) > 0 then { failure: \$failed[0] } else {} end)" <<< 'null' );
  fi
  [ "${2:-}" == during ] && result=$( jq -c '. + { during_attempt: true }' <<< "${result}" );
  echo "${result}" > "${file}";
  echo "${result}";
}

# ConfirmObjective <trace>: whether an objective of an experiment naming its bug is that bug (target_bug), by its
# verdict: 0 confirmed, by patch differential when the target has a patch at this version, else by its signature on the
# build with every patch (verdict not-patched, the target named); 1 not confirmed (another bug, not reproduced); 2 not
# decided by validation (not prepared: unsupported or error; the target's objectives do not replay; its replays could not
# run: verdict "error"): the caller keeps the fuzzer's record. Prints why, in a few words. The executions run in a
# subshell (the monitor's globals stay).
ConfirmObjective() {
  local trace="$1" state="${PWD}/validation/state.json";
  if [ "$( jq -r .status "${state}" 2> /dev/null )" != ready ]; then
    echo "no validation: $( jq -r '.message // empty' "${state}" 2> /dev/null || true )"; return 2;
  fi
  local target; target=$( jq -c --arg id "${target_bug:-}" '{ candidate: ([.candidates[].id] | index($id) != null),
      replayable: ([.entries[] | select(.id == $id) | .replayable][0] | . != false) }' "${state}" );
  jq -e '.replayable == false' <<< "${target}" > /dev/null && { echo "its objectives do not replay: the fuzzer's record"; return 2; };
  local verdict; verdict=$( ValidationEnv && ValidationVerdict "${trace}" during ) || { echo "the validation failed"; return 2; };
  if jq -e '.candidate' <<< "${target}" > /dev/null; then
    jq -e --arg id "${target_bug}" '.verdict == "confirmed" and (.entries | index($id) != null)' <<< "${verdict}" > /dev/null &&
      { echo "confirmed by patch differential"; return 0; };
  else
    jq -e --arg id "${target_bug}" '.verdict == "not-patched" and ((.known_unpatched // []) | index($id) != null)' <<< "${verdict}" > /dev/null &&
      { echo "its signature on the build with every patch (no patch for it)"; return 0; };
  fi
  jq -e '.verdict == "error"' <<< "${verdict}" > /dev/null &&
    { echo "the replays could not run ($( jq -r '.failure.message // "no outcome"' <<< "${verdict}" )): the fuzzer's record"; return 2; };
  jq -r '"validation: " + .verdict + (if (.entries | length) > 0 then " " + (.entries | join(", ")) else "" end)
    + (if ((.known_unpatched // []) | length) > 0 then " (" + (.known_unpatched | join(", ")) + ")" else "" end)' <<< "${verdict}";
  return 1;
}

# PrepareValidation: a step before the experiment (custom benchmarks, Vuln group A and B): the validation ready, so that
# the monitor can confirm the experiment's objectives before it ends the attempt (ConfirmObjective), with the cores of
# this step
PrepareValidation() {
  [ -s ./.unsupported ] && return 0;
  [ "${VALIDATION:-on}" == off ] && return 0;
  ValidationPrepare;
  echo "Validation: $( jq -r '.status + (if .message != "" then ": " + .message else "" end)' "${PWD}/validation/state.json" )";
  return 0;
}

# ValidationChoice <experiment dir>: the objectives to validate, in order, at most VALIDATION_MAX (20): the targeted
# ones first (ExperimentEnd's .targeted-names), then the first of each bug (the fuzzer's record of the objective: its
# claim, or the top frame of its crash; FuzzerVerdicts, when the job script has it), then the others by time. A campaign
# saves hundreds of objectives, often of one bug: each distinct bug gets a verdict before the many of one.
ValidationChoice() {
  local experiment="$1" all firstOfEach='';
  all=$( find "${experiment}objective" -maxdepth 1 -type f -name '*.trace' ! -name '.*' -printf '%T@ %p\n' | sort -n | cut -d' ' -f2- );
  if [ -n "${all}" ] && declare -F FuzzerVerdicts > /dev/null && declare -F FuzzerRecords > /dev/null; then
    local records; records=$( FuzzerRecords "$( FuzzerLogDir "${experiment}" 2> /dev/null )" 2> /dev/null ) || records='';
    firstOfEach=$( sed 's#.*/##; s/\.trace$//' <<< "${all}" | FuzzerVerdicts "${records}" 2> /dev/null |
        awk -F'\t' '$2 != "" { split($4, frames, " < "); key = $2 "|" ($2 == "claim" ? $3 : frames[1]);
                                if (!(key in seen)) { seen[key] = 1; print $1 } }' |
        sed "s|^|${experiment}objective/|; s|$|.trace|" );
  fi
  { [ -s "${experiment}.targeted-names" ] && sed "s|^|${experiment}objective/|; s|$|.trace|" "${experiment}.targeted-names";
    [ -n "${firstOfEach}" ] && echo "${firstOfEach}"; echo "${all}"; } |
    awk 'NF && !seen[$0]++' | while read -r t; do [ -f "${t}" ] && echo "${t}"; done |
    awk -v max="${VALIDATION_MAX:-20}" 'NR <= max';  # (reads all: no broken pipe under pipefail)
}

ValidateObjectives() {
  local out="${THEJOB_OUT_PATH}/validation-${THEJOB_STEP_ID}-${THEJOB_STEP_ATTEMPT_ID}.json";
  if [ "${VALIDATION:-on}" == off ]; then
    jq -n '{ skipped: "VALIDATION=off" }' > "${out}"; ValidationCleanup; return 0;
  fi
  local experiment; experiment=$( ls -d ./experiments/*/ 2> /dev/null | head -1 );
  local -a traces=();
  if [ -n "${experiment}" ] && [ -d "${experiment}objective" ]; then
    # the targeted objectives first, then the first of each bug, then the others by time (ValidationChoice)
    mapfile -t traces < <( ValidationChoice "${experiment}" );
  fi
  if (( ${#traces[@]} == 0 )); then
    jq -n '{ objectives: [], note: "no objective" }' > "${out}"; ValidationCleanup; return 0;
  fi

  ValidationPrepare;
  local state="${PWD}/validation/state.json" status; status=$( jq -r .status "${state}" );
  if [ "${status}" != ready ]; then
    echo "Validation: $( jq -r .message "${state}" )";
    if [ "${status}" == unsupported ]; then
      jq -n --arg u "$( jq -r .message "${state}" )" --argjson n "${#traces[@]}" '{ unsupported: $u, total: $n, objectives: [] }' > "${out}";
    else
      jq -n --arg e "$( jq -r .message "${state}" )" '{ error: $e, objectives: [] }' > "${out}";
    fi
    ValidationCleanup; return 0;
  fi
  ValidationEnv;

  # the verdict of each objective (those of the monitor kept), within the budget of executions, counted from now (the
  # validation prepared), and not past the deadline of the caller
  local budgetStart=${SECONDS} budget="${VALIDATION_BUDGET:-1800}" results='[]' trace result name;
  if [ -n "${VALIDATION_DEADLINE:-}" ] && (( VALIDATION_DEADLINE - SECONDS < budget )); then
    budget=$(( VALIDATION_DEADLINE - SECONDS )); (( budget < 0 )) && budget=0;
  fi
  for trace in "${traces[@]}"; do
    name=$( basename "${trace}" .trace );
    if [ ! -s "${VALIDATION_WORK}/verdicts/${name}.json" ] && (( SECONDS - budgetStart >= budget )); then
      echo "Validation: ${name}: not validated (budget of ${budget} s spent)";
      results=$( jq -c --arg t "${name}" '. + [{ trace: $t, verdict: "not-validated", entries: [], note: "validation budget spent" }]' <<< "${results}" );
      continue;
    fi
    result=$( ValidationVerdict "${trace}" );
    echo "Validation: ${name}: $( jq -r '.verdict + (if (.entries | length) > 0 then " " + (.entries | join(", ")) else "" end) + (if .during_attempt then " (during the attempt)" else "" end)' <<< "${result}" )";
    results=$( jq -c --argjson r "${result}" '. + [$r]' <<< "${results}" );
  done

  local lib preset; lib=$( jq -r .lib "${state}" ); preset=$( jq -r .preset "${state}" );
  # the bench that validated: the deployed version (version.json of deploy.sh) and the commit of these job scripts
  # (build.sh), which a hot copy can change without a deploy: the pages say which code made the verdicts
  local deployed; deployed=$( jq -r '.commit // empty' "${THEJOB_TOOLS_PATH:-/nonexistent}/../html/board/version.json" 2> /dev/null || true );
  jq -n --arg commit "${COMMIT_ID}" --arg deployed "${deployed}" --arg jobscripts "${PB_JOBSCRIPTS_COMMIT:-}" --arg vendor "${vendor}" --arg source "$( jq -r .source "${state}" )" --arg catalogueCommit "$( jq -r .catalogueCommit "${state}" )" \
    --argjson total "$( find "${experiment}objective" -maxdepth 1 -type f -name '*.trace' ! -name '.*' | wc -l )" \
    --slurpfile list "${VALIDATION_WORK}/list.json" --slurpfile build "${VALIDATION_WORK}/list-build.json" \
    --arg validatedOn "${lib}:${preset}" --argjson controls "$( jq -c .controls "${state}" )" --argjson results "${results}" \
    'def orNull: if . == "" then null else . end;
     { commit: $commit, bench: { commit: ($deployed | orNull), jobscripts: ($jobscripts | orNull) }, vendor: $vendor, catalogue: { source: $source, commit: $catalogueCommit, hash: $list[0].catalogue },
       build: { name: $build[0].name, derived: $build[0].derived, fix: $build[0].fix, asan: $build[0].asan,
                states: ($build[0].entries | map({ (.id): .state }) | add) },
       validated_on: $validatedOn, builds: $list[0].validation_set, entries: ($list[0].entries | map({ (.id): { state, patchable, replayable, hash, build_hash, alias, oracle } }) | add),
       controls: $controls, controls_ok: ([$controls[].ok | select(. != null)] | all), total: $total, objectives: $results }' > "${out}" || return 1;
  CreateArtefact "${VALIDATION_WORK}/runs" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-validation" "commit_id:${COMMIT_ID}";
  ValidationCleanup;
  echo "Validation: $( jq -r '"\(.objectives | length) of \(.total) objectives: " + ([.objectives[] | .verdict] | group_by(.) | map("\(length) \(.[0])") | join(", ")) + (if .controls_ok then "" else " (controls failed)" end)' "${out}" )";
  return 0;
}
