#!/usr/bin/env bash
set -euo pipefail

cd /home/ubuntu/baselayer
mkdir -p /home/ubuntu/baselayer/data/benchmarks/kernel-goto-matrix

profiles=(
  "profile-c-firecracker-snapshot baseline"
  "profile-bu-firecracker-kernel-goto kernel-goto"
  "profile-bx-firecracker-kernel-goto-lite kernel-goto-lite"
  "profile-by-firecracker-kernel-feature-prune kernel-feature-prune"
  "profile-bz-firecracker-kernel-startup-prune kernel-startup-prune"
  "profile-ca-firecracker-kernel-balanced kernel-balanced"
  "profile-bv-firecracker-kernel-goto-ipv6off kernel-goto-ipv6off"
  "profile-bw-firecracker-kernel-goto-cdp-warm kernel-goto-cdp-warm"
)

for entry in "${profiles[@]}"; do
  profile="${entry%% *}"
  label="${entry##* }"
  echo "=== RUN ${label} (${profile}) ==="
  pkill -f dist/api/server.js || true
  pkill -f dist/node-agent/server.js || true
  sleep 2
  rm -f data/api-baremetal.log data/node-agent-baremetal.log
  BENCH_PROFILE_IDS="$profile" \
  AWS_INSTANCE_TYPE=m5zn.metal \
  AWS_HOST_VCPUS=48 \
  BENCH_CONCURRENCY_VALUES=1,4,8,12,16,24 \
  BENCH_MATRIX_C1_RUNS=5 \
  BENCH_MATRIX_RUNS=1 \
  BENCH_PROFILE_LABEL="$label" \
  BENCH_REPORT_DIR=/home/ubuntu/baselayer/data/benchmarks/kernel-goto-matrix \
  CONTROL_PLANE_ASYNC_SESSION_DELETE=1 \
  FIRECRACKER_GUEST_VCPU_COUNT=1 \
  FIRECRACKER_GUEST_MEMORY_MB=1024 \
  BASELAYER_RESET_STATE_ON_START=1 \
  bash ./scripts/bench/run-baremetal-provider-matrix.sh /home/ubuntu/baselayer

  cp /home/ubuntu/baselayer/data/api-baremetal.log \
    "/home/ubuntu/baselayer/data/benchmarks/kernel-goto-matrix/api-${label}.log" || true
  cp /home/ubuntu/baselayer/data/node-agent-baremetal.log \
    "/home/ubuntu/baselayer/data/benchmarks/kernel-goto-matrix/node-agent-${label}.log" || true

  echo "=== DONE ${label} ==="
done

echo KERNEL_GOTO_MATRIX_DONE
