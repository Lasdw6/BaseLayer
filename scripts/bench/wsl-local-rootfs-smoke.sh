#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$PWD}"
ARTIFACT_DIR="${FIRECRACKER_ARTIFACT_DIR:-$ROOT/artifacts/firecracker}"
METRICS_DIR="${FIRECRACKER_SMOKE_METRICS_DIR:-$ARTIFACT_DIR/wsl-smoke-metrics}"
BOOTSTRAP_LOG="${FIRECRACKER_SMOKE_BOOTSTRAP_LOG:-$METRICS_DIR/bootstrap.log}"
ROOTFS_LOG="${FIRECRACKER_SMOKE_ROOTFS_LOG:-$METRICS_DIR/rootfs.log}"
ROOTFS_METRICS="${FIRECRACKER_SMOKE_ROOTFS_METRICS:-$METRICS_DIR/rootfs-baseline.json}"
MIRROR="${FIRECRACKER_DEBOOTSTRAP_MIRROR:-http://archive.ubuntu.com/ubuntu/}"

mkdir -p "$METRICS_DIR"

echo "[smoke] root: $ROOT"
echo "[smoke] artifact dir: $ARTIFACT_DIR"
echo "[smoke] metrics dir: $METRICS_DIR"
echo "[smoke] mirror: $MIRROR"

# Fail fast if non-interactive sudo is unavailable. The bootstrap and rootfs
# builders both assume `sudo` works without prompting. Under `wsl.exe -d ... --
# bash ...` there is no controlling TTY, so an unprimed sudo password prompt
# aborts mid-build after several minutes of work instead of up front.
if [ "$(id -u)" != "0" ]; then
  if ! sudo -n true 2>/dev/null; then
    cat >&2 <<'SUDOERR'
[smoke] this gate needs passwordless sudo inside WSL because the rootfs
[smoke] builder invokes sudo for debootstrap, mount, chroot, apt, rsync, etc.
[smoke] Fix one of:
[smoke]   1. Configure NOPASSWD sudo for your WSL user, e.g. a file in
[smoke]      /etc/sudoers.d/ with "<user> ALL=(ALL) NOPASSWD:ALL".
[smoke]   2. Invoke wsl.exe with -u root, or run this script under sudo
[smoke]      directly: `sudo -E bash scripts/bench/wsl-local-rootfs-smoke.sh`.
SUDOERR
    exit 1
  fi
fi

echo "[smoke] running host bootstrap"
env FIRECRACKER_BROWSER_PROFILE="${FIRECRACKER_BROWSER_PROFILE:-optimized}" \
  bash "$ROOT/scripts/bench/bootstrap-firecracker-linux.sh" "$ROOT" \
  2>&1 | tee "$BOOTSTRAP_LOG"

echo "[smoke] building baseline rootfs"
# Bootstrap just installed debootstrap/e2fsprogs/rsync; skip the redundant
# apt-get update + install inside the builder unless the caller opted back in.
env \
  FIRECRACKER_DEBOOTSTRAP_MIRROR="$MIRROR" \
  FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$ROOTFS_METRICS" \
  FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
  FIRECRACKER_ROOTFS_VARIANT_SUFFIX="" \
  FIRECRACKER_ROOTFS_SKIP_HOST_APT="${FIRECRACKER_ROOTFS_SKIP_HOST_APT:-1}" \
  bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT" \
  2>&1 | tee "$ROOTFS_LOG"

echo "[smoke] done"
echo "[smoke] bootstrap log: $BOOTSTRAP_LOG"
echo "[smoke] rootfs log: $ROOTFS_LOG"
echo "[smoke] rootfs metrics: $ROOTFS_METRICS"
if [ -f "$ROOTFS_METRICS" ]; then
  cat "$ROOTFS_METRICS"
fi
