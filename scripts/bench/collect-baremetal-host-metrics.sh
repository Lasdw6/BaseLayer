#!/usr/bin/env bash
set -euo pipefail

# Samples host CPU, run queue, per-process CPU/memory/I/O, disk utilization, and optional perf counters.
# Requires: sysstat (mpstat, pidstat, vmstat, iostat). Optional: perf for hardware counters.
#
# Env:
#   INTERVAL_SEC   Sample interval (default 1).
#   COLLECT_PERF   Set to 0 to skip perf stat (lower overhead on busy hosts).

OUT_DIR="${1:-./data/benchmarks/baremetal-host}"
INTERVAL_SEC="${INTERVAL_SEC:-1}"
COLLECT_PERF="${COLLECT_PERF:-1}"
mkdir -p "$OUT_DIR"

timestamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
base="$OUT_DIR/$timestamp"

meta_file="${base}-meta.txt"
mpstat_file="${base}-mpstat.log"
pidstat_file="${base}-pidstat.log"
vmstat_file="${base}-vmstat.log"
iostat_file="${base}-iostat.log"
perf_file="${base}-perf.log"

{
  echo "timestamp_utc=$timestamp"
  echo "interval_sec=$INTERVAL_SEC"
  echo "uname=$(uname -a)"
  echo "hostname=$(hostname -f 2>/dev/null || hostname)"
  echo "loadavg=$(cat /proc/loadavg 2>/dev/null || true)"
  echo "uptime=$(uptime 2>/dev/null || true)"
  echo "mpstat=$(command -v mpstat 2>/dev/null || echo missing)"
  echo "pidstat=$(command -v pidstat 2>/dev/null || echo missing)"
  echo "vmstat=$(command -v vmstat 2>/dev/null || echo missing)"
  echo "iostat=$(command -v iostat 2>/dev/null || echo missing)"
  echo "perf=$(command -v perf 2>/dev/null || echo missing)"
} >"$meta_file"

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT

# Per-CPU user/system/wait/idle — which cores are hot vs I/O-wait bound.
mpstat -P ALL "$INTERVAL_SEC" >"$mpstat_file" &
# Per-process CPU, page faults / RSS, and block I/O — node-agent vs firecracker vs socat cost.
pidstat -urdh -p ALL "$INTERVAL_SEC" >"$pidstat_file" &
# Run queue (r), context switches, swap, aggregate CPU (us/sy/wa).
vmstat "$INTERVAL_SEC" >"$vmstat_file" &
# Per-disk/partition utilization, await, %util — tmpfs vs NVMe vs saturation.
if command -v iostat >/dev/null 2>&1; then
  iostat -xz "$INTERVAL_SEC" >"$iostat_file" &
else
  echo "iostat not installed (install sysstat)" >"$iostat_file"
fi

if [[ "$COLLECT_PERF" == "1" ]] && command -v perf >/dev/null 2>&1; then
  perf stat -a -I $((INTERVAL_SEC * 1000)) \
    -e cycles,instructions,cache-misses,context-switches,cpu-migrations,page-faults \
    >"$perf_file" 2>&1 &
else
  echo "perf skipped (COLLECT_PERF=$COLLECT_PERF or perf missing)" >"$perf_file"
fi

echo "collecting=1"
echo "meta=$meta_file"
echo "mpstat=$mpstat_file"
echo "pidstat=$pidstat_file"
echo "vmstat=$vmstat_file"
echo "iostat=$iostat_file"
echo "perf=$perf_file"

wait
