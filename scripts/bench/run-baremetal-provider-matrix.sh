#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

if [[ ! -f "$ROOT/dist/api/server.js" || ! -f "$ROOT/dist/node-agent/server.js" || ! -f "$ROOT/dist/bench/provider-api.js" ]]; then
  npm run build
fi

INSTANCE_TYPE="${AWS_INSTANCE_TYPE:-unknown}"
HOST_VCPUS="${AWS_HOST_VCPUS:-$(nproc)}"
CONCURRENCY_VALUES="${BENCH_CONCURRENCY_VALUES:-}"
PROFILE_LABEL="${BENCH_PROFILE_LABEL:-baseline}"
RUNS_C1="${BENCH_MATRIX_C1_RUNS:-5}"
RUNS_DEFAULT="${BENCH_MATRIX_RUNS:-1}"
OUTDIR="${BENCH_REPORT_DIR:-$ROOT/data/benchmarks/aws-x86-host-shape/${INSTANCE_TYPE}}"
OUTPUT_PATH="${BENCH_OUT:-$OUTDIR/provider-matrix-${PROFILE_LABEL}.json}"
HOSTS_OUT="${BENCH_HOSTS_OUT:-$OUTDIR/hosts-after-${PROFILE_LABEL}.json}"

if [[ -z "$CONCURRENCY_VALUES" ]]; then
  if [[ "$HOST_VCPUS" -ge 96 ]]; then
    CONCURRENCY_VALUES="1,4,8,12,16,24,36,48,60,72,84,96"
  elif [[ "$HOST_VCPUS" -ge 72 ]]; then
    CONCURRENCY_VALUES="1,4,8,12,16,24,36,48,60,72"
  else
    CONCURRENCY_VALUES="1,4,8,12,16,24,36,48"
  fi
fi

mkdir -p "$OUTDIR"

export CONTROL_PLANE_ASYNC_SESSION_DELETE="${CONTROL_PLANE_ASYNC_SESSION_DELETE:-1}"
export FIRECRACKER_KERNEL_PATH="${FIRECRACKER_KERNEL_PATH:-$ROOT/artifacts/firecracker/vmlinux}"
export FIRECRACKER_ROOTFS_PATH="${FIRECRACKER_ROOTFS_PATH:-$ROOT/artifacts/firecracker/rootfs.ext4}"
export FIRECRACKER_SNAPSHOT_DIR="${FIRECRACKER_SNAPSHOT_DIR:-$ROOT/data/firecracker/snapshots}"
export FIRECRACKER_ALLOW_AUTO_SNAPSHOT="${FIRECRACKER_ALLOW_AUTO_SNAPSHOT:-1}"
export FIRECRACKER_ENABLE_INTERNET_EGRESS="${FIRECRACKER_ENABLE_INTERNET_EGRESS:-1}"
export FIRECRACKER_GUEST_VCPU_COUNT="${FIRECRACKER_GUEST_VCPU_COUNT:-1}"
export FIRECRACKER_GUEST_MEMORY_MB="${FIRECRACKER_GUEST_MEMORY_MB:-1024}"
export MAX_SESSIONS="${MAX_SESSIONS:-$HOST_VCPUS}"
export FIRECRACKER_MAX_MICROVM_COUNT="${FIRECRACKER_MAX_MICROVM_COUNT:-$HOST_VCPUS}"
export FIRECRACKER_NETWORK_POOL_SIZE="${FIRECRACKER_NETWORK_POOL_SIZE:-$HOST_VCPUS}"
# Align with run-basic-profiles-matrix-only.sh / start-baselayer-baremetal: probes inflate create, not goto.
export FIRECRACKER_NETWORK_SLOT_VALIDATE_ON_CLAIM="${FIRECRACKER_NETWORK_SLOT_VALIDATE_ON_CLAIM:-0}"
export FIRECRACKER_NETWORK_SLOT_EGRESS_PROBE_ON_CLAIM="${FIRECRACKER_NETWORK_SLOT_EGRESS_PROBE_ON_CLAIM:-0}"
export BENCH_PAGE_GOTO_WAIT_UNTIL="${BENCH_PAGE_GOTO_WAIT_UNTIL:-domcontentloaded}"
export BENCH_SESSION_TIMEOUT_SEC="${BENCH_SESSION_TIMEOUT_SEC:-600}"
export BENCH_SESSION_IDLE_TIMEOUT_SEC="${BENCH_SESSION_IDLE_TIMEOUT_SEC:-600}"
export BASELAYER_RESET_STATE_ON_START="${BASELAYER_RESET_STATE_ON_START:-1}"

# Staged custom shell from prepare (stage-custom-chromium-runtime.sh).
if [[ -f "${BASELAYER_CUSTENV_PATH:-$HOME/.baselayer-custenv}" ]]; then
  # shellcheck disable=SC1090
  source "${BASELAYER_CUSTENV_PATH:-$HOME/.baselayer-custenv}" || true
fi

# Fail fast on paid hosts when custom-shell profiles are requested without a
# Chromium checkout or prebuilt headless_shell + runtime blobs (see
# src/bench/lib/custom-chromium-preflight.ts).
if [[ -n "${BENCH_PROFILE_IDS:-}" ]]; then
  export BENCH_ENABLE_FIRECRACKER="${BENCH_ENABLE_FIRECRACKER:-1}"
  if [[ ! -f "$ROOT/dist/bench/verify-firecracker-assets.js" ]]; then
    npm run build
  fi
  node "$ROOT/dist/bench/verify-firecracker-assets.js" || exit 1
  # Tag provider-api JSON with the first requested profile (kernel/rootfs paths come from node-agent env).
  export BENCH_METADATA_PROFILE_ID="${BENCH_METADATA_PROFILE_ID:-$(echo "$BENCH_PROFILE_IDS" | cut -d',' -f1 | tr -d '[:space:]')}"
fi

if [[ -n "${BASELAYER_HOST_TUNING_PROFILE:-}" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT/scripts/bench/adhoc/apply-host-tuning-profile.sh" "$BASELAYER_HOST_TUNING_PROFILE"
fi

bash "$ROOT/scripts/bench/start-baselayer-baremetal.sh" "$ROOT"

BASELAYER_API_URL="http://127.0.0.1:3000" \
BENCH_CONCURRENCY_VALUES="$CONCURRENCY_VALUES" \
BENCH_MATRIX_C1_RUNS="$RUNS_C1" \
BENCH_MATRIX_RUNS="$RUNS_DEFAULT" \
BENCH_OUT="$OUTPUT_PATH" \
node "$ROOT/dist/bench/provider-api.js"

curl -fsS "http://127.0.0.1:3000/hosts" > "$HOSTS_OUT"

echo "AWS_BAREMETAL_PROVIDER_MATRIX_DONE"
echo "instance_type=$INSTANCE_TYPE"
echo "host_vcpus=$HOST_VCPUS"
echo "concurrency_values=$CONCURRENCY_VALUES"
echo "output_path=$OUTPUT_PATH"
