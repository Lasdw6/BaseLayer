import os from "node:os";
import path from "node:path";

import { agentModeSchema, type AgentMode } from "./types.js";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envString(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function envStringArray(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function envJsonRecord(name: string): Record<string, string> | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
    );
    return Object.fromEntries(entries);
  } catch {
    return undefined;
  }
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  return raw === "1" || raw.toLowerCase() === "true";
}

function envMode(name: string, fallback: AgentMode): AgentMode {
  const parsed = agentModeSchema.safeParse(process.env[name]);
  return parsed.success ? parsed.data : fallback;
}

function envChoice(name: string, fallback: string, allowed: string[]): string {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return allowed.includes(raw) ? raw : fallback;
}

export const controlPlaneConfig = {
  port: envInt("CONTROL_PLANE_PORT", 3000),
  publicOnlyV1: envBool("CONTROL_PLANE_PUBLIC_V1_ONLY", false),
  remoteCreateTimeoutMs: envInt("CONTROL_PLANE_REMOTE_CREATE_TIMEOUT_MS", 45_000),
  remoteCreateRetries: envInt("CONTROL_PLANE_REMOTE_CREATE_RETRIES", 1),
  statePath: envString(
    "CONTROL_PLANE_STATE_PATH",
    path.join(process.cwd(), "data", "control-plane.json"),
  ),
  providerHostConfigPath: envString(
    "CONTROL_PLANE_PROVIDER_HOST_CONFIG_PATH",
    path.join(process.cwd(), "config", "provider-hosts.json"),
  ),
  enforceProviderHostAllowlist: envBool("CONTROL_PLANE_ENFORCE_HOST_ALLOWLIST", false),
  providerApiKeyConfigPath: envString(
    "CONTROL_PLANE_PROVIDER_API_KEY_CONFIG_PATH",
    path.join(process.cwd(), "config", "provider-api-keys.json"),
  ),
  enforceProviderApiKeyAuth: envBool("CONTROL_PLANE_ENFORCE_PROVIDER_API_KEY_AUTH", false),
  exposeLegacyRoutes:
    !envBool("CONTROL_PLANE_PUBLIC_V1_ONLY", false) &&
    envBool("CONTROL_PLANE_EXPOSE_LEGACY_ROUTES", true),
  exposeDashboardRoutes:
    !envBool("CONTROL_PLANE_PUBLIC_V1_ONLY", false) &&
    envBool("CONTROL_PLANE_EXPOSE_DASHBOARD_ROUTES", true),
  exposeInternalRoutes:
    !envBool("CONTROL_PLANE_PUBLIC_V1_ONLY", false) &&
    envBool("CONTROL_PLANE_EXPOSE_INTERNAL_ROUTES", true),
};

export const agentConfig = {
  hostId: envString("NODE_AGENT_HOST_ID", os.hostname()),
  hostName: envString("NODE_AGENT_NAME", os.hostname()),
  region: envString("BASELAYER_REGION", ""),
  instanceType: envString("BASELAYER_INSTANCE_TYPE", ""),
  publicApiUrl: envString("NODE_AGENT_PUBLIC_API_URL", ""),
  labels: envJsonRecord("BASELAYER_HOST_LABELS"),
  supportedRuntimeProfiles: envStringArray("BASELAYER_SUPPORTED_RUNTIME_PROFILES", []),
  port: envInt("NODE_AGENT_PORT", 4000),
  controlPlaneUrl: envString("CONTROL_PLANE_URL", "http://127.0.0.1:3000"),
  apiHost: envString("NODE_AGENT_API_HOST", "127.0.0.1"),
  publicHost: envString("NODE_AGENT_PUBLIC_HOST", "127.0.0.1"),
  relayBindHost: envString("NODE_AGENT_RELAY_BIND_HOST", "0.0.0.0"),
  relayProbeHost: envString("NODE_AGENT_RELAY_PROBE_HOST", "127.0.0.1"),
  mode: envMode("NODE_AGENT_MODE", "managed"),
  heartbeatIntervalMs: envInt("NODE_AGENT_HEARTBEAT_MS", 5000),
  monitorIntervalMs: envInt("NODE_AGENT_MONITOR_MS", 5000),
  warmPoolMaintainIntervalMs: envInt("NODE_AGENT_WARM_POOL_MAINTAIN_MS", 1000),
  runtimeImage: envString("RUNTIME_IMAGE", "baselayer-runtime:local"),
  maxSessions: envInt("MAX_SESSIONS", 6),
  warmPoolSize: envInt("WARM_POOL_SIZE", 0),
  warmPoolReserve: envInt("WARM_POOL_RESERVE", 0),
  warmPoolFillConcurrency: envInt("WARM_POOL_FILL_CONCURRENCY", 3),
  warmRuntimeSettleMs: envInt("WARM_RUNTIME_SETTLE_MS", 250),
  launchAdmissionWaitMs: envInt("NODE_AGENT_LAUNCH_ADMISSION_WAIT_MS", 0),
  launchAdmissionPollMs: envInt("NODE_AGENT_LAUNCH_ADMISSION_POLL_MS", 100),
  keepFailedRuntimes: envString("KEEP_FAILED_RUNTIMES", "") === "1",
  sessionMemoryLimitMb: envInt("SESSION_MEMORY_LIMIT_MB", 384),
  sessionMemoryReservationMb: envInt("SESSION_MEMORY_RESERVATION_MB", 256),
  sessionAdmissionMemoryMb: envInt("SESSION_ADMISSION_MEMORY_MB", 192),
  sessionShmLimitMb: envInt("SESSION_SHM_LIMIT_MB", 128),
  sessionAdmissionShmMb: envInt("SESSION_ADMISSION_SHM_MB", 48),
  sessionRendererLimit: envInt("SESSION_RENDERER_LIMIT", 6),
  maxRendererCount: envInt("MAX_RENDERERS", envInt("MAX_SESSIONS", 6) * 6),
  warmRendererBudget: envInt("WARM_RENDERER_BUDGET", 3),
  minFreeMemoryMb: envInt("MIN_FREE_MEMORY_MB", 512),
  maxShmUtilizationPct: envInt("MAX_SHM_UTILIZATION_PCT", 95),
  maxCrashCount5m: envInt("MAX_CRASH_COUNT_5M", 3),
  sessionNetwork: process.env["SESSION_NETWORK"],
  firecrackerBin: envString("FIRECRACKER_BIN", "firecracker"),
  firecrackerJailerBin: process.env["FIRECRACKER_JAILER_BIN"],
  firecrackerKernelPath: envString(
    "FIRECRACKER_KERNEL_PATH",
    path.join(process.cwd(), "artifacts", "firecracker", "vmlinux"),
  ),
  firecrackerRootfsPath: envString(
    "FIRECRACKER_ROOTFS_PATH",
    path.join(process.cwd(), "artifacts", "firecracker", "rootfs.ext4"),
  ),
  firecrackerProxyRootfsPath: envString(
    "FIRECRACKER_PROXY_ROOTFS_PATH",
    path.join(process.cwd(), "artifacts", "firecracker", "rootfs-proxy.ext4"),
  ),
  firecrackerSnapshotDir: envString(
    "FIRECRACKER_SNAPSHOT_DIR",
    path.join(process.cwd(), "data", "firecracker", "snapshots"),
  ),
  firecrackerStateDir: envString(
    "FIRECRACKER_STATE_DIR",
    path.join(process.cwd(), "data", "firecracker", "state"),
  ),
  firecrackerApiDir: envString(
    "FIRECRACKER_API_DIR",
    path.join(process.cwd(), "data", "firecracker", "api"),
  ),
  firecrackerGuestBaseCidr: envString("FIRECRACKER_GUEST_BASE_CIDR", "172.22.0.0/16"),
  firecrackerNetnsBaseCidr: envString("FIRECRACKER_NETNS_BASE_CIDR", "10.200.0.0/16"),
  firecrackerTapPrefix: envString("FIRECRACKER_TAP_PREFIX", "osbr"),
  firecrackerEnableInternetEgress: envBool("FIRECRACKER_ENABLE_INTERNET_EGRESS", false),
  firecrackerEgressInterface: process.env["FIRECRACKER_EGRESS_INTERFACE"],
  firecrackerProxyPort: envInt("FIRECRACKER_PROXY_PORT", 3128),
  firecrackerProxyProfilesJson: envString("FIRECRACKER_PROXY_PROFILES_JSON", ""),
  firecrackerCdpPort: envInt("FIRECRACKER_GUEST_CDP_PORT", 9222),
  firecrackerGuestMemoryMb: envInt("FIRECRACKER_GUEST_MEMORY_MB", 1024),
  firecrackerGuestVcpuCount: envInt("FIRECRACKER_GUEST_VCPU_COUNT", 1),
  firecrackerCpuAdmissionPct: envInt("FIRECRACKER_CPU_ADMISSION_PCT", 95),
  firecrackerCpuAdmissionLoadRatio: envFloat("FIRECRACKER_CPU_ADMISSION_LOAD_RATIO", 0.85),
  firecrackerDynamicCpuPolicy: envBool("FIRECRACKER_DYNAMIC_CPU_POLICY", false),
  firecrackerDynamicCpuCgroups: envBool("FIRECRACKER_DYNAMIC_CPU_CGROUPS", false),
  firecrackerDynamicCpuMode: envChoice(
    "FIRECRACKER_DYNAMIC_CPU_MODE",
    "hybrid",
    ["always", "hybrid"],
  ),
  firecrackerActivityIdleMs: envInt("FIRECRACKER_ACTIVITY_IDLE_MS", 2_000),
  firecrackerHighPriorityBudget: envInt(
    "FIRECRACKER_HIGH_PRIORITY_BUDGET",
    Math.max(2, Math.min(8, os.cpus().length)),
  ),
  firecrackerHybridIdleSessionThreshold: envInt("FIRECRACKER_HYBRID_IDLE_SESSION_THRESHOLD", 4),
  firecrackerHybridIdleRatioThreshold: envFloat("FIRECRACKER_HYBRID_IDLE_RATIO_THRESHOLD", 0.3),
  firecrackerCpuWeightLaunching: envInt("FIRECRACKER_CPU_WEIGHT_LAUNCHING", -8),
  firecrackerCpuWeightActive: envInt("FIRECRACKER_CPU_WEIGHT_ACTIVE", -4),
  firecrackerCpuWeightInteractiveIdle: envInt("FIRECRACKER_CPU_WEIGHT_INTERACTIVE_IDLE", 0),
  firecrackerCpuWeightSoakIdle: envInt("FIRECRACKER_CPU_WEIGHT_SOAK_IDLE", 6),
  firecrackerCpuWeightLaunchingOverflow: envInt("FIRECRACKER_CPU_WEIGHT_LAUNCHING_OVERFLOW", -2),
  firecrackerCpuWeightActiveOverflow: envInt("FIRECRACKER_CPU_WEIGHT_ACTIVE_OVERFLOW", 0),
  firecrackerCpuCgroupRoot: envString("FIRECRACKER_CPU_CGROUP_ROOT", "/sys/fs/cgroup/baselayer"),
  firecrackerCpuWeightLaunchingCgroup: envInt("FIRECRACKER_CPU_WEIGHT_LAUNCHING_CGROUP", 10000),
  firecrackerCpuWeightActiveCgroup: envInt("FIRECRACKER_CPU_WEIGHT_ACTIVE_CGROUP", 8000),
  firecrackerCpuWeightInteractiveIdleCgroup: envInt(
    "FIRECRACKER_CPU_WEIGHT_INTERACTIVE_IDLE_CGROUP",
    4000,
  ),
  firecrackerCpuWeightSoakIdleCgroup: envInt("FIRECRACKER_CPU_WEIGHT_SOAK_IDLE_CGROUP", 100),
  firecrackerCpuWeightLaunchingOverflowCgroup: envInt(
    "FIRECRACKER_CPU_WEIGHT_LAUNCHING_OVERFLOW_CGROUP",
    6000,
  ),
  firecrackerCpuWeightActiveOverflowCgroup: envInt(
    "FIRECRACKER_CPU_WEIGHT_ACTIVE_OVERFLOW_CGROUP",
    4500,
  ),
  firecrackerCpuMaxLaunching: envString("FIRECRACKER_CPU_MAX_LAUNCHING", "max 100000"),
  firecrackerCpuMaxActive: envString("FIRECRACKER_CPU_MAX_ACTIVE", "max 100000"),
  firecrackerCpuMaxInteractiveIdle: envString("FIRECRACKER_CPU_MAX_INTERACTIVE_IDLE", "80000 100000"),
  firecrackerCpuMaxSoakIdle: envString("FIRECRACKER_CPU_MAX_SOAK_IDLE", "30000 100000"),
  firecrackerCpuMaxLaunchingOverflow: envString(
    "FIRECRACKER_CPU_MAX_LAUNCHING_OVERFLOW",
    "80000 100000",
  ),
  firecrackerCpuMaxActiveOverflow: envString(
    "FIRECRACKER_CPU_MAX_ACTIVE_OVERFLOW",
    "70000 100000",
  ),
  firecrackerCpuAffinityLaunching: process.env["FIRECRACKER_CPU_AFFINITY_LAUNCHING"],
  firecrackerCpuAffinityActive: process.env["FIRECRACKER_CPU_AFFINITY_ACTIVE"],
  firecrackerCpuAffinityInteractiveIdle: process.env["FIRECRACKER_CPU_AFFINITY_INTERACTIVE_IDLE"],
  firecrackerCpuAffinitySoakIdle: process.env["FIRECRACKER_CPU_AFFINITY_SOAK_IDLE"],
  firecrackerMaxMicrovmCount: envInt(
    "FIRECRACKER_MAX_MICROVM_COUNT",
    envInt("MAX_SESSIONS", 6),
  ),
  firecrackerLaunchConcurrency: envInt("FIRECRACKER_LAUNCH_CONCURRENCY", 0),
  /**
   * Concurrency cap for COLD restores only (warm-pool fallback + no-warm-profile path),
   * held on a gate separate from warm-prep so a cold-restore burst can never starve warm
   * refill. Keep small: this is the rare path; warm-prep stays on firecrackerLaunchConcurrency.
   */
  firecrackerColdRestoreConcurrency: envInt("FIRECRACKER_COLD_RESTORE_CONCURRENCY", 2),
  /** 0 = unlimited. Reject new sessions when this many microVMs are in `active-navigation` (goto pressure). */
  firecrackerMaxConcurrentActiveNavigation: envInt(
    "FIRECRACKER_MAX_CONCURRENT_ACTIVE_NAVIGATION",
    0,
  ),
  firecrackerNetworkPoolSize: envInt(
    "FIRECRACKER_NETWORK_POOL_SIZE",
    envInt("FIRECRACKER_MAX_MICROVM_COUNT", envInt("MAX_SESSIONS", 6)),
  ),
  firecrackerNetworkPoolPrepareMode: envString(
    "FIRECRACKER_NETWORK_POOL_PREPARE_MODE",
    "startup",
  ),
  firecrackerNetworkSlotRebuildTimeoutMs: envInt(
    "FIRECRACKER_NETWORK_SLOT_REBUILD_TIMEOUT_MS",
    30_000,
  ),
  firecrackerNetworkSlotValidateOnClaim: envBool(
    "FIRECRACKER_NETWORK_SLOT_VALIDATE_ON_CLAIM",
    false,
  ),
  /**
   * When unset, falls back to whether internet egress is enabled: with egress on,
   * probes default to true unless explicitly disabled. `scripts/bench/start-baselayer-baremetal.sh`
   * therefore exports `FIRECRACKER_NETWORK_SLOT_EGRESS_PROBE_ON_CLAIM=0` so benchmark hosts do not
   * pay probe latency during `session_creation_ms` (see aws-custom-lanes-session-2026-04-18).
   */
  firecrackerNetworkSlotEgressProbeOnClaim: envBool(
    "FIRECRACKER_NETWORK_SLOT_EGRESS_PROBE_ON_CLAIM",
    envBool("FIRECRACKER_ENABLE_INTERNET_EGRESS", false),
  ),
  firecrackerNetworkSlotEgressProbeTargets: envString(
    "FIRECRACKER_NETWORK_SLOT_EGRESS_PROBE_TARGETS",
    "1.1.1.1:53,8.8.8.8:53",
  ),
  firecrackerNetworkSlotEgressProbeTimeoutMs: envInt(
    "FIRECRACKER_NETWORK_SLOT_EGRESS_PROBE_TIMEOUT_MS",
    1500,
  ),
  firecrackerSlotHelperCleanupGraceMs: envInt(
    "FIRECRACKER_SLOT_HELPER_CLEANUP_GRACE_MS",
    180,
  ),
  firecrackerPrelaunchHelperCleanupGraceMs: envInt(
    "FIRECRACKER_PRELAUNCH_HELPER_CLEANUP_GRACE_MS",
    20,
  ),
  /** After SIGTERM to processes in a network namespace, wait before SIGKILL (was 500 ms). */
  firecrackerNetnsCleanupTermMs: envInt("FIRECRACKER_NETNS_CLEANUP_TERM_MS", 250),
  /** After SIGTERM during stale host cleanup, wait before reaping with SIGKILL (was 500 ms). */
  firecrackerStaleCleanupTermMs: envInt("FIRECRACKER_STALE_CLEANUP_TERM_MS", 250),
  firecrackerPrelaunchHelperCleanup: envBool("FIRECRACKER_PRELAUNCH_HELPER_CLEANUP", true),
  firecrackerRestoreTimeoutMs: envInt("FIRECRACKER_RESTORE_TIMEOUT_MS", 30_000),
  firecrackerRestoreRetries: envInt("FIRECRACKER_RESTORE_RETRIES", 1),
  firecrackerWarmClaimTimeoutMs: envInt("FIRECRACKER_WARM_CLAIM_TIMEOUT_MS", 10_000),
  firecrackerWarmWaitMs: envInt("FIRECRACKER_WARM_WAIT_MS", 0),
  firecrackerWarmFallbackToCold: envBool("FIRECRACKER_WARM_FALLBACK_TO_COLD", true),
  firecrackerWarmKeepaliveIntervalMs: envInt("FIRECRACKER_WARM_KEEPALIVE_INTERVAL_MS", 2_000),
  firecrackerReadySettleMs: envInt("FIRECRACKER_READY_SETTLE_MS", 0),
  firecrackerBootTimeoutMs: envInt("FIRECRACKER_BOOT_TIMEOUT_MS", 60_000),
  firecrackerSnapshotTimeoutMs: envInt("FIRECRACKER_SNAPSHOT_TIMEOUT_MS", 60_000),
  firecrackerSnapshotWarmPage: envBool("FIRECRACKER_SNAPSHOT_WARM_PAGE", true),
  firecrackerSnapshotWarmLevel: envString(
    "FIRECRACKER_SNAPSHOT_WARM_LEVEL",
    envBool("FIRECRACKER_SNAPSHOT_WARM_PAGE", true) ? "trivial" : "cdp",
  ),
  firecrackerSnapshotWarmUrl: envString("FIRECRACKER_SNAPSHOT_WARM_URL", ""),
  firecrackerPrecreateTargetUrl: envString("FIRECRACKER_PRECREATE_TARGET_URL", ""),
  firecrackerGuestBootArgsExtra: envString("FIRECRACKER_GUEST_BOOT_ARGS_EXTRA", ""),
  firecrackerAllowAutoSnapshot: envBool("FIRECRACKER_ALLOW_AUTO_SNAPSHOT", false),
  firecrackerTrackDirtyPages: envBool("FIRECRACKER_TRACK_DIRTY_PAGES", false),
  firecrackerEnableDiffSnapshots: envBool("FIRECRACKER_ENABLE_DIFF_SNAPSHOTS", false),
  firecrackerSnapshotName: envString("FIRECRACKER_SNAPSHOT_NAME", "base"),
  firecrackerProxySnapshotName: envString("FIRECRACKER_PROXY_SNAPSHOT_NAME", "base-proxy"),
};

export const runtimeConfig = {
  port: envInt("RUNTIME_PORT", 3001),
  cdpPort: envInt("RUNTIME_CDP_PORT", 9222),
  healthPort: envInt("RUNTIME_HEALTH_PORT", 8081),
  wsPath: envString("PLAYWRIGHT_WS_PATH", "/playwright"),
};
