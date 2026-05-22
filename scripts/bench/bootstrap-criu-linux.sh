#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

export DEBIAN_FRONTEND=noninteractive

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

$SUDO apt-get update
$SUDO apt-get install -y criu iproute2 jq lsof psmisc

if command -v modprobe >/dev/null 2>&1; then
  $SUDO modprobe tcp_diag 2>/dev/null || true
  $SUDO modprobe netlink_diag 2>/dev/null || true
  $SUDO modprobe unix_diag 2>/dev/null || true
fi

npm install
npx playwright-core install --with-deps chromium

echo "CRIU version:"
$SUDO criu --version

echo
echo "CRIU check:"
$SUDO criu check

echo
echo "Chromium path:"
node --input-type=module - <<'EOF'
import { chromium } from "playwright-core";
console.log(chromium.executablePath());
EOF
