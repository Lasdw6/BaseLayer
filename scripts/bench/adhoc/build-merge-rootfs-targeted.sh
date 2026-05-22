#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/home/ubuntu/baselayer}"
cd "$ROOT"

build_variant() {
  local launch_profile="$1"
  local suffix="$2"

  echo "=== building ${suffix} ==="
  sudo env \
    FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}" \
    FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
    FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
    FIRECRACKER_CHROME_LAUNCH_PROFILE="$launch_profile" \
    FIRECRACKER_ROOTFS_VARIANT_SUFFIX="$suffix" \
    bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"
}

build_variant "kernel-startup-prune" "kernel-startup-prune"
build_variant "kernel-balanced" "kernel-balanced"
build_variant "kernel-startup-prune-lite" "kernel-startup-prune-lite"
build_variant "kernel-startup-prune-automation" "kernel-startup-prune-automation"
build_variant "kernel-startup-prune-network-calm" "kernel-startup-prune-network-calm"
build_variant "kernel-balanced-lite" "kernel-balanced-lite"

echo "MERGE_ROOTFS_TARGETED_DONE"
