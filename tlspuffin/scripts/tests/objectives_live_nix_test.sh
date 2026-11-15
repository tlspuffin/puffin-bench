#!/bin/bash
# objectives_live_nix_test.sh: the live tool finds nix-shell where cron's PATH does not have it (pesto: the Nix profile,
# /nix/var/nix/profiles/default/bin), so that its replays run in the checkout's shell.nix with a symbolizer, not
# directly and unsymbolized (no stack, no place to check). objectives_live.sh NixInPath.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
source <( sed -n '/^NixInPath()/,/^}/p' "${here}/../tools/objectives_live.sh" )
mkdir -p "${work}/empty" "${work}/profile/bin"
printf '#!/bin/sh\nexit 0\n' > "${work}/profile/bin/nix-shell"; chmod +x "${work}/profile/bin/nix-shell"
found=$( PATH="${work}/empty"; NIX_BIN_DIRS="${work}/nowhere ${work}/profile/bin"; NixInPath && command -v nix-shell ) || found=''
check "cron's PATH without nix-shell: the one of the Nix profile, added to PATH" '[ "${found}" == "${work}/profile/bin/nix-shell" ]'
rc=0; after=$( PATH="${work}/empty"; NIX_BIN_DIRS="${work}/nowhere"; NixInPath || rc=$?; echo "${rc} ${PATH}" )
check 'no nix-shell anywhere: said (the replays then run directly), PATH unchanged' '[ "${after}" == "1 ${work}/empty" ]'
exit "${fail}"
