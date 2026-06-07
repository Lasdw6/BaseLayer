#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script only supports Linux hosts." >&2
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt_update_retry() {
  local attempt
  for attempt in 1 2 3; do
    if apt-get update; then
      return 0
    fi
    rm -rf /var/lib/apt/lists/*
    mkdir -p /var/lib/apt/lists/partial
    sleep $((attempt * 5))
  done
  apt-get update
}

apt_update_retry
apt-get install -y \
  ca-certificates \
  curl \
  ethtool \
  git \
  hwloc \
  jq \
  linux-tools-common \
  linux-tools-generic \
  numactl \
  pciutils \
  python3 \
  rsync \
  sysstat

set_governor() {
  local governor_path
  local changed=0
  while IFS= read -r governor_path; do
    echo performance >"$governor_path"
    changed=1
  done < <(find /sys/devices/system/cpu -path '*/cpufreq/scaling_governor' 2>/dev/null | sort)

  if [[ "$changed" -eq 1 ]]; then
    echo "cpu-governor=performance"
  else
    echo "cpu-governor=unavailable"
  fi
}

set_thp_mode() {
  local target="$1"
  local path="/sys/kernel/mm/transparent_hugepage/$target"
  if [[ -f "$path" ]]; then
    echo madvise >"$path"
    echo "thp-$target=madvise"
  fi
}

apply_sysctl() {
  local key="$1"
  local value="$2"
  sysctl -w "${key}=${value}" >/dev/null
}

set_governor
set_thp_mode enabled
set_thp_mode defrag

apply_sysctl kernel.numa_balancing 0
apply_sysctl kernel.sched_autogroup_enabled 0
apply_sysctl vm.zone_reclaim_mode 0
apply_sysctl vm.swappiness 1
apply_sysctl fs.file-max 2097152
apply_sysctl fs.inotify.max_user_instances 8192
apply_sysctl fs.inotify.max_user_watches 1048576
apply_sysctl net.core.somaxconn 4096
apply_sysctl net.core.netdev_max_backlog 16384
apply_sysctl net.ipv4.ip_local_port_range "10240 65535"
apply_sysctl vm.max_map_count 1048576

if [[ "${BASELAYER_DISABLE_IRQBALANCE:-0}" == "1" ]]; then
  systemctl stop irqbalance || true
  systemctl disable irqbalance || true
  echo "irqbalance=disabled"
else
  echo "irqbalance=unchanged"
fi

if command -v lshw >/dev/null 2>&1; then
  echo "--- network ---"
  lshw -class network 2>/dev/null | sed -n '1,80p'
fi

echo "--- cpu ---"
lscpu

echo "--- numa ---"
numactl --hardware || true

echo "--- sysctl-summary ---"
sysctl \
  kernel.numa_balancing \
  kernel.sched_autogroup_enabled \
  vm.zone_reclaim_mode \
  vm.swappiness \
  vm.max_map_count \
  fs.file-max \
  fs.inotify.max_user_instances \
  fs.inotify.max_user_watches \
  net.core.somaxconn \
  net.core.netdev_max_backlog \
  net.ipv4.ip_local_port_range

echo "baremetal-bootstrap=done"
