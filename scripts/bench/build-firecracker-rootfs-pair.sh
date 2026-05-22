#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"

cd "$ROOT"

echo "Building optimized Firecracker rootfs..."
FIRECRACKER_BROWSER_PROFILE=optimized \
  FIRECRACKER_ROOTFS_PATH="$ROOT/artifacts/firecracker/rootfs.ext4" \
  bash ./scripts/firecracker/build-headless-shell-rootfs.sh

echo "Building vanilla Firecracker rootfs..."
FIRECRACKER_BROWSER_PROFILE=vanilla \
  FIRECRACKER_ROOTFS_PATH="$ROOT/artifacts/firecracker/rootfs-vanilla.ext4" \
  bash ./scripts/firecracker/build-headless-shell-rootfs.sh

echo "Built:"
echo "  $ROOT/artifacts/firecracker/rootfs.ext4"
echo "  $ROOT/artifacts/firecracker/rootfs-vanilla.ext4"
