#!/bin/bash
# presets_latest_test.sh: git_restapi's presets of a tlspuffin commit (scripts/tlspuffin_presets.sh) give each vendor's
# latest release as its presets.toml declares it ([library] latest, one of [versions]), whose versions' names need not
# sort (BoringSSL's 1.1.1g+git.<commit> before 0.20260508.0); a vendor without it, or naming no version, has none (the
# launcher then sorts the names). On a repository made here.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
bench=$( cd "${here}/../../.." && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
repo="${work}/repo"; mkdir -p "${repo}"/puffin-build/vendors/{lib,old,typo}
modifiers='[modifiers]
asan = { default = false, doc = "ASan" }
sancov = { default = true, doc = "coverage" }'
cat > "${repo}/puffin-build/vendors/lib/presets.toml" <<TOML
format = 2
[library]
repo = "https://example.org/lib.git"
builder = "lib"
ref = "{version}"
latest = "0.20260508.0"
[versions]
"main" = {}
"0.20260508.0" = { name = "lib20260508" }
"1.1.1g+git.aaa" = { name = "lib202311", commit = "aaa" }
${modifiers}
TOML
sed '/^latest/d' "${repo}/puffin-build/vendors/lib/presets.toml" > "${repo}/puffin-build/vendors/old/presets.toml"
sed 's/^latest = .*/latest = "9.9"/' "${repo}/puffin-build/vendors/lib/presets.toml" > "${repo}/puffin-build/vendors/typo/presets.toml"
git -C "${repo}" init -q && git -C "${repo}" add -A && git -C "${repo}" -c user.name=test -c user.email=test@example.org commit -q -m presets
out=$( bash "${bench}/git_restapi/scripts/tlspuffin_presets.sh" "${repo}" HEAD )
check 'the latest release of the vendor that declares it, not of the others' '[ "$( jq -c .latest <<< "${out}" )" == "{\"lib\":\"0.20260508.0\"}" ]'
check 'its builds listed as before (the ASAN build of that version among them)' 'jq -e "[.vendors.lib[] | select(.asan) | .name] | index(\"lib20260508-asan\") != null" <<< "${out}" > /dev/null'
exit "${fail}"
