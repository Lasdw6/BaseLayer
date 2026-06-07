#!/usr/bin/env bash
set -euo pipefail
trap 'code=$?; echo "[bootstrap-provider-host] failed at line ${LINENO}: ${BASH_COMMAND} (exit ${code})" >&2' ERR

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
TARGET_USER="${SUDO_USER:-${USER:-ubuntu}}"

cd "$ROOT"

sudo bash "$ROOT/scripts/bench/bootstrap-baremetal-linux.sh"
sudo bash "$ROOT/scripts/bench/bootstrap-firecracker-linux.sh" "$ROOT"
sudo chown -R "${TARGET_USER}:${TARGET_USER}" "$ROOT"

npm ci
npm run build
npm test
sudo bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh"

echo "AWS_BAREMETAL_PROVIDER_BOOTSTRAP_DONE"
