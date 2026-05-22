#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

sudo bash ./scripts/bench/bootstrap-baremetal-linux.sh
sudo bash ./scripts/bench/bootstrap-firecracker-linux.sh
sudo chown -R "$(id -un):$(id -gn)" "$ROOT"
npm ci
npx playwright-core install chromium-headless-shell
sudo FIRECRACKER_ROOTFS_PATH="$ROOT/artifacts/firecracker/rootfs.ext4" \
  bash ./scripts/firecracker/build-headless-shell-rootfs.sh
npm run build
npm test

echo "aws-bootstrap-provider-api=done"
