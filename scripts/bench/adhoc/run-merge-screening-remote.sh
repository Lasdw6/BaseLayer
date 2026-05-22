#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/home/ubuntu/baselayer}"
cd "$ROOT"

OUTDIR="${BENCH_REPORT_DIR:-$ROOT/data/benchmarks/merge-screening}"
mkdir -p "$OUTDIR"

profiles=(
  "BaseLayer-Mew-firecracker-headless-shell mew"
  "BaseLayer-Gengar-kernel-startup-prune gengar"
  "BaseLayer-Dragonite-kernel-balanced dragonite"
  "BaseLayer-Gloom-kernel-goto-lite gloom"
  "BaseLayer-Krabby-kernel-startup-prune-lite krabby"
  "BaseLayer-Kingler-kernel-balanced-lite kingler"
  "BaseLayer-Horsea-async-gengar-merge horsea"
  "BaseLayer-Seadra-async-dragonite-merge seadra"
  "BaseLayer-Goldeen-async-gloom-merge goldeen"
)

if [[ -f "$ROOT/artifacts/firecracker/rootfs-custom-shell-startup-network.ext4" ]]; then
  profiles+=(
    "BaseLayer-Staryu-custom-shell-startup-network staryu"
    "BaseLayer-Starmie-async-custom-shell-merge starmie"
  )
fi

for entry in "${profiles[@]}"; do
  profile="${entry%% *}"
  label="${entry##* }"

  echo "=== RUN ${label} (${profile}) ==="
  pkill -f "dist/api/server.js" || true
  pkill -f "dist/node-agent/server.js" || true
  rm -f data/api-baremetal.log data/node-agent-baremetal.log

  BENCH_PROFILE_IDS="$profile" \
  AWS_INSTANCE_TYPE="${AWS_INSTANCE_TYPE:-m5zn.metal}" \
  AWS_HOST_VCPUS="${AWS_HOST_VCPUS:-48}" \
  BENCH_CONCURRENCY_VALUES="${BENCH_CONCURRENCY_VALUES:-1,4,8,12,16,24}" \
  BENCH_MATRIX_C1_RUNS="${BENCH_MATRIX_C1_RUNS:-5}" \
  BENCH_MATRIX_RUNS="${BENCH_MATRIX_RUNS:-1}" \
  BENCH_PROFILE_LABEL="$label" \
  BENCH_REPORT_DIR="$OUTDIR" \
  CONTROL_PLANE_ASYNC_SESSION_DELETE="${CONTROL_PLANE_ASYNC_SESSION_DELETE:-1}" \
  FIRECRACKER_GUEST_VCPU_COUNT="${FIRECRACKER_GUEST_VCPU_COUNT:-1}" \
  FIRECRACKER_GUEST_MEMORY_MB="${FIRECRACKER_GUEST_MEMORY_MB:-1024}" \
  BASELAYER_RESET_STATE_ON_START="${BASELAYER_RESET_STATE_ON_START:-1}" \
  bash "$ROOT/scripts/bench/run-baremetal-provider-matrix.sh" "$ROOT"

  cp "$ROOT/data/api-baremetal.log" "$OUTDIR/api-${label}.log" || true
  cp "$ROOT/data/node-agent-baremetal.log" "$OUTDIR/node-agent-${label}.log" || true

  echo "=== DONE ${label} ==="
done

echo "MERGE_SCREENING_DONE"
