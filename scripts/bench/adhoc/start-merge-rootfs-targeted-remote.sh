#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/home/ubuntu/baselayer}"
nohup bash "$ROOT/scripts/bench/adhoc/build-merge-rootfs-targeted.sh" "$ROOT" \
  > /home/ubuntu/rootfs-targeted.log 2>&1 < /dev/null &
echo "$!" > /home/ubuntu/rootfs-targeted.pid
echo "started"
