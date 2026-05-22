#!/usr/bin/env bash
set -euo pipefail
# Optional: BASELAYER_MATRIX_SUMMARY_PHASE=1 prints phaseSummaryP50 / navigationBreakdownP50 for every
# provider-api.json under RESULT_ROOT (see scripts/bench/adhoc/summarize-provider-phase-summary.mjs).

ROOT="${1:-/home/ubuntu/baselayer}"
LOG="${BASELAYER_MATRIX_LOG:-/home/ubuntu/basic-profiles-matrix.log}"
RUN_ID="${BASELAYER_RUN_ID:-basic-profiles-$(date -u +%Y%m%dT%H%M%SZ)}"
RESULT_ROOT="${BENCH_REPORT_DIR:-$ROOT/data/benchmarks/$RUN_ID}"
ARTIFACT_TGZ="${BASELAYER_MATRIX_ARTIFACT:-/home/ubuntu/${RUN_ID}.tgz}"

exec > >(tee -a "$LOG") 2>&1

cd "$ROOT"

if [[ ! -f "$ROOT/dist/api/server.js" || ! -f "$ROOT/dist/node-agent/server.js" || ! -f "$ROOT/dist/bench/provider-api.js" ]]; then
  npm run build
fi

export AWS_INSTANCE_TYPE="${AWS_INSTANCE_TYPE:-m5zn.metal}"
export AWS_HOST_VCPUS="${AWS_HOST_VCPUS:-$(nproc)}"
export CONTROL_PLANE_ASYNC_SESSION_DELETE="${CONTROL_PLANE_ASYNC_SESSION_DELETE:-1}"
export CONTROL_PLANE_ASYNC_SESSION_DELETE_MODE="${CONTROL_PLANE_ASYNC_SESSION_DELETE_MODE:-detach}"
export FIRECRACKER_ALLOW_AUTO_SNAPSHOT="${FIRECRACKER_ALLOW_AUTO_SNAPSHOT:-1}"
export FIRECRACKER_ENABLE_INTERNET_EGRESS="${FIRECRACKER_ENABLE_INTERNET_EGRESS:-1}"
export FIRECRACKER_GUEST_VCPU_COUNT="${FIRECRACKER_GUEST_VCPU_COUNT:-1}"
export FIRECRACKER_GUEST_MEMORY_MB="${FIRECRACKER_GUEST_MEMORY_MB:-1024}"
export MAX_SESSIONS="${MAX_SESSIONS:-$AWS_HOST_VCPUS}"
export FIRECRACKER_MAX_MICROVM_COUNT="${FIRECRACKER_MAX_MICROVM_COUNT:-$AWS_HOST_VCPUS}"
export FIRECRACKER_NETWORK_POOL_SIZE="${FIRECRACKER_NETWORK_POOL_SIZE:-$AWS_HOST_VCPUS}"
export FIRECRACKER_NETWORK_SLOT_VALIDATE_ON_CLAIM="${FIRECRACKER_NETWORK_SLOT_VALIDATE_ON_CLAIM:-0}"
export FIRECRACKER_NETWORK_SLOT_EGRESS_PROBE_ON_CLAIM="${FIRECRACKER_NETWORK_SLOT_EGRESS_PROBE_ON_CLAIM:-0}"
export BENCH_PAGE_GOTO_WAIT_UNTIL="${BENCH_PAGE_GOTO_WAIT_UNTIL:-domcontentloaded}"
export BENCH_SESSION_TIMEOUT_SEC="${BENCH_SESSION_TIMEOUT_SEC:-600}"
export BENCH_SESSION_IDLE_TIMEOUT_SEC="${BENCH_SESSION_IDLE_TIMEOUT_SEC:-600}"
export BENCH_FIRECRACKER_MAX_SESSIONS="${BENCH_FIRECRACKER_MAX_SESSIONS:-$AWS_HOST_VCPUS}"
export BENCH_FIRECRACKER_MAX_MICROVM_COUNT="${BENCH_FIRECRACKER_MAX_MICROVM_COUNT:-$AWS_HOST_VCPUS}"
export BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS="${BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS:-1}"
export BENCH_FIRECRACKER_GUEST_VCPU_COUNT="${BENCH_FIRECRACKER_GUEST_VCPU_COUNT:-1}"
export BENCH_FIRECRACKER_GUEST_MEMORY_MB="${BENCH_FIRECRACKER_GUEST_MEMORY_MB:-1024}"
export BASELAYER_RESET_STATE_ON_START=1

PROFILE_SPECS="${BASELAYER_MATRIX_PROFILE_SPECS:-${BENCH_PROFILE_SPECS:-BaseLayer-Mew-firecracker-headless-shell:mew,BaseLayer-Gengar-kernel-startup-prune:gengar,BaseLayer-Dragonite-kernel-balanced:dragonite}}"
CONCURRENCY_VALUES="${BASELAYER_MATRIX_CONCURRENCY_VALUES:-${BENCH_CONCURRENCY_VALUES:-1,2,4,6,8,9,12,16,24}}"
C1_RUNS="${BENCH_MATRIX_C1_RUNS:-5}"
DEFAULT_RUNS="${BENCH_MATRIX_RUNS:-1}"
ROW_TIMEOUT_SEC="${BENCH_ROW_TIMEOUT_SEC:-300}"

mkdir -p "$RESULT_ROOT"
echo "[matrix-only] started $(date -Is)"
echo "[matrix-only] result_root=$RESULT_ROOT"
echo "[matrix-only] profiles=$PROFILE_SPECS"
echo "[matrix-only] concurrency=$CONCURRENCY_VALUES"

stop_runtime() {
  pkill -f "dist/api/server.js" || true
  pkill -f "dist/node-agent/server.js" || true
  sleep 1
}

start_runtime() {
  stop_runtime
  rm -f "$ROOT/data/baremetal-state.json"
  bash "$ROOT/scripts/bench/start-baselayer-baremetal.sh" "$ROOT" >/tmp/baselayer-start.log 2>&1
}

wait_for_quiet_host() {
  local deadline=$((SECONDS + ${BASELAYER_HOST_QUIET_TIMEOUT_SEC:-45}))
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    if curl -fsS http://127.0.0.1:3000/hosts 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);const h=p.hosts?.[0];process.exit(h && (h.metrics?.activeSessions??0)===0 ? 0 : 1);})'
    then
      return 0
    fi
    sleep 1
  done
  return 1
}

IFS=',' read -r -a profile_specs <<< "$PROFILE_SPECS"
IFS=',' read -r -a concurrency_values <<< "$CONCURRENCY_VALUES"

for spec in "${profile_specs[@]}"; do
  profile="${spec%%:*}"
  label="${spec#*:}"
  if [[ "$label" == "$profile" ]]; then
    label="$(echo "$profile" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-')"
  fi
  profile_dir="$RESULT_ROOT/$label"
  mkdir -p "$profile_dir"

  echo "[matrix-only] profile=$profile label=$label start $(date -Is)"
  rm -rf "$ROOT/data/firecracker/snapshots"
  mkdir -p "$ROOT/data/firecracker/snapshots"

  for c in "${concurrency_values[@]}"; do
    c="$(echo "$c" | xargs)"
    [[ -z "$c" ]] && continue
    runs="$DEFAULT_RUNS"
    if [[ "$c" == "1" ]]; then
      runs="$C1_RUNS"
    fi
    outdir="$profile_dir/c$c"
    mkdir -p "$outdir"
    expected="$runs"
    if [[ "$c" != "1" ]]; then
      expected="$c"
    fi
    if [[ -f "$outdir/provider-api.json" ]] && node -e 'const fs=require("fs");const f=process.argv[1];const expected=Number(process.argv[2]);const r=JSON.parse(fs.readFileSync(f,"utf8"));const success=r.successCount??0;const failure=r.failureCount??0;process.exit(success===expected && failure===0 ? 0 : 1)' "$outdir/provider-api.json" "$expected" 2>/dev/null; then
      echo "[matrix-only] profile=$profile label=$label c=$c skip-existing $(date -Is)"
      continue
    fi

    echo "[matrix-only] profile=$profile label=$label c=$c runs=$runs start $(date -Is)"
    start_runtime
    set +e
    BASELAYER_API_URL=http://127.0.0.1:3000 \
      BASELAYER_RUNTIME_PROFILE="$profile" \
      BENCH_CONCURRENCY="$c" \
      BENCH_CONCURRENCY_VALUES="" \
      BENCH_PRINT_PHASE_SUMMARY="${BENCH_PRINT_PHASE_SUMMARY:-${BASELAYER_MATRIX_SUMMARY_PHASE:-0}}" \
      BENCH_RUNS="$runs" \
      BENCH_OUT="$outdir/provider-api.json" \
      timeout "$ROW_TIMEOUT_SEC" node "$ROOT/dist/bench/provider-api.js" \
      > "$outdir/provider-api.stdout.json" 2> "$outdir/provider-api.stderr.log"
    row_exit=$?
    set -e
    curl -fsS http://127.0.0.1:3000/hosts > "$outdir/hosts-after.json" || true
    cp "$ROOT/data/api-baremetal.log" "$outdir/api-baremetal.log" || true
    cp "$ROOT/data/node-agent-baremetal.log" "$outdir/node-agent-baremetal.log" || true
    wait_for_quiet_host || echo "[matrix-only] warning: host did not become quiet after c=$c"
    if [[ "$row_exit" -ne 0 ]]; then
      printf '{"profile":"%s","label":"%s","concurrency":%s,"exitCode":%s,"timeoutSec":%s,"timestamp":"%s"}\n' \
        "$profile" "$label" "$c" "$row_exit" "$ROW_TIMEOUT_SEC" "$(date -Is)" > "$outdir/provider-api-failure.json"
      echo "[matrix-only] profile=$profile label=$label c=$c failed exit=$row_exit $(date -Is)"
      continue
    fi
    echo "[matrix-only] profile=$profile label=$label c=$c done $(date -Is)"
  done

  echo "[matrix-only] profile=$profile label=$label done $(date -Is)"
done

if [[ "${BASELAYER_MATRIX_SUMMARY_PHASE:-0}" == "1" ]]; then
  echo "[matrix-only] phase summary $(date -Is)"
  node "$ROOT/scripts/bench/adhoc/summarize-provider-phase-summary.mjs" "$RESULT_ROOT" || true
fi

stop_runtime
tar -czf "$ARTIFACT_TGZ" -C "$ROOT" "${RESULT_ROOT#$ROOT/}" data/api-baremetal.log data/node-agent-baremetal.log
echo "[matrix-only] artifact=$ARTIFACT_TGZ"
echo "[matrix-only] done $(date -Is)"
