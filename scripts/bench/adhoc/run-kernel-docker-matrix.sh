#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

if [[ ! -f "$ROOT/dist/bench/kernel-docker.js" ]]; then
  npm run build
fi

KERNEL_DIR="${KERNEL_REPO_DIR:-$ROOT/vendor/kernel-images}"
KERNEL_IMAGE="${KERNEL_IMAGE:-kernel-chromium-headless}"
CONCURRENCY_VALUES="${BENCH_CONCURRENCY_VALUES:-1,4,8,12,24}"
RUNS_C1="${BENCH_MATRIX_C1_RUNS:-5}"
RUNS_DEFAULT="${BENCH_MATRIX_RUNS:-1}"
OUTDIR="${BENCH_REPORT_DIR:-$ROOT/data/benchmarks/kernel-comparison}"
OUTPUT_PATH="${BENCH_OUT:-$OUTDIR/kernel-docker-matrix.json}"

mkdir -p "$OUTDIR"

docker rm -f kernel-bench-preflight >/dev/null 2>&1 || true

(cd "$KERNEL_DIR/images/chromium-headless" && IMAGE="$KERNEL_IMAGE" ./build-docker.sh)

KERNEL_IMAGE="$KERNEL_IMAGE" \
BENCH_CONCURRENCY_VALUES="$CONCURRENCY_VALUES" \
BENCH_MATRIX_C1_RUNS="$RUNS_C1" \
BENCH_MATRIX_RUNS="$RUNS_DEFAULT" \
BENCH_OUT="$OUTPUT_PATH" \
node "$ROOT/dist/bench/kernel-docker.js"

echo "KERNEL_DOCKER_MATRIX_DONE"
echo "output_path=$OUTPUT_PATH"
