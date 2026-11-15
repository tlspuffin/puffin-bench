#!/bin/bash
# vendor_build_test.sh: a vendor library that does not build stops the build (PR_common.sh MakeVendor, in ForcedBuild,
# so BuildOnce, and in Build). Before, the build went on: tlspuffin was built without the library (no PUT for it) and
# the experiments started on the fuzzer's default PUT, tcp, every client exiting at once (the campaigns of 2026-11-15,
# whose build folder had a comma, where mk_vendor's patch step cut the path).
#   - mk_vendor failing: ForcedBuild and Build stop (status 1) before cargo, saying so;
#   - mk_vendor building: they go on to cargo, as before; a bug only seen with ASan (asan_build) gives mk_vendor --asan;
#   - an attempt of an experiment whose build failed: stops at once, saying the build failed (SharedRunDir).
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; echo "${out}" | sed 's/^/     /'; fail=1; fi; }
source <( sed -n '/^MakeVendor()/,/^}/p; /^ForcedBuild()/,/^}/p; /^Build()/,/^}/p; /^SharedBuildDir()/p; /^SharedRunDir()/,/^}/p' \
  "${here}/../PR_common.sh" )
# what the build needs around it, stood in: a C harness vendor, no compat rule, the records of the binary, no cache
ComputeBuildRuntimeInfo() { local -n c=$4; c=true; }
StripDebugAranges() { :; }
CompatVerifyHelp() { :; }
NoAslrPrefix() { :; }
DetectAsan() { local -n a=$4; a='{}'; }
DetectVendorSources() { local -n s=$1; s='[]'; }
DetectVendorVulnerabilities() { echo null; }
QueryCache() { return 1; }
SetCache() { :; }
# nix-shell: its commands recorded; mk_vendor fails when MK_FAIL is set; cargo leaves a binary
mkdir -p "${work}/bin" "${work}/out/repo"
cat > "${work}/bin/nix-shell" <<EOF
#!/bin/sh
echo "\$*" >> "${work}/nix.calls"
case "\$*" in *"mk_vendor make"*) [ -z "\${MK_FAIL:-}" ] || { echo "error: cannot open patch '/x/build-584'" >&2; exit 1; } ;; esac
case "\$*" in *cargo*) mkdir -p target/release && printf '#!/bin/sh\n' > target/release/tlspuffin && chmod +x target/release/tlspuffin ;; esac
exit 0
EOF
chmod +x "${work}/bin/nix-shell"
export PATH="${work}/bin:${PATH}" THEJOB_OUT_PATH="${work}/out" THEJOB_STEP_ID=wolfssl584-asan THEJOB_NB_CORES=2
export vendor=wolfssl:wolfssl584-asan features=cputs experiment=wolfssl:wolfssl584-asan PACKAGE=tlspuffin COMMIT_ID=abc
export PREFIX_FAKETIME='' COMPAT_UNSUPPORTED='' extra_flags=''
run() {  # run <name> <function>: the function in a folder of its own, its output and status
  rm -f "${work}/nix.calls"; mkdir -p "${work}/$1"
  out=$( cd "${work}/$1" && "$2" 2>&1 ) && rc=0 || rc=$?
  calls=$( cat "${work}/nix.calls" 2> /dev/null || true )
}

MK_FAIL=1 run forced-fail ForcedBuild
check 'mk_vendor failing: ForcedBuild stops (status 1) before cargo, saying so' \
  '[ "${rc}" -eq 1 ] && grep -q "mk_vendor could not build wolfssl:wolfssl584-asan (its error above): the build stops here" <<< "${out}" && ! grep -q cargo <<< "${calls}"'
run forced-ok ForcedBuild
check 'mk_vendor building: ForcedBuild goes on to cargo, as before' \
  '[ "${rc}" -eq 0 ] && grep -q "mk_vendor make '"'"'wolfssl:wolfssl584-asan'"'"'" <<< "${calls}" && grep -q "cargo run --release --bin" <<< "${calls}"'
asan_build=true run forced-asan ForcedBuild
check 'a bug only seen with ASan (asan_build): mk_vendor make --asan' \
  '[ "${rc}" -eq 0 ] && grep -q "mk_vendor make --asan '"'"'wolfssl:wolfssl584-asan'"'"'" <<< "${calls}"'
MK_FAIL=1 run cached-fail Build
check 'mk_vendor failing: Build (the cached build) stops (status 1) before cargo, saying so' \
  '[ "${rc}" -eq 1 ] && grep -q "mk_vendor could not build" <<< "${out}" && ! grep -q cargo <<< "${calls}"'
run cached-ok Build
check 'mk_vendor building: Build goes on to cargo, its binary kept, as before' \
  '[ "${rc}" -eq 0 ] && grep -q "cargo build --bin" <<< "${calls}" && [ -x "${THEJOB_OUT_PATH}/tlspuffin-wolfssl584-asan" ]'
# BuildOnce's folder without a binary (its build failed): the attempt stops at once, saying so
mkdir -p "$( SharedBuildDir )" "${work}/attempt" && cd "${work}/attempt"
out=$( SharedRunDir 2>&1 ) && rc=0 || rc=$?
check 'an attempt of an experiment whose build failed: stops at once, saying the build failed' \
  '[ "${rc}" -eq 1 ] && grep -q "the experiment'"'"'s build (BuildOnce) failed" <<< "${out}"'
exit "${fail}"
