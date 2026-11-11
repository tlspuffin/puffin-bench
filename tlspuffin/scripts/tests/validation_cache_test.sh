#!/bin/bash
# validation_cache_test.sh: what the preparation of a validation (ValidationPrepare, PR_validate.sh) builds, on a
# fake tlspuffin (nix-shell, mk_vendor, cargo and the binary are stand-ins that record what they are asked):
#   - the libraries of a validation set are built once, into a folder shared by the tasks and named after what they are
#     made from: another commit that changes neither puffin-build's build code nor the vendor's files reuses them;
#   - the binary is cached per what it is made from: a commit that changes only the documentation reuses it, one that
#     changes the Rust code builds it again (not the libraries); a change of a vendor's patch builds both;
#   - a library folder no task used for 30 days goes.
# Quick: nothing is really built.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

# a tlspuffin with a catalogue: commit A, then B (documentation only), C (Rust code), D (a patch of the vendor)
src="${work}/tlspuffin"
mkdir -p "${src}/puffin-build/vendors/wolfssl/patches" "${src}/puffin-build/src/tools" "${src}/puffin-build/cmake" \
  "${src}/tlspuffin/src" "${src}/docs" "${src}/tools"
echo '[CVE-1]' > "${src}/puffin-build/vendors/wolfssl/vulnerabilities.toml"
echo 'fix 1' > "${src}/puffin-build/vendors/wolfssl/patches/fix-1.patch"
echo 'fn main() { CheckPatches }' > "${src}/puffin-build/src/tools/mk_vendor.rs"
echo 'cmake' > "${src}/puffin-build/cmake/run.cmake"
echo 'fn main() {}' > "${src}/tlspuffin/src/main.rs"
echo 'docs' > "${src}/docs/README.md"
echo '#!/bin/bash' > "${src}/tools/mk_vendor"
echo 'shell' > "${src}/shell.nix"
git -C "${src}" init -q && git -C "${src}" -c user.name=t -c user.email=t@t add -A && git -C "${src}" -c user.name=t -c user.email=t@t commit -qm A
A=$( git -C "${src}" rev-parse HEAD )
echo 'more docs' >> "${src}/docs/README.md"; git -C "${src}" -c user.name=t -c user.email=t@t commit -qam B; B=$( git -C "${src}" rev-parse HEAD )
echo 'fn main() { 1 }' > "${src}/tlspuffin/src/main.rs"; git -C "${src}" -c user.name=t -c user.email=t@t commit -qam C; C=$( git -C "${src}" rev-parse HEAD )
echo 'fix 1 again' > "${src}/puffin-build/vendors/wolfssl/patches/fix-1.patch"; git -C "${src}" -c user.name=t -c user.email=t@t commit -qam D; D=$( git -C "${src}" rev-parse HEAD )

# stand-ins: nix-shell runs the command it is given against them; each records what it does in ${work}/calls
mkdir -p "${work}/bin"
cat > "${work}/bin/nix-shell" <<'EOF'
#!/bin/bash
[ "$1" == --run ] && shift
cmd="$1"
case "${cmd}" in
  *"mk_vendor list"*)
    echo '{"catalogue":"cat1","derived":null,"validation_set":["p-fix-all","p-only-CVE-1"],
           "entries":[{"id":"CVE-1","state":"active","patchable":true,"replayable":true}]}';;
  *"mk_vendor make"*)
    build=$( sed -E "s/.*'[a-z]+:([^']+)'.*/\1/" <<< "${cmd}" )
    if [ -d "${VENDOR_DIR}/${build}" ]; then echo "reuse ${build}" >> "${CALLS}"; else mkdir -p "${VENDOR_DIR}/${build}"; echo "build ${build} in $( basename "${VENDOR_DIR}" )" >> "${CALLS}"; fi;;
  *"cargo build"*)
    echo "cargo $( git rev-parse --short HEAD )" >> "${CALLS}"
    mkdir -p target/release
    printf '#!/bin/bash\n[ "$1" == catalogue ] && echo "{\\"witnesses\\": []}"\nexit 0\n' > target/release/tlspuffin
    chmod +x target/release/tlspuffin;;
esac
EOF
chmod +x "${work}/bin/nix-shell"
export PATH="${work}/bin:${PATH}" CALLS="${work}/calls"
: > "${CALLS}"

mkdir -p "${work}/cache" "${work}/out" "${work}/libs"
QueryCache() { [ "$1" == -q ] && shift; [ -f "${work}/cache/$1" ] || return 1; echo "${work}/cache/$1"; }
SetCache() { command cp -f "$2" "${work}/cache/$1"; echo "${work}/cache/$1"; }
git clone -q "${src}" "${work}/out/repo"
export THEJOB_OUT_PATH="${work}/out" THEJOB_NB_CORES=1 VALIDATION_LIBS_ROOT="${work}/libs" VALIDATION_CATALOGUE=commit
vendor=wolfssl:p
# shellcheck source=../PR_validate.sh
source "${here}/../PR_validate.sh"

# Prepare <commit>: the preparation of one attempt on that commit, in a step folder of its own
Prepare() {
  COMMIT_ID="$1"; local dir="${work}/step-$1"
  mkdir -p "${dir}" && cd "${dir}" && ValidationPrepare > /dev/null 2>&1; cd "${work}"
  jq -r .status "${dir}/validation/state.json"
}
calls() { grep -c "$1" "${CALLS}" || true; }

check 'commit A: ready' '[ "$( Prepare "${A}" )" == ready ]'
check 'commit A: both libraries and the binary built' '[ "$( calls "^build " )" == 2 ] && [ "$( calls "^cargo " )" == 1 ]'
check 'the libraries in a shared folder, outside the attempt' '[ "$( find "${work}/libs" -mindepth 2 -maxdepth 2 -name "p-*" | wc -l )" == 2 ]'
dirA=$( find "${work}/libs" -mindepth 1 -maxdepth 1 -type d )
: > "${CALLS}"
check 'commit B (documentation only): ready' '[ "$( Prepare "${B}" )" == ready ]'
check 'commit B: nothing built (the binary from the cache)' '! grep -q "^build \|^cargo " "${CALLS}"'
: > "${CALLS}"
check 'commit C (Rust code): ready' '[ "$( Prepare "${C}" )" == ready ]'
check 'commit C: the binary built again, the libraries reused' '[ "$( calls "^cargo " )" == 1 ] && [ "$( calls "^build " )" == 0 ] && [ "$( calls "^reuse " )" == 2 ]'
: > "${CALLS}"
check 'commit D (a patch of the vendor): ready' '[ "$( Prepare "${D}" )" == ready ]'
check 'commit D: libraries and binary built again, in another folder' '[ "$( calls "^build " )" == 2 ] && [ "$( calls "^cargo " )" == 1 ] && [ "$( find "${work}/libs" -mindepth 1 -maxdepth 1 -type d | wc -l )" == 2 ]'
# the folder of commit D, unused for 40 days, goes at the next preparation (of B: the folder of A, kept)
dirD=$( find "${work}/libs" -mindepth 1 -maxdepth 1 -type d ! -path "${dirA}" )
touch -d '-40 days' "${dirD}/.used"
rm -rf "${work}/step-${B}"   # another attempt (a step prepares once)
Prepare "${B}" > /dev/null
check 'a library folder unused for 30 days goes, the one in use stays' '[ ! -d "${dirD}" ] && [ -d "${dirA}/p-fix-all" ]'
exit "${fail}"
