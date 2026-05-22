#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

mkdir -p data/firecracker data/benchmarks

# Short AF_UNIX paths for Firecracker (avoid Linux SUN_LEN failures on deep repo paths).
RUNUSER_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
mkdir -p "$RUNUSER_DIR/baselayer-fc/api" "$RUNUSER_DIR/baselayer-fc/state"

# `sudo env` callers can drop the sbin paths; node-agent needs `ip`/`iptables`.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

if [[ ! -f "$ROOT/dist/api/server.js" || ! -f "$ROOT/dist/node-agent/server.js" ]]; then
  npm run build
fi

cpus="$(nproc)"
if [[ "$cpus" -lt 8 ]]; then
  echo "Expected at least 8 CPUs for the bare-metal benchmark host." >&2
  exit 1
fi

housekeeping_end=3
if [[ "$cpus" -lt 16 ]]; then
  housekeeping_end=1
fi

worker_start=$((housekeeping_end + 1))
worker_end=$((cpus - 1))
worker_set="${worker_start}-${worker_end}"
idle_start=$((worker_start + (worker_end - worker_start + 1) / 2))
if [[ "$idle_start" -gt "$worker_end" ]]; then
  idle_start="$worker_start"
fi
idle_set="${idle_start}-${worker_end}"

export CONTROL_PLANE_PORT="${CONTROL_PLANE_PORT:-3000}"
export NODE_AGENT_PORT="${NODE_AGENT_PORT:-4000}"
export NODE_AGENT_API_HOST="${NODE_AGENT_API_HOST:-127.0.0.1}"
export NODE_AGENT_PUBLIC_HOST="${NODE_AGENT_PUBLIC_HOST:-127.0.0.1}"
export NODE_AGENT_MODE="${NODE_AGENT_MODE:-firecracker}"
export CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://127.0.0.1:${CONTROL_PLANE_PORT}}"
export CONTROL_PLANE_STATE_PATH="${CONTROL_PLANE_STATE_PATH:-$ROOT/data/baremetal-state.json}"
# Await node-agent teardown before returning 204 so slots recycle under concurrent load (override with =1).
export CONTROL_PLANE_ASYNC_SESSION_DELETE="${CONTROL_PLANE_ASYNC_SESSION_DELETE:-0}"
export FIRECRACKER_ARTIFACT_DIR="${FIRECRACKER_ARTIFACT_DIR:-$ROOT/artifacts/firecracker}"
export FIRECRACKER_KERNEL_PATH="${FIRECRACKER_KERNEL_PATH:-$ROOT/artifacts/firecracker/vmlinux}"
export FIRECRACKER_ROOTFS_PATH="${FIRECRACKER_ROOTFS_PATH:-$ROOT/artifacts/firecracker/rootfs.ext4}"
export FIRECRACKER_API_DIR="${FIRECRACKER_API_DIR:-$RUNUSER_DIR/baselayer-fc/api}"
export FIRECRACKER_STATE_DIR="${FIRECRACKER_STATE_DIR:-$RUNUSER_DIR/baselayer-fc/state}"
export FIRECRACKER_SNAPSHOT_DIR="${FIRECRACKER_SNAPSHOT_DIR:-$ROOT/data/firecracker/snapshots}"
export FIRECRACKER_ALLOW_AUTO_SNAPSHOT="${FIRECRACKER_ALLOW_AUTO_SNAPSHOT:-1}"
# Benchmark hosts: default off so create/lifecycle rows measure Firecracker + browser work, not slot
# validation/egress probes (see aws-custom-lanes-session-2026-04-18). Set to 1 for safety debugging.
export FIRECRACKER_NETWORK_SLOT_VALIDATE_ON_CLAIM="${FIRECRACKER_NETWORK_SLOT_VALIDATE_ON_CLAIM:-0}"
export FIRECRACKER_ENABLE_INTERNET_EGRESS="${FIRECRACKER_ENABLE_INTERNET_EGRESS:-1}"
# When internet egress is on, node-agent would otherwise default egress probes on; force off for benches.
export FIRECRACKER_NETWORK_SLOT_EGRESS_PROBE_ON_CLAIM="${FIRECRACKER_NETWORK_SLOT_EGRESS_PROBE_ON_CLAIM:-0}"
# Skip redundant prelaunch helper sweep (destroy path still cleans); improves launch storms. Set to 1 to restore.
export FIRECRACKER_PRELAUNCH_HELPER_CLEANUP="${FIRECRACKER_PRELAUNCH_HELPER_CLEANUP:-0}"
export FIRECRACKER_SLOT_HELPER_CLEANUP_GRACE_MS="${FIRECRACKER_SLOT_HELPER_CLEANUP_GRACE_MS:-100}"
export FIRECRACKER_DYNAMIC_CPU_POLICY="${FIRECRACKER_DYNAMIC_CPU_POLICY:-0}"
export FIRECRACKER_DYNAMIC_CPU_CGROUPS="${FIRECRACKER_DYNAMIC_CPU_CGROUPS:-0}"
export FIRECRACKER_CPU_AFFINITY_LAUNCHING="${FIRECRACKER_CPU_AFFINITY_LAUNCHING:-$worker_set}"
export FIRECRACKER_CPU_AFFINITY_ACTIVE="${FIRECRACKER_CPU_AFFINITY_ACTIVE:-$worker_set}"
export FIRECRACKER_CPU_AFFINITY_INTERACTIVE_IDLE="${FIRECRACKER_CPU_AFFINITY_INTERACTIVE_IDLE:-$idle_set}"
export FIRECRACKER_CPU_AFFINITY_SOAK_IDLE="${FIRECRACKER_CPU_AFFINITY_SOAK_IDLE:-$idle_set}"

# Cap concurrent sessions in `active-navigation` (stabilizes goto under load). 0 = unlimited.
# Tune to ~½–⅔ of host vCPUs / guest vCPUs for navigation-heavy workloads (e.g. 16–24 on m5zn.metal with 2 vCPU guests).
export FIRECRACKER_MAX_CONCURRENT_ACTIVE_NAVIGATION="${FIRECRACKER_MAX_CONCURRENT_ACTIVE_NAVIGATION:-0}"

# BrowserArena parity default. Override only for explicit non-leaderboard experiments.
export BENCH_PAGE_GOTO_WAIT_UNTIL="${BENCH_PAGE_GOTO_WAIT_UNTIL:-domcontentloaded}"

pkill -f "dist/api/server.js" || true
pkill -f "dist/node-agent/server.js" || true

if [[ "${BASELAYER_RESET_STATE_ON_START:-0}" == "1" ]]; then
  rm -f "$CONTROL_PLANE_STATE_PATH"
fi

echo "housekeeping=0-${housekeeping_end}"
echo "worker=${worker_set}"
echo "idle=${idle_set}"

nohup taskset -c "0-${housekeeping_end}" \
  node "$ROOT/dist/api/server.js" \
  >"$ROOT/data/api-baremetal.log" 2>&1 < /dev/null &

nohup taskset -c "0-${housekeeping_end}" \
  node "$ROOT/dist/node-agent/server.js" \
  >"$ROOT/data/node-agent-baremetal.log" 2>&1 < /dev/null &

deadline=$((SECONDS + ${BASELAYER_START_TIMEOUT_SEC:-90}))
while ! curl -fsS "http://127.0.0.1:${CONTROL_PLANE_PORT}/health" >/dev/null; do
  if [[ "$SECONDS" -ge "$deadline" ]]; then
    echo "Timed out waiting for control plane health." >&2
    exit 1
  fi
  sleep 1
done

while ! curl -fsS "http://127.0.0.1:${NODE_AGENT_PORT}/health" >/dev/null; do
  if [[ "$SECONDS" -ge "$deadline" ]]; then
    echo "Timed out waiting for node agent health." >&2
    exit 1
  fi
  sleep 1
done

while ! curl -fsS "http://127.0.0.1:${CONTROL_PLANE_PORT}/health" | grep -Eq '"hosts":[1-9]'; do
  if [[ "$SECONDS" -ge "$deadline" ]]; then
    echo "Timed out waiting for control plane host registration." >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "http://127.0.0.1:${CONTROL_PLANE_PORT}/health"
echo
curl -fsS "http://127.0.0.1:${NODE_AGENT_PORT}/health"
echo
echo "baselayer-baremetal=started"
