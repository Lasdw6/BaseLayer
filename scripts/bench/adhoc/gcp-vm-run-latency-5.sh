#!/usr/bin/env bash
# Run on Linux GCP VM after baselayer-gcp.tgz (BaseLayer tree) is in /home/$USER/
set -eu
cd /home/"${SUDO_USER:-$USER}"
if [[ ! -f baselayer-gcp.tgz ]]; then
  echo "ERROR: /home/${SUDO_USER:-$USER}/baselayer-gcp.tgz not found"
  exit 1
fi
rm -rf baselayer
tar xzf baselayer-gcp.tgz
cd baselayer

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg docker.io
sudo systemctl start docker || true
sudo chmod a+rw /var/run/docker.sock

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

node -v
npm ci
npm run build
sudo docker build -f Dockerfile.runtime -t baselayer-runtime:local .

# Latency defaults match BrowserArena hello-browser (HTTPS navigation + awaited session delete).
# Requires outbound internet on the VM. Use BENCH_USE_LOCAL_BENCH_SITE=1 for the in-repo HTTP bench page only.
export BENCH_ITERATIONS="${BENCH_ITERATIONS:-5}"
export BENCH_MIN_FREE_MEMORY_MB="${BENCH_MIN_FREE_MEMORY_MB:-256}"
export BENCH_WARMUP_ITERATIONS="${BENCH_WARMUP_ITERATIONS:-10}"
mkdir -p data/benchmarks/gcp
OUT="data/benchmarks/gcp/latency-5samples-$(date -u +%Y%m%dT%H%M%SZ).log"
echo "=== latency benchmark BENCH_ITERATIONS=$BENCH_ITERATIONS BENCH_WARMUP_ITERATIONS=$BENCH_WARMUP_ITERATIONS ===" | tee "$OUT"
set +e
node dist/bench/latency.js 2>&1 | tee -a "$OUT"
RC=${PIPESTATUS[0]}
set -e
echo "=== exit $RC ===" | tee -a "$OUT"
exit "$RC"
