#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <case-name> -- <command...>" >&2
  exit 2
fi

case_name="$1"
shift

if [[ "${1:-}" != "--" ]]; then
  echo "Usage: $0 <case-name> -- <command...>" >&2
  exit 2
fi
shift

if [[ $# -eq 0 ]]; then
  echo "No command provided." >&2
  exit 2
fi

repo_root="${BASELAYER_REPO_ROOT:-/home/ubuntu/baselayer}"
browserarena_root="${BROWSERARENA_REPO_ROOT:-/home/ubuntu/browserarena}"
session_root="${BASELAYER_AWS_SESSION_ROOT:-$repo_root/data/benchmarks/aws-session}"
case_dir="$session_root/runs/$case_name"
marker_dir="$session_root/markers"
host_metrics_root="$case_dir/host-metrics"
api_log="$repo_root/data/api-baremetal.log"
agent_log="$repo_root/data/node-agent-baremetal.log"
results_root="$browserarena_root/results/hello-browser/baselayer"
# Prefer passing BrowserArena `--out="$case_browserarena_dir"` so results are not mixed by date.
case_browserarena_dir="${BASELAYER_BROWSERARENA_OUT:-$case_dir/browserarena-run}"

mkdir -p "$case_dir" "$marker_dir" "$case_browserarena_dir"
export BASELAYER_BROWSERARENA_OUT="$case_browserarena_dir"
# Match BrowserArena parity defaults when runs execute in a fresh shell.
export BENCH_PAGE_GOTO_WAIT_UNTIL="${BENCH_PAGE_GOTO_WAIT_UNTIL:-domcontentloaded}"

rm -f "$marker_dir/$case_name.done" "$marker_dir/$case_name.failed"

metrics_pid=""
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$started_at" > "$case_dir/started_at.txt"
printf '%s\n' "$case_name" > "$case_dir/case.txt"

printenv | sort > "$case_dir/env.txt"
uname -a > "$case_dir/uname.txt"
lscpu > "$case_dir/lscpu.txt"
free -h > "$case_dir/free.txt"
lsblk > "$case_dir/lsblk.txt"
df -h > "$case_dir/df.txt"
uptime > "$case_dir/uptime-start.txt" 2>&1 || true
cat /proc/loadavg > "$case_dir/loadavg-start.txt" 2>&1 || true
sysctl \
  kernel.numa_balancing \
  kernel.sched_autogroup_enabled \
  vm.zone_reclaim_mode \
  vm.swappiness \
  vm.max_map_count \
  fs.file-max \
  net.core.somaxconn \
  net.core.netdev_max_backlog \
  net.ipv4.ip_local_port_range > "$case_dir/sysctl.txt" 2>&1 || true
ip -s link > "$case_dir/ip-link.txt" 2>&1 || true
ss -s > "$case_dir/ss.txt" 2>&1 || true
primary_if="$(ip route show default | awk '/default/ { print $5; exit }')"
if [[ -n "$primary_if" ]] && command -v ethtool >/dev/null 2>&1; then
  ethtool -S "$primary_if" > "$case_dir/ethtool.txt" 2>&1 || true
fi

if [[ -x "$repo_root/scripts/bench/collect-baremetal-host-metrics.sh" ]]; then
  INTERVAL_SEC="${INTERVAL_SEC:-1}" \
  COLLECT_PERF="${COLLECT_PERF:-1}" \
    nohup bash "$repo_root/scripts/bench/collect-baremetal-host-metrics.sh" "$host_metrics_root" \
    > "$case_dir/host-metrics-launch.log" 2>&1 &
  metrics_pid="$!"
  printf '%s\n' "$metrics_pid" > "$case_dir/host-metrics.pid"
fi

run_status=0
if ! "$@" > "$case_dir/results.log" 2>&1; then
  run_status=$?
fi

if [[ -n "$metrics_pid" ]]; then
  kill "$metrics_pid" 2>/dev/null || true
  wait "$metrics_pid" 2>/dev/null || true
fi

finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$finished_at" > "$case_dir/finished_at.txt"
printf '%s\n' "$run_status" > "$case_dir/exit_code.txt"
uptime > "$case_dir/uptime-end.txt" 2>&1 || true
cat /proc/loadavg > "$case_dir/loadavg-end.txt" 2>&1 || true

cp "$api_log" "$case_dir/api.log" 2>/dev/null || true
cp "$agent_log" "$case_dir/node-agent.log" 2>/dev/null || true
pgrep -af 'firecracker|socat|egress|chrome|chromium|lightpanda' > "$case_dir/processes-after.txt" 2>&1 || true

if [[ -d "$case_browserarena_dir" ]] && [[ -n "$(find "$case_browserarena_dir" -mindepth 1 -print -quit 2>/dev/null)" ]]; then
  tar -czf "$case_dir/browserarena-results.tgz" -C "$case_browserarena_dir" .
else
  latest_results_dir="$(find "$results_root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n 1 || true)"
  if [[ -n "$latest_results_dir" && -d "$latest_results_dir" ]]; then
    tar -czf "$case_dir/browserarena-results.tgz" -C "$latest_results_dir" .
  fi
fi

if [[ "$run_status" -eq 0 ]]; then
  touch "$marker_dir/$case_name.done"
else
  touch "$marker_dir/$case_name.failed"
fi

exit "$run_status"
