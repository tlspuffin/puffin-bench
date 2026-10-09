#!/bin/bash
#
# Build puffin-bench from the checkout containing this script and install it into PB_ROOT.
# Runs WITHOUT root, as the user given to setup_root.sh (same directory), which must have been
# run once before (system packages, Nix, systemd units, PB_ROOT owned by this user).
#
# Usage: bash deploy.sh
#   PB_ROOT   install root                      (default /srv/puffin-bench)
#   PB_CORES  cores available to the scheduler   (default: all but core 0, which is excluded)
#
# The services must be stopped while their binaries are replaced:
#   sudo systemctl stop puffin-bench.target     # updates only
#   bash deploy.sh
#   sudo systemctl start puffin-bench.target
# Re-running it rebuilds and re-installs the binaries and extracted files; generated configs are kept.

set -euo pipefail

PB_ROOT="${PB_ROOT:-/srv/puffin-bench}"
PB_CORES="${PB_CORES:-$(( $(nproc) - 1 ))}"
SRC="$( cd "$( dirname "$( realpath "${BASH_SOURCE[0]}" )" )/../../.." && pwd )"
SERVICES=( scheduler git_restapi publisher vis_comparator )

Step() { echo -e "\n==== $*"; }
Fail() { echo "ERROR: $*" >&2; exit 1; }

[ "$( id -u )" -ne 0 ] || Fail "do not run as root; run it as the user given to setup_root.sh"
[ -f "${SRC}/CMakeLists.txt" ] && [ -d "${SRC}/tlspuffin" ] || Fail "not a puffin-bench checkout: ${SRC}"
(( PB_CORES > 0 )) || Fail "PB_CORES must be > 0"
for tool in cmake git readelf ldd jq zip xxd flock setarch; do
  command -v "${tool}" > /dev/null || Fail "${tool} missing: run setup_root.sh first"
done
command -v nix-shell > /dev/null || [ -x /nix/var/nix/profiles/default/bin/nix-shell ] ||
    Fail "Nix missing: run setup_root.sh first"
[ -w "${PB_ROOT}/bin" ] && [ -w "${PB_ROOT}/data" ] || Fail "${PB_ROOT} not writable by $( id -un ): run setup_root.sh first"
[ -f /etc/systemd/system/puffin-bench.target ] || Fail "systemd units missing: run setup_root.sh first"
# vm.mmap_rnd_bits is only readable by root: check the setting written by setup_root.sh
[ -f /etc/sysctl.d/60-puffin-bench-asan.conf ] ||
    echo "WARNING: vm.mmap_rnd_bits not limited to 28 (re-run setup_root.sh): ASAN runs of older commits may crash at random" >&2
for s in "${SERVICES[@]}"; do
  if systemctl is-active --quiet "puffin-${s}.service" 2> /dev/null; then
    Fail "puffin-${s} is running: sudo systemctl stop puffin-bench.target, then re-run"
  fi
done

Step "Build puffin-bench from ${SRC} ($( git -C "${SRC}" rev-parse --abbrev-ref HEAD ) $( git -C "${SRC}" rev-parse --short HEAD ))"
cmake -S "${SRC}" -B "${SRC}/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "${SRC}/build" -j"$( nproc )"

Step "Install into ${PB_ROOT} (${PB_CORES} cores)"
INSTALLER="$( find "${SRC}/build" -type f -name installer-static -perm -u+x | head -1 )"
[ -n "${INSTALLER}" ] || Fail "installer-static not found in ${SRC}/build"
FORCE=''
[ -x "${PB_ROOT}/bin/scheduler" ] && FORCE='--force-files'
"${INSTALLER}" --binpath "${PB_ROOT}/bin" --datapath "${PB_ROOT}/data" \
    --nb-cores "${PB_CORES}" --username "$( id -un )" ${FORCE} < /dev/null
# the scheduler places its tasks in the cgroup of its own unit
sed -i 's|"cgroupPath": "/sys/fs/cgroup/scheduler.service"|"cgroupPath": "/sys/fs/cgroup/puffin-scheduler.service"|' \
    "${PB_ROOT}/bin/config.json"

Step "Checks"
status=0
for s in "${SERVICES[@]}"; do
  [ -x "${PB_ROOT}/bin/${s}" ] && echo "OK      ${s} installed" || { echo "FAILED  ${s} missing"; status=1; }
done
grep -q 'COMPAT RULES START' "${PB_ROOT}/data/html/jobsscripts/tlspuffin/PR_perf_full.sh" &&
    echo "OK      job scripts with compat rules" || { echo "FAILED  job scripts"; status=1; }

HOST="$( hostname -f 2> /dev/null || hostname )"
cat <<EOF

Installed. Start (or restart) the services:
  sudo systemctl start puffin-bench.target

Board (launch jobs):   http://${HOST}:10082/files/board/board.html
Results:               http://${HOST}:10083/files/tlspuffin
Comparisons:           http://${HOST}:10084/files/tlspuffin/index.html
(open ports 10081-10084 in the firewall if needed; git_restapi clones tlspuffin on first start)
Service logs:          journalctl -u puffin-scheduler (git_restapi, publisher, vis_comparator)
EOF
exit ${status}
