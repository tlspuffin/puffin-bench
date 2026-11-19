#!/bin/bash
# vendor_names_test.sh: a vendor in puffin-build's short form (wolfssl:584,asan, tlspuffin 54b07f490 on) is named by its
# build's own name, mk_vendor's slug (wolfssl584-asan), wherever the job scripts make a path, a title or a description of
# it (PR_common.sh ResolveVendor, VendorSlug): before, "C harness, 584,asan", library version "584,asan", no release, no
# declared bugs (./vendor/584,asan), ASan "not requested", the experiment's folder "…wolfssl:584,asan…". On stand-ins:
#   - ResolveVendor keeps what `mk_vendor list --json` says (slug, canonical name, version, ASan); VendorSlug gives
#     wolfssl:wolfssl584-asan, a preset name stays as it is;
#   - a commit whose mk_vendor has no `list`, or no slug in it (before 54b07f490): nothing kept, every name as given;
#   - the run's record (ExperimentSetupForCargo, cli-<step>.json): build "C harness, wolfssl584-asan", library version
#     584 and release 5.8.4, ASan requested, the declared bugs, vendor_build; the vendor as given;
#   - ASan requested as mk_vendor says it (wolfssl540-heap has it, its name does not say so);
#   - the fuzzer's experiment named by the build when it is the vendor (a campaign); another experiment as it is.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
source <( sed -n '/^ResolveVendor()/,/^}/p; /^VendorResolvedFile()/,/^}/p; /^VendorSlug()/,/^}/p; /^VendorBuildJSON()/,/^}/p;
                  /^VendorRelease()/,/^}/p; /^DetectVendorVulnerabilities()/,/^}/p; /^BuildDescription()/,/^}/p;
                  /^DetectAsan()/,/^}/p; /^ExperimentTitle()/,/^}/p; /^ExperimentSetupForCargo()/,/^}/p' "${here}/../PR_common.sh" )
# nix-shell: mk_vendor list as tlspuffin 54b07f490 answers it; none at all with NO_LIST; no slug with NO_SLUG
mkdir -p "${work}/bin"
cat > "${work}/bin/nix-shell" <<'EOF'
#!/bin/bash
[ "$1" == --run ] && shift
case "$1" in
  *"mk_vendor list"*)
    [ -z "${NO_LIST:-}" ] || { echo "error: unknown command 'list'" >&2; exit 1; }
    name=$( sed -E "s/.*list '([^']+)'.*/\1/" <<< "$1" )
    case "${name}" in
      wolfssl:584,asan|wolfssl:5.8.4,asan|wolfssl:wolfssl584-asan)
        [ -n "${NO_SLUG:-}" ] && { echo '{"catalogue":"c","validation_set":[]}'; exit 0; }
        echo '{"vendor":"wolfssl","slug":"wolfssl584-asan","canonical":"wolfssl:5.8.4,asan","version":"5.8.4","asan":true,"fix":[],"validation_set":["wolfssl584-asan-fix-all"]}';;
      wolfssl:wolfssl540-heap)
        echo '{"vendor":"wolfssl","slug":"wolfssl540-heap","canonical":"wolfssl:5.4.0,asan,fix-CVE-2022-39173","version":"5.4.0","asan":true}';;
      wolfssl:wolfssl540-asan-nope)
        echo '{"vendor":"wolfssl","slug":"wolfssl540-asan-nope","canonical":"wolfssl:5.4.0,no-asan","version":"5.4.0","asan":false}';;
      *) echo "error: '${name}': not a build of wolfssl" >&2; exit 1;;
    esac;;
esac
exit 0
EOF
chmod +x "${work}/bin/nix-shell"
export PATH="${work}/bin:${PATH}" THEJOB_OUT_PATH="${work}/out"
# a checkout: its presets and mk_vendor (the stand-in answers for it)
mkdir -p "${work}/out" "${work}/build/puffin-build/vendors/wolfssl" "${work}/build/tools"
echo 'format = 2' > "${work}/build/puffin-build/vendors/wolfssl/presets.toml"
printf '#!/bin/sh\n' > "${work}/build/tools/mk_vendor"; chmod +x "${work}/build/tools/mk_vendor"
cd "${work}/build"

out=$( ResolveVendor wolfssl:584,asan )
check 'the short form: its build resolved (mk_vendor list), said' \
  '[ "$( VendorSlug wolfssl:584,asan )" == wolfssl:wolfssl584-asan ] && grep -q "The build of wolfssl:584,asan: wolfssl584-asan (wolfssl:5.8.4,asan)" <<< "${out}"'
check 'what is kept: slug, canonical name, version, ASan' \
  '[ "$( VendorBuildJSON wolfssl:584,asan )" == "{\"slug\":\"wolfssl584-asan\",\"canonical\":\"wolfssl:5.8.4,asan\",\"version\":\"5.8.4\",\"asan\":true,\"base\":null}" ]'
ResolveVendor wolfssl:wolfssl584-asan > /dev/null
check 'a preset name: its own slug' '[ "$( VendorSlug wolfssl:wolfssl584-asan )" == wolfssl:wolfssl584-asan ]'
ResolveVendor wolfssl:202403,asan > /dev/null
check 'a name mk_vendor refuses: nothing kept, the name as given (the build says why)' \
  '[ "$( VendorSlug wolfssl:202403,asan )" == wolfssl:202403,asan ] && [ "$( VendorBuildJSON wolfssl:202403,asan )" == null ]'
NO_LIST=1 ResolveVendor wolfssl:5.8.4,asan > /dev/null
check 'a commit whose mk_vendor has no list: nothing kept' '[ "$( VendorSlug wolfssl:5.8.4,asan )" == wolfssl:5.8.4,asan ]'
NO_SLUG=1 ResolveVendor wolfssl:5.8.4,asan > /dev/null
check 'a list without slug (before tlspuffin 54b07f490): nothing kept' '[ "$( VendorBuildJSON wolfssl:5.8.4,asan )" == null ]'
check 'a Rust harness feature (no library): as given' '[ "$( VendorSlug wolfssl540 )" == wolfssl540 ] && [ "$( ResolveVendor wolfssl540 )" == "" ]'
check 'without the task output folder: as given' '[ "$( THEJOB_OUT_PATH= VendorSlug wolfssl:584,asan )" == wolfssl:584,asan ]'

# the run's record of an attempt on wolfssl:584,asan (ExperimentSetupForCargo), what the build left: puffin-build's
# record of the library (its release), its vendorinfo.sh (the declared bugs)
mkdir -p "${work}/attempt/vendor/wolfssl584-asan/build" "${work}/tools" && cd "${work}/attempt"
printf '[sources]\nversion = "5.8.4"\n' > vendor/wolfssl584-asan/.vendor_config
printf 'KNOWN_VULNERABILITIES=( CVE-1 CVE-2 )\nFIXED_VULNERABILITIES=( CVE-2 )\n' > vendor/wolfssl584-asan/build/vendorinfo.sh
printf '#!/bin/sh\necho RESERVED_PORT=4242 RESERVED_PORT_PID=1\n' > "${work}/tools/reserve_port"; chmod +x "${work}/tools/reserve_port"
ipcrm() { :; }; NoAslrPrefix() { :; }; CpusInfo() { echo null; }; CompatAppliedJSON() { echo '[]'; }; CompatWarningJSON() { echo null; }
CustomExperimentJSON() { echo null; }
ComputeBuildRuntimeInfo() { local -n f=$3 c=$4; c=true; f=cputs; }
export THEJOB_TOOLS_PATH="${work}/tools" THEJOB_NB_CORES=2 THEJOB_STEP_ID=wolfssl584-asan THEJOB_STEP_ATTEMPT_ID=0
export THEJOB_USER_STATE_FILE="${work}/state" vendor=wolfssl:584,asan PACKAGE=tlspuffin PREFIX_FAKETIME='' extra_flags=''
lastCore=0; features=''
ExperimentSetupForCargo lastCore features > "${work}/setup.log" 2>&1 || { echo "FAIL ExperimentSetupForCargo"; cat "${work}/setup.log"; fail=1; }
record="${THEJOB_OUT_PATH}/cli-wolfssl584-asan.json"
check "the run's record: the build by its own name, the library's version and release" \
  '[ "$( jq -r .build "${record}" )" == "C harness, wolfssl584-asan" ] && [ "$( jq -c .library "${record}" )" == "{\"name\":\"wolfssl\",\"version\":\"584\",\"release\":\"5.8.4\"}" ]'
check "the run's record: the vendor as given, ASan requested, vendor_build" \
  '[ "$( jq -r .vendor "${record}" )" == wolfssl:584,asan ] && [ "$( jq -r .asan.requested "${record}" )" == true ] &&
   [ "$( jq -r .vendor_build.canonical "${record}" )" == wolfssl:5.8.4,asan ]'
check 'the bugs the build declares (DetectVendorVulnerabilities, for the record): from its vendorinfo.sh' \
  '[ "$( DetectVendorVulnerabilities wolfssl:584,asan )" == "{\"known\":[\"CVE-1\",\"CVE-2\"],\"fixed\":[\"CVE-2\"],\"declared\":[\"CVE-1\"]}" ]'
# ASan requested as mk_vendor says it, else as the name says it
cd "${work}/build"; ResolveVendor wolfssl:wolfssl540-heap > /dev/null; ResolveVendor wolfssl:wolfssl540-asan-nope > /dev/null
requested() { local info=''; DetectAsan /nonexistent "" "$1" info > /dev/null; jq -r .requested <<< "${info}"; }
check 'ASan requested as mk_vendor says it: wolfssl540-heap (its name does not say it) yes, a no-asan build no' \
  '[ "$( requested wolfssl:wolfssl540-heap )" == true ] && [ "$( requested wolfssl:wolfssl540-asan-nope )" == false ]'
check 'ASan requested, not resolved: by the name (wolfssl540-asan, 540,asan), as before' \
  '[ "$( requested wolfssl:wolfssl540-asan )" == true ] && [ "$( requested wolfssl:540,asan )" == true ] && [ "$( requested wolfssl:wolfssl540 )" == false ]'
# the fuzzer's experiment: the build's name when it is the vendor (a campaign), else its own
check 'a campaign (its experiment is its vendor): named by the build, no comma in its folder' \
  '[ "$( experiment=wolfssl:584,asan vendor=wolfssl:584,asan ExperimentTitle )" == wolfssl:wolfssl584-asan ]'
check 'another experiment (Vuln: its bug): as it is' \
  '[ "$( experiment=BUF vendor=wolfssl:584,asan ExperimentTitle )" == BUF ] && [ "$( experiment=wolfssl540 vendor= ExperimentTitle )" == wolfssl540 ]'
exit "${fail}"
