#!/bin/bash
# presets_builds_test.sh: what git_restapi's presets of a tlspuffin commit (scripts/tlspuffin_presets.sh) say of its
# builds, for the launcher's picker. On a repository made here:
#   - format 2: each build's kind, "version" (the build of a version, plain or with ASan) or "alias" (a named build of
#     [aliases], with its definition: "spec"); each vendor's modifiers ([modifiers]: default, doc);
#   - names: the commit's puffin-build has the names of builds (puffin-build/src/catalogue/spec.rs, tlspuffin
#     54b07f490); derived: its mk_vendor builds the catalogue's derived builds (DERIVED_ONLY, tlspuffin 17a624fcc);
#     neither before;
#   - format 1: every build a "preset", no modifiers.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
bench=$( cd "${here}/../../.." && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
repo="${work}/repo"; mkdir -p "${repo}/puffin-build/vendors/wolfssl" "${repo}/puffin-build/vendors/old"
cat > "${repo}/puffin-build/vendors/wolfssl/presets.toml" <<'TOML'
format = 2
[library]
repo = "https://example.org/wolfssl.git"
builder = "wolfssl"
ref = "v{version}-stable"
[versions]
"5.4.0" = {}
[modifiers]
asan = { default = false, doc = "AddressSanitizer" }
sancov = { default = true, doc = "coverage" }
postauth = { default = true, doc = "--enable-postauth" }
[aliases]
wolfssl540-heap = "5.4.0,asan,fix-CVE-2022-39173"
wolfssl540-sdos2 = "5.4.0,no-postauth,fix-CVE-2022-39173"
TOML
printf '[old540]\nasan = true\nfix = ["X"]\n[old540.sources]\nversion = "5.4.0"\n' > "${repo}/puffin-build/vendors/old/presets.toml"
git -C "${repo}" init -q && git -C "${repo}" add -A && git -C "${repo}" -c user.name=t -c user.email=t@t commit -q -m before
before=$( git -C "${repo}" rev-parse HEAD )
mkdir -p "${repo}/puffin-build/src/catalogue"
echo '//! names' > "${repo}/puffin-build/src/catalogue/spec.rs"
echo 'pub const DERIVED_ONLY: &str = "-only-";' > "${repo}/puffin-build/src/catalogue/mod.rs"
git -C "${repo}" add -A && git -C "${repo}" -c user.name=t -c user.email=t@t commit -q -m names
out=$( bash "${bench}/git_restapi/scripts/tlspuffin_presets.sh" "${repo}" HEAD )
kinds=$( jq -c '[.vendors.wolfssl[] | [.name, .kind, .spec]]' <<< "${out}" )
check 'format 2: the builds of a version ("version"), the aliases with their definitions ("alias", spec)' \
  '[ "${kinds}" == "[[\"wolfssl540\",\"version\",null],[\"wolfssl540-asan\",\"version\",null],[\"wolfssl540-heap\",\"alias\",\"5.4.0,asan,fix-CVE-2022-39173\"],[\"wolfssl540-sdos2\",\"alias\",\"5.4.0,no-postauth,fix-CVE-2022-39173\"]]" ]'
check "format 2: the vendor's modifiers, with their default and doc" \
  '[ "$( jq -c .modifiers.wolfssl <<< "${out}" )" == "{\"asan\":{\"default\":false,\"doc\":\"AddressSanitizer\"},\"sancov\":{\"default\":true,\"doc\":\"coverage\"},\"postauth\":{\"default\":true,\"doc\":\"--enable-postauth\"}}" ]'
check "a commit with puffin-build's names and derived builds: names, derived" '[ "$( jq -c "[.names, .derived]" <<< "${out}" )" == "[true,true]" ]'
old=$( bash "${bench}/git_restapi/scripts/tlspuffin_presets.sh" "${repo}" "${before}" )
check 'before them: neither' '[ "$( jq -c "[.names, .derived]" <<< "${old}" )" == "[false,false]" ]'
check 'format 1: every build a preset, no modifiers' \
  '[ "$( jq -c "[.vendors.old[] | .kind]" <<< "${old}" )" == "[\"preset\"]" ] && [ "$( jq -c ".modifiers | has(\"old\")" <<< "${old}" )" == false ]'
exit "${fail}"
