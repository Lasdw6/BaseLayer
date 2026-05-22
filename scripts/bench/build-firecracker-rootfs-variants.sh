#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
METRICS_DIR="${FIRECRACKER_ROOTFS_VARIANTS_METRICS_DIR:-$ROOT/artifacts/firecracker/rootfs-build-metrics}"
METRICS_INDEX_PATH="${FIRECRACKER_ROOTFS_VARIANTS_METRICS_INDEX_PATH:-$METRICS_DIR/index.json}"
# Minbase chroot tarball: first variant run creates it; later runs extract and skip debootstrap/apt.
CHROOT_CACHE_TAR="${FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR:-$ROOT/artifacts/firecracker/cache/noble-minbase-chroot.tar.gz}"

mkdir -p "$METRICS_DIR"
mkdir -p "$(dirname "$CHROOT_CACHE_TAR")"

VARIANT_FIRST_SAVE_CHROOT=1
if [[ "${FIRECRACKER_ROOTFS_VARIANTS_DISABLE_CHROOT_CACHE:-0}" = "1" ]]; then
  VARIANT_FIRST_SAVE_CHROOT=0
fi

if [[ "${FIRECRACKER_ROOTFS_VARIANTS_DISABLE_CHROOT_CACHE:-0}" = "1" ]]; then
  CACHE_FIRST=()
  CACHE_REST=()
else
  CACHE_FIRST=(
    FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR="$CHROOT_CACHE_TAR"
    FIRECRACKER_ROOTFS_SAVE_CHROOT_CACHE="$VARIANT_FIRST_SAVE_CHROOT"
    FIRECRACKER_ROOTFS_USE_CHROOT_CACHE=0
  )
  CACHE_REST=(
    FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR="$CHROOT_CACHE_TAR"
    FIRECRACKER_ROOTFS_SAVE_CHROOT_CACHE=0
    FIRECRACKER_ROOTFS_USE_CHROOT_CACHE=1
    FIRECRACKER_ROOTFS_SKIP_HOST_APT=1
  )
fi

echo "[1/15] building benchmark-safe baseline rootfs (creates chroot cache for later variants)"
sudo env \
  "${CACHE_FIRST[@]}" \
  FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}" \
  FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
  FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
  FIRECRACKER_ROOTFS_VARIANT_SUFFIX="" \
  FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-baseline.json" \
  bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

echo "[2/15] building kernel-inspired goto rootfs"
sudo env \
  "${CACHE_REST[@]}" \
  FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}" \
  FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
  FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
  FIRECRACKER_CHROME_LAUNCH_PROFILE=kernel-goto \
  FIRECRACKER_ROOTFS_VARIANT_SUFFIX=kernel-goto \
  FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-kernel-goto.json" \
  bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

echo "[3/15] building kernel-inspired goto-lite rootfs"
sudo env \
  "${CACHE_REST[@]}" \
  FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}" \
  FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
  FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
  FIRECRACKER_CHROME_LAUNCH_PROFILE=kernel-goto-lite \
  FIRECRACKER_ROOTFS_VARIANT_SUFFIX=kernel-goto-lite \
  FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-kernel-goto-lite.json" \
  bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

echo "[4/15] building kernel-inspired goto + guest IPv6-off rootfs"
sudo env \
  "${CACHE_REST[@]}" \
  FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}" \
  FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
  FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
  FIRECRACKER_CHROME_LAUNCH_PROFILE=kernel-goto \
  FIRECRACKER_GUEST_DISABLE_IPV6=1 \
  FIRECRACKER_ROOTFS_VARIANT_SUFFIX=kernel-goto-ipv6off \
  FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-kernel-goto-ipv6off.json" \
  bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

echo "[5/15] building feature-pruned kernel rootfs"
sudo env \
  "${CACHE_REST[@]}" \
  FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}" \
  FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
  FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
  FIRECRACKER_CHROME_LAUNCH_PROFILE=kernel-feature-prune \
  FIRECRACKER_ROOTFS_VARIANT_SUFFIX=kernel-feature-prune \
  FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-kernel-feature-prune.json" \
  bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

echo "[6/15] building startup-pruned kernel rootfs"
sudo env \
  "${CACHE_REST[@]}" \
  FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}" \
  FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
  FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
  FIRECRACKER_CHROME_LAUNCH_PROFILE=kernel-startup-prune \
  FIRECRACKER_ROOTFS_VARIANT_SUFFIX=kernel-startup-prune \
  FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-kernel-startup-prune.json" \
  bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

echo "[7/15] building balanced kernel rootfs"
sudo env \
  "${CACHE_REST[@]}" \
  FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}" \
  FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
  FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
  FIRECRACKER_CHROME_LAUNCH_PROFILE=kernel-balanced \
  FIRECRACKER_ROOTFS_VARIANT_SUFFIX=kernel-balanced \
  FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-kernel-balanced.json" \
  bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

echo "[8/15] building startup-pruned-lite kernel rootfs"
sudo env \
  "${CACHE_REST[@]}" \
  FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}" \
  FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
  FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
  FIRECRACKER_CHROME_LAUNCH_PROFILE=kernel-startup-prune-lite \
  FIRECRACKER_ROOTFS_VARIANT_SUFFIX=kernel-startup-prune-lite \
  FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-kernel-startup-prune-lite.json" \
  bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

echo "[9/15] building startup-pruned automation rootfs"
sudo env \
  "${CACHE_REST[@]}" \
  FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}" \
  FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
  FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
  FIRECRACKER_CHROME_LAUNCH_PROFILE=kernel-startup-prune-automation \
  FIRECRACKER_ROOTFS_VARIANT_SUFFIX=kernel-startup-prune-automation \
  FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-kernel-startup-prune-automation.json" \
  bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

echo "[10/15] building startup-pruned network-calm rootfs"
sudo env \
  "${CACHE_REST[@]}" \
  FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}" \
  FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
  FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
  FIRECRACKER_CHROME_LAUNCH_PROFILE=kernel-startup-prune-network-calm \
  FIRECRACKER_ROOTFS_VARIANT_SUFFIX=kernel-startup-prune-network-calm \
  FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-kernel-startup-prune-network-calm.json" \
  bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

echo "[11/15] building balanced-lite kernel rootfs"
sudo env \
  "${CACHE_REST[@]}" \
  FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}" \
  FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
  FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
  FIRECRACKER_CHROME_LAUNCH_PROFILE=kernel-balanced-lite \
  FIRECRACKER_ROOTFS_VARIANT_SUFFIX=kernel-balanced-lite \
  FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-kernel-balanced-lite.json" \
  bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

echo "[12/15] building manual async-parity gengar rootfs"
sudo env \
  "${CACHE_REST[@]}" \
  FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}" \
  FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
  FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
  FIRECRACKER_CHROME_LAUNCH_PROFILE=async-parity-manual-gengar \
  FIRECRACKER_ROOTFS_VARIANT_SUFFIX=async-manual-gengar \
  FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-async-manual-gengar.json" \
  bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

echo "[13/15] building manual async-parity dragonite rootfs"
sudo env \
  "${CACHE_REST[@]}" \
  FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}" \
  FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
  FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
  FIRECRACKER_CHROME_LAUNCH_PROFILE=async-parity-manual-dragonite \
  FIRECRACKER_ROOTFS_VARIANT_SUFFIX=async-manual-dragonite \
  FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-async-manual-dragonite.json" \
  bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

echo "[14/15] building low-overhead netlog rootfs"
sudo env \
  "${CACHE_REST[@]}" \
  FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}" \
  FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
  FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=netlog-lite \
  FIRECRACKER_ROOTFS_VARIANT_SUFFIX=netlog \
  FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-netlog.json" \
  bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

echo "[15/15] building startup-lite diagnostic rootfs"
sudo env \
  "${CACHE_REST[@]}" \
  FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}" \
  FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
  FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=startup-lite \
  FIRECRACKER_ROOTFS_VARIANT_SUFFIX=startup \
  FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-startup.json" \
  bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

if [[ -n "${FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM:-}" ]]; then
  echo "[custom] building rootfs for custom shell baseline lane"
  sudo env \
    "${CACHE_REST[@]}" \
    FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM}" \
    FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
    FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
    FIRECRACKER_ROOTFS_VARIANT_SUFFIX=custom-shell-baseline \
    FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-custom-shell-baseline.json" \
    bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

  echo "[custom] building rootfs for custom shell startup-prune lane"
  sudo env \
    "${CACHE_REST[@]}" \
    FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM}" \
    FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
    FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
    FIRECRACKER_CHROME_LAUNCH_PROFILE=kernel-startup-prune \
    FIRECRACKER_ROOTFS_VARIANT_SUFFIX=custom-shell-startup-prune \
    FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-custom-shell-startup-prune.json" \
    bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

  echo "[custom] building rootfs for custom shell manual-async lane"
  sudo env \
    "${CACHE_REST[@]}" \
    FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM}" \
    FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
    FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
    FIRECRACKER_CHROME_LAUNCH_PROFILE=async-parity-manual-custom-shell \
    FIRECRACKER_ROOTFS_VARIANT_SUFFIX=custom-shell-async-manual \
    FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-custom-shell-async-manual.json" \
    bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"

  echo "[custom] building rootfs for custom shell + kernel-balanced (combined Instance D lane)"
  sudo env \
    "${CACHE_REST[@]}" \
    FIRECRACKER_HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM}" \
    FIRECRACKER_CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}" \
    FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE=none \
    FIRECRACKER_CHROME_LAUNCH_PROFILE=kernel-balanced \
    FIRECRACKER_ROOTFS_VARIANT_SUFFIX=custom-shell-kernel-balanced \
    FIRECRACKER_ROOTFS_BUILD_METRICS_PATH="$METRICS_DIR/rootfs-custom-shell-kernel-balanced.json" \
    bash "$ROOT/scripts/firecracker/build-headless-shell-rootfs.sh" "$ROOT"
fi

METRICS_DIR="$METRICS_DIR" METRICS_INDEX_PATH="$METRICS_INDEX_PATH" \
FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM="${FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM:-}" \
python3 - <<'PY'
import json
import os
from datetime import datetime, timezone

base = [
    "rootfs-baseline.json",
    "rootfs-kernel-goto.json",
    "rootfs-kernel-goto-lite.json",
    "rootfs-kernel-goto-ipv6off.json",
    "rootfs-kernel-feature-prune.json",
    "rootfs-kernel-startup-prune.json",
    "rootfs-kernel-balanced.json",
    "rootfs-kernel-startup-prune-lite.json",
    "rootfs-kernel-startup-prune-automation.json",
    "rootfs-kernel-startup-prune-network-calm.json",
    "rootfs-kernel-balanced-lite.json",
    "rootfs-async-manual-gengar.json",
    "rootfs-async-manual-dragonite.json",
    "rootfs-netlog.json",
    "rootfs-startup.json",
]
if os.environ.get("FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM"):
    base.extend(
        [
            "rootfs-custom-shell-baseline.json",
            "rootfs-custom-shell-startup-prune.json",
            "rootfs-custom-shell-async-manual.json",
            "rootfs-custom-shell-kernel-balanced.json",
        ]
    )

payload = {
    "kind": "baselayer-rootfs-variants-index-v1",
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "metricsDir": os.environ["METRICS_DIR"],
    "metricsFiles": base,
}

out = os.environ["METRICS_INDEX_PATH"]
parent = os.path.dirname(out)
if parent:
    os.makedirs(parent, exist_ok=True)
with open(out, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2)
PY

echo "built rootfs variants:"
echo "  $ROOT/artifacts/firecracker/rootfs.ext4"
echo "  $ROOT/artifacts/firecracker/rootfs-kernel-goto.ext4"
echo "  $ROOT/artifacts/firecracker/rootfs-kernel-goto-lite.ext4"
echo "  $ROOT/artifacts/firecracker/rootfs-kernel-goto-ipv6off.ext4"
echo "  $ROOT/artifacts/firecracker/rootfs-kernel-feature-prune.ext4"
echo "  $ROOT/artifacts/firecracker/rootfs-kernel-startup-prune.ext4"
echo "  $ROOT/artifacts/firecracker/rootfs-kernel-balanced.ext4"
echo "  $ROOT/artifacts/firecracker/rootfs-kernel-startup-prune-lite.ext4"
echo "  $ROOT/artifacts/firecracker/rootfs-kernel-balanced-lite.ext4"
echo "  $ROOT/artifacts/firecracker/rootfs-async-manual-gengar.ext4"
echo "  $ROOT/artifacts/firecracker/rootfs-async-manual-dragonite.ext4"
echo "  $ROOT/artifacts/firecracker/rootfs-netlog.ext4"
echo "  $ROOT/artifacts/firecracker/rootfs-startup.ext4"
echo "rootfs build metrics:"
echo "  $METRICS_DIR"
echo "  $METRICS_INDEX_PATH"
if [[ "${FIRECRACKER_ROOTFS_VARIANTS_DISABLE_CHROOT_CACHE:-0}" != "1" ]]; then
  echo "minbase chroot cache (first variant creates; rest reuse):"
  echo "  $CHROOT_CACHE_TAR"
fi
if [[ -n "${FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM:-}" ]]; then
echo "  $ROOT/artifacts/firecracker/rootfs-custom-shell-baseline.ext4"
echo "  $ROOT/artifacts/firecracker/rootfs-custom-shell-startup-prune.ext4"
echo "  $ROOT/artifacts/firecracker/rootfs-custom-shell-async-manual.ext4"
echo "  $ROOT/artifacts/firecracker/rootfs-custom-shell-kernel-balanced.ext4"
fi
