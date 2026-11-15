#!/bin/bash
# shared_build_test.sh: one build per experiment (PR_common.sh BuildOnce, a group of the flows run once per configuration
# before its attempts: Vuln group A and B, custom benchmarks, campaigns, as Perf): each attempt works from it
# (SharedRunDir: its binary, seeds, vendor libraries and cargo configuration linked, its records copied) and runs its
# binary directly, as cargo run would (ExperimentRunWithCargo: the ASAN_OPTIONS of its cargo configuration, the launch
# record the replays read); a flow without it runs cargo in the attempt's own build, as before. Before, every attempt
# of a Vuln experiment or a campaign built the same library and tlspuffin, at the same time.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
source <( sed -n '/^SharedBuildDir()/p; /^SharedRunDir()/,/^}/p; /^ExperimentRunWithCargo()/,/^}/p; /^CargoAsanOptions()/,/^}/p; /^ExperimentSaveExecution()/,/^}/p' "${here}/../PR_common.sh" )
# what the launch needs around it, stood in: the run's setup (cores), the compat rules, the launch info, the monitor
ExperimentSetupForCargo() { local -n lc=$1; lc=1; RESERVED_PORT=4242; }
CompatApplyFlags() { local -n f=$1; f='--flag'; }
CompatApplyFiles() { :; }
ExperimentSaveLaunchInfo() { :; }
ExperimentPostLaunchSetup() { :; }
NoAslrPrefix() { :; }
mkdir -p "${work}/bin"; printf '#!/bin/sh\necho "nix-shell $*" >> "%s/nix.calls"\n' "${work}" > "${work}/bin/nix-shell"; chmod +x "${work}/bin/nix-shell"
export PATH="${work}/bin:${PATH}" THEJOB_OUT_PATH="${work}/out" THEJOB_STEP_ID=BUF THEJOB_STEP_UUID=u THEJOB_CORES=3,4 AFL_CORES_GRAMMAR=1
export features=cputs vendor=wolfssl:wolfssl540-buf experiment=BUF PACKAGE=tlspuffin PREFIX_FAKETIME=''
# the experiment's build (BuildOnce): binary, seeds, vendor, cargo configuration, records
build="${THEJOB_OUT_PATH}/build-BUF"
mkdir -p "${build}/target/release" "${build}/seeds" "${build}/vendor" "${build}/.cargo"
printf '#!/bin/sh\n' > "${build}/target/release/tlspuffin"; chmod +x "${build}/target/release/tlspuffin"
printf '[env]\nASAN_OPTIONS = "detect_leaks=0:abort_on_error=1"\n' > "${build}/.cargo/config.toml"
echo '{"instrumented":true}' > "${build}/.asan_info.json"; echo 'nix' > "${build}/shell.nix"
# an attempt: from the shared build, its binary run directly
mkdir -p "${work}/attempt0" && cd "${work}/attempt0"
pid=0; killed=0; stats=''; rc=0
( unset ASAN_OPTIONS; ExperimentRunWithCargo pid killed stats 0; wait ) > "${work}/run.log" 2>&1 || rc=$?
check 'an attempt: the build linked (binary, seeds, vendor, cargo configuration), its records copied' \
  '[ "$( readlink target )" == "${build}/target" ] && [ -L seeds ] && [ -L vendor ] && [ -L .cargo ] && [ -s .asan_info.json ] && [ -s shell.nix ]'
check 'its binary run directly, no cargo (one build for the experiment)' \
  '[ "${rc}" -eq 0 ] && grep -q "exec  \"./target/release/tlspuffin\" --cores 3,4 --port 4242 --flag experiment -d \"BUF\"" "${work}/nix.calls" && ! grep -q "cargo" "${work}/nix.calls"'
check 'what the replays run: the shared binary, with the ASAN_OPTIONS of its cargo configuration' \
  '[ "$( cat .currentcmd )" == "exec  ./target/release/tlspuffin" ] && grep -q "^LAUNCH_BINARY=${build}/target/release/tlspuffin$" .currentlaunch && grep -q "^LAUNCH_ASAN_OPTIONS=detect_leaks=0:abort_on_error=1$" .currentlaunch'
# a flow without BuildOnce: cargo run in the attempt's own build, as before
rm -f "${work}/nix.calls"; mkdir -p "${work}/attempt1" && cd "${work}/attempt1"
( THEJOB_STEP_ID=OTHER; ExperimentRunWithCargo pid killed stats 0; wait ) > /dev/null 2>&1 || true
check 'without the shared build: cargo run, as before' 'grep -q "cargo run --bin \"tlspuffin\" --release --features=cputs" "${work}/nix.calls" && [ ! -L target ]'
# an experiment that cannot run (ForcedBuild: .unsupported in the build): the attempt says so and stops
echo 'CVE-X is not in wolfssl540-buf (fixed): nothing to look for' > "${build}/.unsupported"
rm -f "${work}/nix.calls"; mkdir -p "${work}/attempt2" && cd "${work}/attempt2"
rc=0; out=$( ExperimentRunWithCargo pid killed stats 0 2>&1 ) || rc=$?
check 'an experiment that cannot run: the attempt stops at once, saying why, nothing launched' \
  '[ "${rc}" -eq 1 ] && grep -q "Unsupported: CVE-X is not in" <<< "${out}" && [ ! -e "${work}/nix.calls" ]'
# a campaign (PR_perf.sh ExperimentWithCargo): skipped, as an unsupported run always was
source <( sed -n '/^ExperimentWithCargo ()/,/^}/p' "${here}/../PR_perf.sh" )
mkdir -p "${work}/attempt3" && cd "${work}/attempt3"
out=$( ExperimentWithCargo 2>&1 ) && rc=0 || rc=$?
check 'a campaign attempt of it: skipped, as before' '[ "${rc}" -eq 0 ] && grep -q "Skipped: CVE-X" <<< "${out}"'
# the flows: one build per experiment, in the group run once before the attempts; none in an attempt
jobs="${here}/../../data/html/jobsscripts/tlspuffin"
for f in PR_vulnerabilities-groupA_cargo.json PR_vulnerabilities-groupB_cargo.json PR_vulnerabilities-custom_cargo.json PR_campaign.json; do
  shape=$( sed -e 's/\${RUNTIME_RUN_CONFIG}/{}/; s/\${RUNTIME_NB_CORES}/2/; s/\${RUNTIME_NB_RUN}/5/; s/\${RUNTIME_MEMORY_CORE}/1/; s/\${RUNTIME_MEMORY_CONSUMPTION}/1/' "${jobs}/${f}" |
    jq -c '[.flow[] | select(type == "array") | [.[0].configuration.nb_retry, ([.[] | .step? // empty] | index("BuildOnce") != null), ([.[] | .step? // empty] | index("ForcedBuild") != null)]]' )
  check "${f}: built once per experiment, before its attempts; never per attempt" '[[ "${shape}" == "[[1,true,false],["*",false,false]]" ]]'
done
exit "${fail}"
