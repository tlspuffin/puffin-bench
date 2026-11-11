# Validation of the objectives of an experiment against tlspuffin's vulnerability catalogue (patch differential).
#
# ValidateObjectives is a step after ExperimentEnd, in the same working directory (the experiment and .currentlaunch).
# At the campaign's commit, with ASan, it builds the validation set of the campaign's preset (`mk_vendor list`): F,
# every active bug that has a patch patched (`<preset>-fix-all`), and V_X, F without the patch of X
# (`<preset>-only-<X>`). The catalogue is dev's (VALIDATION_CATALOGUE=dev, the default: the vulnerabilities.toml files
# of origin/dev and the patches they name replace the commit's) or the commit's (VALIDATION_CATALOGUE=commit, e.g. a bug
# added by a PR). Each objective runs up to VALIDATION_RUNS times (3) on F, then on each V_X, with the campaign's flags:
#   - an objective on F: "not-patched" (a new bug, or a known bug without patch, named when its oracle matches);
#   - else an objective on V_X matching X's oracle: "confirmed" X;
#   - else an objective on V_X with another signature: "other-signature" (removed by X's patch, to review, never X);
#   - else "inconclusive".
# Controls: the witness of each X must give X's oracle on V_X and not on F (`tlspuffin witness`).
# Executions after the builds stop at VALIDATION_BUDGET seconds (1800): the objectives left get "not-validated".
# Result: ${THEJOB_OUT_PATH}/validation-<step>-<attempt>.json; the outcome and output of every execution are an
# artefact (<step>/<attempt>-validation). Commits without the catalogue are recorded as unsupported.

# tlspuffin's oracle matching (puffin::outcome::matches), on the outcome JSON of `execute --outcome`
VALIDATION_JQ='def matches($o): . as $out | $o != null
  and (($o.kind == "claim" and $out.outcome == "claim") or ($o.kind == "crash" and $out.outcome == "crash"))
  and ($o.signal == null or $o.signal == $out.signal)
  and ($o.asan == null or $o.asan == ($out.asan.type // null))
  and ($o.violation == null or $o.violation == $out.violation)
  and ($o.panic == null or $o.panic == $out.panic);
def objective: .outcome == "crash" or .outcome == "claim";'

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

# ValidationError <file> <message> <tree>: a validation that could not be done, recorded (the campaign's attempt
# does not fail for it)
ValidationError() {
  echo "Validation: $2";
  jq -n --arg e "$2" '{ error: $e, objectives: [] }' > "$1";
  git -C "${THEJOB_OUT_PATH}/repo" worktree remove --force "$3" > /dev/null 2>&1;
  return 0;
}

# ValidationExecute <binary> <put> <trace> <tag>: one execution of an objective; prints its outcome (one JSON line)
ValidationExecute() {
  local binary="$1" put="$2" trace="$3" tag="$4";
  local file="${VALIDATION_WORK}/runs/${tag}.json";
  # shellcheck disable=SC2086 # LAUNCH_FLAGS and LAUNCH_NOASLR are word lists
  ASAN_OPTIONS="${VALIDATION_ASAN_OPTIONS}" timeout -k 10 "${VALIDATION_TIMEOUT:-120}" ${LAUNCH_NOASLR:-} \
    "${binary}" --put "${put}" ${LAUNCH_FLAGS:-} execute --outcome "${file}" "${trace}" \
    < /dev/null > "${VALIDATION_WORK}/runs/${tag}.log" 2>&1;
  jq -c '.[0].outcome // empty' "${file}" 2> /dev/null | grep . ||
    echo '{"outcome":"error","message":"no outcome (see the log of the execution)"}';
}

# ValidationRuns <binary> <put> <trace> <tag>: up to VALIDATION_RUNS executions, until one gives an objective; prints
# the outcomes as a JSON array
ValidationRuns() {
  local outcomes='[]' run outcome;
  for (( run = 1; run <= ${VALIDATION_RUNS:-3}; run++ )); do
    outcome=$( ValidationExecute "$1" "$2" "$3" "$4-${run}" );
    outcomes=$( jq -c --argjson o "${outcome}" '. + [$o]' <<< "${outcomes}" );
    jq -e "${VALIDATION_JQ} objective" <<< "${outcome}" > /dev/null && break;
  done
  echo "${outcomes}";
}

ValidateObjectives() {
  local out="${THEJOB_OUT_PATH}/validation-${THEJOB_STEP_ID}-${THEJOB_STEP_ATTEMPT_ID}.json";
  if [ "${VALIDATION:-on}" == off ]; then
    jq -n '{ skipped: "VALIDATION=off" }' > "${out}"; return 0;
  fi
  local experiment; experiment=$( ls -d ./experiments/*/ 2> /dev/null | head -1 );
  local -a traces=();
  if [ -n "${experiment}" ] && [ -d "${experiment}objective" ]; then
    # the targeted objectives first (ExperimentEnd's .targeted-names), then by time, at most VALIDATION_MAX
    mapfile -t traces < <(
      { [ -s "${experiment}.targeted-names" ] && sed "s|^|${experiment}objective/|; s|$|.trace|" "${experiment}.targeted-names";
        find "${experiment}objective" -maxdepth 1 -type f -name '*.trace' ! -name '.*' -printf '%T@ %p\n' | sort -n | cut -d' ' -f2-; } |
      awk '!seen[$0]++' | while read -r t; do [ -f "${t}" ] && echo "${t}"; done | head -n "${VALIDATION_MAX:-20}" );
  fi
  if (( ${#traces[@]} == 0 )); then
    jq -n '{ objectives: [], note: "no objective" }' > "${out}"; return 0;
  fi

  export VALIDATION_WORK="${PWD}/validation";
  rm -rf "${VALIDATION_WORK}"; mkdir -p "${VALIDATION_WORK}/runs";
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
    echo "Validation: ${unsupported}";
    jq -n --arg u "${unsupported}" --argjson n "${#traces[@]}" '{ unsupported: $u, total: $n, objectives: [] }' > "${out}";
    git -C "${repo}" worktree remove --force "${tree}" > /dev/null 2>&1;
    return 0;
  fi

  # the validation set and the binary bundling it (cached per commit, catalogue and preset)
  export VENDOR_DIR="${VALIDATION_WORK}/vendor";
  ( cd "${tree}" && nix-shell --run "./tools/mk_vendor list '${vendor}' --json" ) > "${VALIDATION_WORK}/list.json" ||
    { ValidationError "${out}" "mk_vendor list ${vendor} failed" "${tree}"; return 0; };
  # a build derived from the catalogue (<vendor>:<ID>, <preset>-only-<IDs>, -fix-…: custom benchmarks): the validation
  # set of its base preset, shared with every experiment on that preset
  local base; base=$( jq -r '.derived.base // empty' "${VALIDATION_WORK}/list.json" );
  command cp -f "${VALIDATION_WORK}/list.json" "${VALIDATION_WORK}/list-build.json";
  if [ -n "${base}" ]; then
    preset="${base}";
    ( cd "${tree}" && nix-shell --run "./tools/mk_vendor list '${lib}:${base}' --json" ) > "${VALIDATION_WORK}/list.json" ||
      { ValidationError "${out}" "mk_vendor list ${lib}:${base} failed" "${tree}"; return 0; };
  fi
  local -a builds; mapfile -t builds < <( jq -r '.validation_set[]' "${VALIDATION_WORK}/list.json" );
  local fixAll="${preset}-fix-all";
  local cacheId="validation-$( printf '%s %s %s %s' "${COMMIT_ID}" "$( jq -r .catalogue "${VALIDATION_WORK}/list.json" )" "${lib}:${preset}" "${builds[*]}" | md5sum | cut -d' ' -f1 )";
  local binary; binary=$( QueryCache -q "${cacheId}" ) || binary='';
  if [ -z "${binary}" ] || [ ! -x "${binary}" ]; then
    local build;
    for build in "${builds[@]}"; do
      ( cd "${tree}" && nix-shell --run "./tools/mk_vendor make --asan '${lib}:${build}'" ) ||
        { ValidationError "${out}" "cannot build ${lib}:${build}" "${tree}"; return 0; };
    done
    ( cd "${tree}" && nix-shell --run "cargo build --bin tlspuffin --release --features=cputs -j ${THEJOB_NB_CORES:-1}" ) ||
      { ValidationError "${out}" "cannot build the validation binary" "${tree}"; return 0; };
    binary="${tree}/target/release/tlspuffin";
    SetCache "${cacheId}" "${binary}" > /dev/null;
    local cached=true;
  fi
  echo "Validation set of ${vendor}: ${builds[*]} (binary ${binary})";
  # the binary reads its catalogue at run time: that of this checkout (a cached binary was built in another one; same
  # commit and catalogue, they are in the cache key)
  local -x PUFFIN_BUILD_DIR="${tree}/puffin-build";

  # the launch of the campaign (flags, ASLR); ASan options of the campaign, else tlspuffin's defaults
  local LAUNCH_FLAGS='' LAUNCH_NOASLR='' LAUNCH_ASAN_SET=false LAUNCH_ASAN_OPTIONS='';
  # shellcheck disable=SC1091
  [ -r .currentlaunch ] && source .currentlaunch;
  export VALIDATION_ASAN_OPTIONS="verify_asan_link_order=1:detect_leaks=0:abort_on_error=1";
  [ "${LAUNCH_ASAN_SET}" == true ] && [ -n "${LAUNCH_ASAN_OPTIONS}" ] && VALIDATION_ASAN_OPTIONS="${LAUNCH_ASAN_OPTIONS}";

  # candidates: the active bugs with a patch, whose objectives replay; known bugs left active everywhere: no patch
  local candidates unpatched;
  candidates=$( jq -c '[.entries[] | select(.state == "active" and .patchable and .replayable)]' "${VALIDATION_WORK}/list.json" );
  unpatched=$( jq -c '[.entries[] | select(.state == "active" and (.patchable | not))]' "${VALIDATION_WORK}/list.json" );

  local budgetStart=${SECONDS};
  # controls: each candidate's witness, when this commit has one
  local witnesses; witnesses=$( ASAN_OPTIONS="${VALIDATION_ASAN_OPTIONS}" "${binary}" catalogue --json 2> /dev/null | jq -c '[.witnesses[].entry] | unique' ) || witnesses='[]';
  local controls='[]' id;
  for id in $( jq -r '.[].id' <<< "${candidates}" ); do
    if ! jq -e --arg id "${id}" 'index($id) != null' <<< "${witnesses}" > /dev/null; then
      controls=$( jq -c --arg id "${id}" '. + [{ entry: $id, ok: null, note: "no witness at this commit" }]' <<< "${controls}" ); continue;
    fi
    local put good bad;
    for put in "${preset}-only-${id}" "${fixAll}"; do
      ASAN_OPTIONS="${VALIDATION_ASAN_OPTIONS}" timeout -k 10 "${VALIDATION_TIMEOUT:-120}" "${binary}" --put "${put}" witness "${id}" \
        --runs "${VALIDATION_RUNS:-3}" --outcome "${VALIDATION_WORK}/runs/control-${id}-${put}.json" \
        < /dev/null > "${VALIDATION_WORK}/runs/control-${id}-${put}.log" 2>&1;
    done
    good=$( jq -c '[.[].matches_oracle] | any' "${VALIDATION_WORK}/runs/control-${id}-${preset}-only-${id}.json" 2> /dev/null || echo null );
    bad=$( jq -c '[.[].matches_oracle] | any' "${VALIDATION_WORK}/runs/control-${id}-${fixAll}.json" 2> /dev/null || echo null );
    controls=$( jq -c --arg id "${id}" --argjson good "${good}" --argjson bad "${bad}" \
      '. + [{ entry: $id, triggers_unpatched: $good, triggers_patched: $bad, ok: ($good == true and $bad == false) }]' <<< "${controls}" );
  done

  # the verdict of each objective, within the budget (counted from the controls: the builds are cached)
  local results='[]' trace n=0;
  for trace in "${traces[@]}"; do
    n=$(( n + 1 ));
    local name; name=$( basename "${trace}" .trace );
    if (( SECONDS - budgetStart >= ${VALIDATION_BUDGET:-1800} )); then
      echo "Validation: ${name}: not validated (budget of ${VALIDATION_BUDGET:-1800} s spent)";
      results=$( jq -c --arg t "${name}" '. + [{ trace: $t, verdict: "not-validated", entries: [], note: "validation budget spent" }]' <<< "${results}" );
      continue;
    fi
    local onF; onF=$( ValidationRuns "${binary}" "${fixAll}" "${trace}" "${n}-F" );
    local result;
    if jq -e "${VALIDATION_JQ} any(.[]; objective)" <<< "${onF}" > /dev/null; then
      result=$( jq -c --arg t "${name}" --argjson f "${onF}" --argjson unpatched "${unpatched}" "${VALIDATION_JQ}
        ([\$f[] | select(objective)][0]) as \$o
        | { trace: \$t, verdict: \"not-patched\", entries: [], known_unpatched: [\$unpatched[] | select(.oracle as \$or | \$o | matches(\$or)) | .id], f: \$f }" <<< 'null' );
    else
      local onV='{}';
      for id in $( jq -r '.[].id' <<< "${candidates}" ); do
        onV=$( jq -c --arg id "${id}" --argjson runs "$( ValidationRuns "${binary}" "${preset}-only-${id}" "${trace}" "${n}-${id}" )" '. + { ($id): $runs }' <<< "${onV}" );
      done
      result=$( jq -c --arg t "${name}" --argjson f "${onF}" --argjson v "${onV}" --argjson candidates "${candidates}" "${VALIDATION_JQ}
        [\$candidates[] | .id as \$id | .oracle as \$or | select(any(\$v[\$id][]?; matches(\$or))) | \$id] as \$confirmed
        | [\$candidates[] | .id as \$id | .oracle as \$or | select((any(\$v[\$id][]?; matches(\$or)) | not) and any(\$v[\$id][]?; objective)) | \$id] as \$other
        | { trace: \$t, verdict: (if (\$confirmed | length) > 0 then \"confirmed\" elif (\$other | length) > 0 then \"other-signature\" else \"inconclusive\" end),
            entries: \$confirmed, other_signature: \$other, f: \$f, v: \$v }" <<< 'null' );
    fi
    echo "Validation: ${name}: $( jq -r '.verdict + (if (.entries | length) > 0 then " " + (.entries | join(", ")) else "" end)' <<< "${result}" )";
    results=$( jq -c --argjson r "${result}" '. + [$r]' <<< "${results}" );
  done

  jq -n --arg commit "${COMMIT_ID}" --arg vendor "${vendor}" --arg source "${source}" --arg catalogueCommit "${catalogueCommit}" \
    --argjson total "$( find "${experiment}objective" -maxdepth 1 -type f -name '*.trace' ! -name '.*' | wc -l )" \
    --slurpfile list "${VALIDATION_WORK}/list.json" --slurpfile build "${VALIDATION_WORK}/list-build.json" \
    --arg validatedOn "${lib}:${preset}" --argjson controls "${controls}" --argjson results "${results}" \
    '{ commit: $commit, vendor: $vendor, catalogue: { source: $source, commit: $catalogueCommit, hash: $list[0].catalogue },
       build: { name: $build[0].name, derived: $build[0].derived, fix: $build[0].fix, asan: $build[0].asan,
                states: ($build[0].entries | map({ (.id): .state }) | add) },
       validated_on: $validatedOn, builds: $list[0].validation_set, entries: ($list[0].entries | map({ (.id): { state, patchable, hash, build_hash, alias, oracle } }) | add),
       controls: $controls, controls_ok: ([$controls[].ok | select(. != null)] | all), total: $total, objectives: $results }' > "${out}" || return 1;
  CreateArtefact "${VALIDATION_WORK}/runs" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-validation" "commit_id:${COMMIT_ID}";
  # the cache copies the binary in the background: the checkout goes once the copy is there
  if [ "${cached:-false}" == true ]; then
    local wait;
    for (( wait = 0; wait < 120; wait += 2 )); do QueryCache -q "${cacheId}" > /dev/null && break; sleep 2; done
  fi
  git -C "${repo}" worktree remove --force "${tree}" > /dev/null 2>&1;
  echo "Validation: $( jq -r '"\(.objectives | length) of \(.total) objectives: " + ([.objectives[] | .verdict] | group_by(.) | map("\(length) \(.[0])") | join(", ")) + (if .controls_ok then "" else " (controls failed)" end)' "${out}" )";
  return 0;
}
