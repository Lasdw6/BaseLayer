#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$PWD}"

sudo pkill -9 node 2>/dev/null || true
sudo pkill -9 firecracker 2>/dev/null || true

cd "$ROOT"

export FIRECRACKER_KERNEL_PATH="${FIRECRACKER_KERNEL_PATH:-$ROOT/artifacts/firecracker/vmlinux}"
export FIRECRACKER_ROOTFS_PATH="${FIRECRACKER_ROOTFS_PATH:-$ROOT/artifacts/firecracker/rootfs.ext4}"
export FIRECRACKER_SNAPSHOT_DIR="${FIRECRACKER_SNAPSHOT_DIR:-$ROOT/data/firecracker/snapshots}"

exec sudo -E npm run bench:firecracker-proof
