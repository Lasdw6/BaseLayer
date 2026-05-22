#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
PUBLIC_HOST="${2:?usage: aws-start-public-baselayer.sh <repo-root> <public-host>}"

cd "$ROOT"

export NODE_AGENT_PUBLIC_HOST="$PUBLIC_HOST"
export CONTROL_PLANE_PORT="${CONTROL_PLANE_PORT:-3000}"
export NODE_AGENT_PORT="${NODE_AGENT_PORT:-4000}"
#
# For public provider-path benchmarking we want the same stable delete semantics as the
# canonical bare-metal benchmark path. Async control-plane delete makes release look
# faster, but under long sequential BrowserArena runs it can outrun Firecracker teardown
# and eventually exhaust `activeMicrovmCount`, which leads to scheduler-side 503s.
#
# Operators can still override this explicitly for parity experiments.
export CONTROL_PLANE_ASYNC_SESSION_DELETE="${CONTROL_PLANE_ASYNC_SESSION_DELETE:-0}"

bash ./scripts/bench/start-baselayer-baremetal.sh "$ROOT"
