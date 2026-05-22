#!/usr/bin/env bash
set -euo pipefail

profile="${1:-${BASELAYER_HOST_TUNING_PROFILE:-baseline}}"

write_root() {
  local value="$1"
  local target="$2"
  if [[ "$(id -u)" -eq 0 ]]; then
    printf '%s\n' "$value" > "$target"
  else
    printf '%s\n' "$value" | sudo tee "$target" >/dev/null
  fi
}

primary_iface() {
  if [[ -n "${BASELAYER_PRIMARY_IFACE:-}" ]]; then
    echo "$BASELAYER_PRIMARY_IFACE"
    return
  fi
  ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i += 1) if ($i == "dev") { print $(i + 1); exit }}'
}

cpu_list_excluding() {
  local node="$1"
  local exclude_csv="$2"
  lscpu -p=cpu,node | awk -F, -v node="$node" -v exclude="$exclude_csv" '
    BEGIN {
      split(exclude, raw, ",");
      for (i in raw) {
        if (raw[i] == "") continue;
        if (raw[i] ~ /-/) {
          split(raw[i], bounds, "-");
          for (c = bounds[1]; c <= bounds[2]; c += 1) banned[c] = 1;
        } else {
          banned[raw[i]] = 1;
        }
      }
    }
    $1 !~ /^#/ && $2 == node && !($1 in banned) {
      out = out (out == "" ? "" : ",") $1
    }
    END { print out }
  '
}

expand_cpu_list() {
  local list="${1:-}"
  if [[ -z "$list" ]]; then
    return
  fi
  awk -v list="$list" '
    BEGIN {
      n = split(list, items, ",");
      out = "";
      for (i = 1; i <= n; i += 1) {
        if (items[i] ~ /-/) {
          split(items[i], bounds, "-");
          for (c = bounds[1]; c <= bounds[2]; c += 1) {
            out = out (out == "" ? "" : ",") c;
          }
        } else if (items[i] != "") {
          out = out (out == "" ? "" : ",") items[i];
        }
      }
      print out;
    }
  '
}

apply_thp() {
  local enabled="$1"
  local defrag="$2"
  if [[ -f /sys/kernel/mm/transparent_hugepage/enabled ]]; then
    write_root "$enabled" /sys/kernel/mm/transparent_hugepage/enabled
  fi
  if [[ -f /sys/kernel/mm/transparent_hugepage/defrag ]]; then
    write_root "$defrag" /sys/kernel/mm/transparent_hugepage/defrag
  fi
}

apply_irq_affinity() {
  local iface="$1"
  local cpu_list="$2"
  sudo systemctl stop irqbalance >/dev/null 2>&1 || true
  sudo systemctl disable irqbalance >/dev/null 2>&1 || true

  local irq_files=""
  irq_files="$(grep -l "$iface" /proc/irq/*/actions 2>/dev/null || true)"
  while IFS= read -r actions_path; do
    [[ -z "$actions_path" ]] && continue
    local irq_dir
    irq_dir="$(dirname "$actions_path")"
    if [[ -e "$irq_dir/smp_affinity_list" ]]; then
      write_root "$cpu_list" "$irq_dir/smp_affinity_list" || true
    fi
  done <<< "$irq_files"
}

housekeeping_list="${BASELAYER_HOUSEKEEPING_CPUS:-0-3}"
housekeeping_expanded="$(expand_cpu_list "$housekeeping_list")"
iface="$(primary_iface)"
nic_node="0"
if [[ -n "$iface" && -f "/sys/class/net/${iface}/device/numa_node" ]]; then
  nic_node="$(cat "/sys/class/net/${iface}/device/numa_node" 2>/dev/null || echo 0)"
fi
if [[ "$nic_node" == "-1" || -z "$nic_node" ]]; then
  nic_node="0"
fi
nic_local_cpus="$(cpu_list_excluding "$nic_node" "$housekeeping_expanded")"

case "$profile" in
  baseline)
    apply_thp "madvise" "madvise"
    ;;
  thp-always)
    apply_thp "always" "madvise"
    ;;
  irq-housekeeping)
    apply_thp "madvise" "madvise"
    if [[ -n "$iface" ]]; then
      apply_irq_affinity "$iface" "$housekeeping_list"
    fi
    ;;
  numa-nic-local)
    apply_thp "madvise" "madvise"
    export FIRECRACKER_CPU_AFFINITY_LAUNCHING="$nic_local_cpus"
    export FIRECRACKER_CPU_AFFINITY_ACTIVE="$nic_local_cpus"
    export FIRECRACKER_CPU_AFFINITY_INTERACTIVE_IDLE="$nic_local_cpus"
    export FIRECRACKER_CPU_AFFINITY_SOAK_IDLE="$nic_local_cpus"
    ;;
  numa-nic-local-irq)
    apply_thp "madvise" "madvise"
    export FIRECRACKER_CPU_AFFINITY_LAUNCHING="$nic_local_cpus"
    export FIRECRACKER_CPU_AFFINITY_ACTIVE="$nic_local_cpus"
    export FIRECRACKER_CPU_AFFINITY_INTERACTIVE_IDLE="$nic_local_cpus"
    export FIRECRACKER_CPU_AFFINITY_SOAK_IDLE="$nic_local_cpus"
    if [[ -n "$iface" ]]; then
      apply_irq_affinity "$iface" "$housekeeping_list"
    fi
    ;;
  numa-nic-local-irq-thp)
    apply_thp "always" "madvise"
    export FIRECRACKER_CPU_AFFINITY_LAUNCHING="$nic_local_cpus"
    export FIRECRACKER_CPU_AFFINITY_ACTIVE="$nic_local_cpus"
    export FIRECRACKER_CPU_AFFINITY_INTERACTIVE_IDLE="$nic_local_cpus"
    export FIRECRACKER_CPU_AFFINITY_SOAK_IDLE="$nic_local_cpus"
    if [[ -n "$iface" ]]; then
      apply_irq_affinity "$iface" "$housekeeping_list"
    fi
    ;;
  *)
    echo "Unknown BASELAYER_HOST_TUNING_PROFILE: $profile" >&2
    exit 1
    ;;
esac

echo "host_tuning_profile=$profile"
echo "host_tuning_primary_iface=${iface:-unknown}"
echo "host_tuning_nic_node=$nic_node"
echo "host_tuning_housekeeping=$housekeeping_list"
echo "host_tuning_nic_local_cpus=${nic_local_cpus:-unset}"
