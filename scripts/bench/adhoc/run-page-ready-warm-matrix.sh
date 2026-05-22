#!/usr/bin/env bash
set -euo pipefail

# Focused same-host provider/API matrix for the snapshot warm taxonomy.
# Uses only the warm levels that are still plausible real-site goto levers:
# - baseline (`BaseLayer-Mew-firecracker-headless-shell`)
# - CDP warm (`BaseLayer-Vulpix-density-cdp-warm`)
# - target warm (`BaseLayer-Jigglypuff-density-target-warm`)
# - blank-page warm (`BaseLayer-Wigglytuff-density-blank-warm`)
# - optional CDP warm + nav cap 8 (`BaseLayer-Zubat-density-cdp-warm-navcap-8`)
#
# Example:
#   BASELAYER_RUN_ID=page-ready-$(date -u +%Y%m%dT%H%M%SZ) \
#   BENCH_ROW_TIMEOUT_SEC=600 \
#   bash scripts/bench/adhoc/run-page-ready-warm-matrix.sh

ROOT="${1:-/home/ubuntu/baselayer}"
cd "$ROOT"

export BASELAYER_RUN_ID="${BASELAYER_RUN_ID:-page-ready-warm-$(date -u +%Y%m%dT%H%M%SZ)}"
export BASELAYER_MATRIX_LOG="${BASELAYER_MATRIX_LOG:-/home/ubuntu/${BASELAYER_RUN_ID}.log}"
export BASELAYER_MATRIX_ARTIFACT="${BASELAYER_MATRIX_ARTIFACT:-/home/ubuntu/${BASELAYER_RUN_ID}.tgz}"
export BASELAYER_MATRIX_CONCURRENCY_VALUES="${BASELAYER_MATRIX_CONCURRENCY_VALUES:-1,12,16,24}"
export BENCH_MATRIX_C1_RUNS="${BENCH_MATRIX_C1_RUNS:-5}"
export BENCH_MATRIX_RUNS="${BENCH_MATRIX_RUNS:-1}"
export BENCH_ROW_TIMEOUT_SEC="${BENCH_ROW_TIMEOUT_SEC:-600}"
export BASELAYER_MATRIX_SUMMARY_PHASE="${BASELAYER_MATRIX_SUMMARY_PHASE:-1}"

PROFILE_SPECS="${BASELAYER_MATRIX_PROFILE_SPECS:-BaseLayer-Mew-firecracker-headless-shell:mew,BaseLayer-Vulpix-density-cdp-warm:cdp,BaseLayer-Jigglypuff-density-target-warm:target,BaseLayer-Wigglytuff-density-blank-warm:blank,BaseLayer-Zubat-density-cdp-warm-navcap-8:cdp-nav8}"
export BASELAYER_MATRIX_PROFILE_SPECS="$PROFILE_SPECS"

echo "[page-ready-matrix] run_id=$BASELAYER_RUN_ID"
echo "[page-ready-matrix] profiles=$BASELAYER_MATRIX_PROFILE_SPECS"
echo "[page-ready-matrix] concurrency=$BASELAYER_MATRIX_CONCURRENCY_VALUES"

bash "$ROOT/scripts/bench/adhoc/run-basic-profiles-matrix-only.sh" "$ROOT"
