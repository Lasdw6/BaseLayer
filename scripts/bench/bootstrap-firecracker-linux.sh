#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND="${DEBIAN_FRONTEND:-noninteractive}"

ROOT="${1:-$PWD}"
ARTIFACT_DIR="${FIRECRACKER_ARTIFACT_DIR:-$ROOT/artifacts/firecracker}"

sudo apt-get update
sudo apt-get install -y \
  acl \
  bridge-utils \
  curl \
  debootstrap \
  iproute2 \
  iptables \
  jq \
  kmod \
  qemu-utils \
  socat \
  squashfs-tools \
  tar \
  unzip

ensure_node() {
  local major=""
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  fi

  if [[ -n "$major" && "$major" -ge 20 ]]; then
    return
  fi

  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
}

ensure_node

mkdir -p "$ARTIFACT_DIR"

grant_kvm_access() {
  local target_user=""
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    target_user="${SUDO_USER}"
  else
    target_user="${USER:-}"
  fi

  if [[ ! -c /dev/kvm ]]; then
    echo "/dev/kvm is not available on this host." >&2
    return
  fi

  sudo mkdir -p /etc/udev/rules.d
  sudo tee /etc/udev/rules.d/65-baselayer-kvm.rules >/dev/null <<EOF
KERNEL=="kvm", GROUP="kvm", MODE="0660"
EOF
  sudo udevadm control --reload-rules || true
  sudo udevadm trigger /dev/kvm || true

  if getent group kvm >/dev/null 2>&1; then
    sudo usermod -aG kvm "$target_user" || true
  fi

  sudo chgrp kvm /dev/kvm 2>/dev/null || true
  sudo chmod 0660 /dev/kvm 2>/dev/null || true
  sudo setfacl -m "u:${target_user}:rw" /dev/kvm 2>/dev/null || true

  echo "Granted /dev/kvm access to ${target_user}."
}

grant_kvm_access

if ! command -v firecracker >/dev/null 2>&1; then
  ARCH=$(uname -m)
  RELEASE_URL="https://github.com/firecracker-microvm/firecracker/releases"
  LATEST=$(basename "$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${RELEASE_URL}/latest")")
  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_DIR"' EXIT
  curl -L "${RELEASE_URL}/download/${LATEST}/firecracker-${LATEST}-${ARCH}.tgz" | tar -xz -C "$TMP_DIR"
  sudo install -m 0755 "$TMP_DIR/release-${LATEST}-${ARCH}/firecracker-${LATEST}-${ARCH}" /usr/local/bin/firecracker
fi

cd "$ROOT"
npm install

PLAYWRIGHT_CLI="$ROOT/node_modules/playwright-core/cli.js"
if [ ! -f "$PLAYWRIGHT_CLI" ]; then
  echo "Missing Playwright CLI at $PLAYWRIGHT_CLI after npm install." >&2
  exit 1
fi

# Windows-packed bundles can lose executable bits on .bin shims and cli.js.
# Invoke the CLI through node directly so host bootstrap does not depend on chmod recovery.
chmod +x "$ROOT/node_modules/.bin/playwright-core" "$PLAYWRIGHT_CLI" 2>/dev/null || true

# Keep default aligned with scripts/firecracker/build-headless-shell-rootfs.sh (non-chromium path).
BROWSER_PROFILE="${FIRECRACKER_BROWSER_PROFILE:-optimized}"
PLAYWRIGHT_INSTALL_WITH_DEPS="${FIRECRACKER_PLAYWRIGHT_INSTALL_WITH_DEPS:-1}"
if [ "${FIRECRACKER_SKIP_PLAYWRIGHT_INSTALL:-0}" = "1" ]; then
  echo "[bootstrap] skipping Playwright browser install (FIRECRACKER_SKIP_PLAYWRIGHT_INSTALL=1)"
else
  PLAYWRIGHT_INSTALL_ARGS=()
  if [ "$PLAYWRIGHT_INSTALL_WITH_DEPS" = "1" ]; then
    PLAYWRIGHT_INSTALL_ARGS+=(--with-deps)
  fi
  if [ "$BROWSER_PROFILE" = "chromium" ]; then
    node "$PLAYWRIGHT_CLI" install "${PLAYWRIGHT_INSTALL_ARGS[@]}" chromium
  else
    node "$PLAYWRIGHT_CLI" install "${PLAYWRIGHT_INSTALL_ARGS[@]}" chromium-headless-shell
  fi
fi

if [ ! -f "$ARTIFACT_DIR/vmlinux" ]; then
  ARCH=$(uname -m)
  # Allow operators to pin a specific kernel filename (e.g. `vmlinux-5.10.225`)
  # for reproducible benchmarks. Unpinned runs track the newest CI kernel,
  # which silently changes between bootstraps and breaks cross-session
  # comparisons.
  KERNEL_VERSION="${FIRECRACKER_KERNEL_VERSION:-}"
  CI_VERSION=$(
    firecracker --version 2>/dev/null |
      head -n 1 |
      sed -E 's/^Firecracker v([0-9]+\.[0-9]+).*/\1/'
  )
  if [ -z "$CI_VERSION" ]; then
    echo "Could not parse Firecracker version for kernel download." >&2
    exit 1
  fi
  CI_TAG="v${CI_VERSION}"
  if [ -n "$KERNEL_VERSION" ]; then
    KERNEL_KEY="firecracker-ci/${CI_TAG}/${ARCH}/${KERNEL_VERSION}"
    echo "[bootstrap] pinned guest kernel: ${KERNEL_VERSION}"
  else
    # `grep -oP` needs GNU grep; `sort -V` needs GNU sort. Both are present
    # on the Ubuntu hosts this script targets, but fall back gracefully if
    # a host ever ships a BusyBox-style toolchain.
    SORT_VERSION="sort -V"
    if ! echo '1.0' | sort -V >/dev/null 2>&1; then
      SORT_VERSION="sort"
    fi
    KERNEL_KEY=$(
      curl -fsSL "https://s3.amazonaws.com/spec.ccfc.min/?prefix=firecracker-ci/${CI_TAG}/${ARCH}/vmlinux-&list-type=2" |
        grep -oE '<Key>firecracker-ci/[^<]+/vmlinux-[0-9][^<]*</Key>' |
        sed -E 's#^<Key>##; s#</Key>$##' |
        grep -v '\.config$' |
        $SORT_VERSION |
        tail -1
    )
    echo "[bootstrap] floating guest kernel: ${KERNEL_KEY##*/} (set FIRECRACKER_KERNEL_VERSION to pin)"
  fi
  if [ -z "$KERNEL_KEY" ]; then
    echo "Could not resolve a Firecracker kernel artifact for version ${CI_TAG} and arch ${ARCH}." >&2
    exit 1
  fi
  curl -fsSL "https://s3.amazonaws.com/spec.ccfc.min/${KERNEL_KEY}" -o "$ARTIFACT_DIR/vmlinux"
  # Record which kernel was materialized so downstream benchmark artifacts
  # can surface it without re-probing the filesystem.
  echo "${KERNEL_KEY##*/}" > "$ARTIFACT_DIR/vmlinux.version"
fi

echo "Firecracker host bootstrap complete."
echo "Next step:"
echo "  sudo $ROOT/scripts/firecracker/build-headless-shell-rootfs.sh"
