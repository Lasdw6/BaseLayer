#!/usr/bin/env bash
# Preflight: run `git apply --check` on every patch in a profile against an
# existing Chromium checkout (same order as build-custom-headless-shell.sh).
# Does not modify the tree.
#
#   BASELAYER_CHROMIUM_SRC_DIR=/path/to/chromium/src \
#     bash scripts/chromium/verify-patch-profile-apply.sh
#
#   bash scripts/chromium/verify-patch-profile-apply.sh /path/to/chromium/src [patch-profile]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHROMIUM_SRC_DIR="${1:-${BASELAYER_CHROMIUM_SRC_DIR:-}}"
PATCH_PROFILE="${2:-${BASELAYER_CHROMIUM_PATCH_PROFILE:-startup-network-v1}}"
PATCH_DIR="$ROOT/scripts/chromium/patch-profiles/$PATCH_PROFILE"

if [[ -z "$CHROMIUM_SRC_DIR" ]]; then
  echo "usage: BASELAYER_CHROMIUM_SRC_DIR=/path/to/chromium/src $0" >&2
  echo "   or: $0 /path/to/chromium/src [patch-profile]" >&2
  exit 1
fi

if [[ ! -f "$CHROMIUM_SRC_DIR/BUILD.gn" ]]; then
  echo "Chromium source not found at $CHROMIUM_SRC_DIR (missing BUILD.gn)" >&2
  exit 1
fi

if [[ ! -d "$PATCH_DIR" ]]; then
  echo "Patch profile not found: $PATCH_DIR" >&2
  exit 1
fi

if [[ -x "$PATCH_DIR/apply.sh" ]]; then
  echo "[verify] profile uses apply.sh — run it manually or use a full build; skipping patch check."
  exit 0
fi

if ! compgen -G "$PATCH_DIR/*.patch" >/dev/null; then
  echo "[verify] no .patch files in $PATCH_DIR"
  exit 0
fi

echo "[verify] profile=$PATCH_PROFILE src=$CHROMIUM_SRC_DIR"
(
  cd "$CHROMIUM_SRC_DIR"
  for patch in "$PATCH_DIR"/*.patch; do
    echo "[verify] git apply --check $(basename "$patch")"
    git apply --check "$patch"
  done
)
echo "[verify] OK — all patches apply cleanly."
