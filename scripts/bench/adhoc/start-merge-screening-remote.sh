#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/home/ubuntu/baselayer}"
nohup bash "$ROOT/scripts/bench/adhoc/run-merge-screening-remote.sh" "$ROOT" \
  > /home/ubuntu/merge-screening.log 2>&1 < /dev/null &
echo "$!" > /home/ubuntu/merge-screening.pid
echo "started"
