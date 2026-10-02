#!/bin/bash
#
# One-time system setup of a dedicated Ubuntu 24.04 machine for puffin-bench (needs root).
# Only the steps that require root are here; building and installing puffin-bench is done
# afterwards, without root, by deploy.sh (same directory).
#
# Usage: sudo bash setup_root.sh [user]
#   user     account that builds puffin-bench and runs the services (default: the sudo caller)
#   PB_ROOT  install root, created and owned by that user (default /srv/puffin-bench)
#
# It installs the system packages and Nix (multi-user), limits the ASLR entropy for old ASAN runtimes,
# creates PB_ROOT, writes the systemd units of the four services (grouped by puffin-bench.target; a
# service only starts once deploy.sh has installed its binary) and the sudoers entry the scheduler
# needs to set the CPU sets of its tasks. Safe to re-run.

set -euo pipefail

PB_USER="${1:-${SUDO_USER:-}}"
PB_ROOT="${PB_ROOT:-/srv/puffin-bench}"
NIX_BIN=/nix/var/nix/profiles/default/bin
SERVICES=( scheduler git_restapi publisher vis_comparator )

Step() { echo -e "\n==== $*"; }

[ "$( id -u )" -eq 0 ] || { echo "Run as root: sudo bash $0 [user]"; exit 1; }
[ -n "${PB_USER}" ] && [ "${PB_USER}" != "root" ] && id "${PB_USER}" > /dev/null 2>&1 ||
    { echo "Give an existing non-root user: sudo bash $0 <user>"; exit 1; }
# home directory of the services: the job scripts run login shells (executor.sh is "bash -l"), so the
# personal shell setup of the user (e.g. "exec zsh" in ~/.profile) must not apply; holds the cargo/rustup caches
PB_HOME="${PB_ROOT}/home"

Step "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q build-essential cmake git libssl-dev xxd zip jq binutils util-linux curl ca-certificates xz-utils

Step "Nix (multi-user)"
# reuse an existing Nix (official installer in /nix/var/nix/profiles/default, or Ubuntu's nix-bin package)
EXISTING_NIX="$( command -v nix-shell || true )"
[ -z "${EXISTING_NIX}" ] && [ -x "${NIX_BIN}/nix-shell" ] && EXISTING_NIX="${NIX_BIN}/nix-shell"
if [ -n "${EXISTING_NIX}" ]; then
  echo "Nix already installed: ${EXISTING_NIX} ($( "${EXISTING_NIX}" --version ))"
else
  curl -fsSL https://nixos.org/nix/install -o /tmp/nix-install.sh
  sh /tmp/nix-install.sh --daemon --yes
fi
if systemctl list-unit-files nix-daemon.service > /dev/null 2>&1; then
  systemctl list-unit-files nix-daemon.socket > /dev/null 2>&1 && systemctl enable --now nix-daemon.socket
  systemctl enable --now nix-daemon.service
else
  echo "WARNING: no nix-daemon service (single-user Nix?): ${PB_USER} must be able to write to /nix"
fi
# Ubuntu's Nix packages restrict the daemon to the nix-users group
if getent group nix-users > /dev/null; then
  usermod -aG nix-users "${PB_USER}"
  echo "${PB_USER} added to nix-users"
fi

Step "ASLR entropy for ASAN"
# ASAN runtimes of LLVM < 18 (used by older tlspuffin commits, e.g. clang 14) crash at random at startup
# ("AddressSanitizer:DEADLYSIGNAL ... SEGV", "nested bug in the same thread") when the kernel uses more than
# 28 bits of mmap randomization, the default of recent Ubuntu kernels
echo 'vm.mmap_rnd_bits = 28' > /etc/sysctl.d/60-puffin-bench-asan.conf
sysctl -q -p /etc/sysctl.d/60-puffin-bench-asan.conf
echo "vm.mmap_rnd_bits = $( sysctl -n vm.mmap_rnd_bits )"

Step "Install root ${PB_ROOT} (owned by ${PB_USER})"
mkdir -p "${PB_ROOT}/bin" "${PB_ROOT}/data" "${PB_HOME}"
chown -R "${PB_USER}:" "${PB_ROOT}"

Step "systemd units (puffin-bench.target)"
cat > /etc/systemd/system/puffin-bench.target <<EOF
[Unit]
Description=puffin-bench services
Wants=$( printf 'puffin-%s.service ' "${SERVICES[@]}" )

[Install]
WantedBy=multi-user.target
EOF
for s in "${SERVICES[@]}"; do
  extra='';
  # the scheduler manages the CPU sets of its tasks in a delegated cgroup (see config.json cgroupPath)
  [ "${s}" == "scheduler" ] && extra=$'Slice=-.slice\nDelegate=yes'
  cat > "/etc/systemd/system/puffin-${s}.service" <<EOF
[Unit]
Description=puffin-bench ${s}
After=network-online.target nix-daemon.service
Wants=network-online.target
PartOf=puffin-bench.target
ConditionPathExists=${PB_ROOT}/bin/${s}

[Service]
User=${PB_USER}
WorkingDirectory=${PB_ROOT}/bin
ExecStart=${PB_ROOT}/bin/${s}
Environment=PATH=${NIX_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=HOME=${PB_HOME}
Restart=always
${extra}

[Install]
WantedBy=puffin-bench.target
EOF
done
systemctl daemon-reload
systemctl enable puffin-bench.target "${SERVICES[@]/#/puffin-}"

Step "sudoers"
echo "${PB_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl set-property user.slice AllowedCPUs=*" \
    > /etc/sudoers.d/puffin-bench
chmod 440 /etc/sudoers.d/puffin-bench
visudo -cf /etc/sudoers.d/puffin-bench

Step "Check the login shell of the services"
if ! out="$( sudo -u "${PB_USER}" env -i HOME="${PB_HOME}" PATH="${NIX_BIN}:/usr/bin:/bin" bash -l -c 'echo login-shell-ok' < /dev/null 2>&1 )" ||
    [[ "${out}" != *login-shell-ok* ]]; then
  echo "ERROR: a login bash with HOME=${PB_HOME} does not run commands: ${out}"
  exit 1
fi
echo "OK: login bash runs commands"

Step "Check Nix store access for ${PB_USER}"
probe="$( mktemp )"
chmod 644 "${probe}"
if sudo -u "${PB_USER}" env PATH="${NIX_BIN}:${PATH}" nix-store --add "${probe}" > /dev/null; then
  echo "OK: ${PB_USER} can use the Nix store"
else
  echo "ERROR: ${PB_USER} cannot use the Nix store (nix-daemon running? group nix-users?)"
  rm -f "${probe}"
  exit 1
fi
rm -f "${probe}"

cat <<EOF

System setup done. Next, as ${PB_USER} (no sudo):
  PB_ROOT=${PB_ROOT} bash $( dirname "$( realpath "${BASH_SOURCE[0]}" )" )/deploy.sh
then start the services:
  sudo systemctl start puffin-bench.target
EOF
