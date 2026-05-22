import path from "node:path";

import {
  type ProfileConfig,
  type SupportedProfileConfig,
  type SupportedProfileId,
} from "./types.js";

function managedExperimentEnv(options: {
  maxSessions?: string;
  warmPoolSize?: string;
  warmPoolReserve?: string;
  warmPoolFillConcurrency?: string;
  warmRuntimeSettleMs?: string;
  warmRendererBudget?: string;
  sessionMemoryLimitMb?: string;
  sessionMemoryReservationMb?: string;
  sessionAdmissionMemoryMb?: string;
  sessionShmLimitMb?: string;
  sessionAdmissionShmMb?: string;
  sessionRendererLimit?: string;
  maxRenderers?: string;
}): Record<string, string> {
  return {
    MAX_SESSIONS: process.env["BENCH_MAX_SESSIONS"] ?? options.maxSessions ?? "6",
    MIN_FREE_MEMORY_MB: process.env["BENCH_MIN_FREE_MEMORY_MB"] ?? "0",
    WARM_POOL_SIZE: process.env["BENCH_WARM_POOL_SIZE"] ?? options.warmPoolSize ?? "6",
    WARM_POOL_RESERVE: process.env["BENCH_WARM_POOL_RESERVE"] ?? options.warmPoolReserve ?? "1",
    WARM_POOL_FILL_CONCURRENCY:
      process.env["BENCH_WARM_POOL_FILL_CONCURRENCY"] ?? options.warmPoolFillConcurrency ?? "6",
    WARM_RUNTIME_SETTLE_MS:
      process.env["BENCH_WARM_RUNTIME_SETTLE_MS"] ?? options.warmRuntimeSettleMs ?? "250",
    WARM_RENDERER_BUDGET:
      process.env["BENCH_WARM_RENDERER_BUDGET"] ?? options.warmRendererBudget ?? "3",
    SESSION_MEMORY_LIMIT_MB:
      process.env["BENCH_SESSION_MEMORY_LIMIT_MB"] ?? options.sessionMemoryLimitMb ?? "384",
    SESSION_MEMORY_RESERVATION_MB:
      process.env["BENCH_SESSION_MEMORY_RESERVATION_MB"] ??
      options.sessionMemoryReservationMb ??
      "256",
    SESSION_ADMISSION_MEMORY_MB:
      process.env["BENCH_SESSION_ADMISSION_MEMORY_MB"] ??
      options.sessionAdmissionMemoryMb ??
      "192",
    SESSION_SHM_LIMIT_MB:
      process.env["BENCH_SESSION_SHM_LIMIT_MB"] ?? options.sessionShmLimitMb ?? "128",
    SESSION_ADMISSION_SHM_MB:
      process.env["BENCH_SESSION_ADMISSION_SHM_MB"] ?? options.sessionAdmissionShmMb ?? "48",
    SESSION_RENDERER_LIMIT:
      process.env["BENCH_SESSION_RENDERER_LIMIT"] ?? options.sessionRendererLimit ?? "6",
    MAX_RENDERERS: process.env["BENCH_MAX_RENDERERS"] ?? options.maxRenderers ?? "36",
  };
}

function firecrackerExperimentEnv(options: {
  envPrefix: string;
  snapshotName: string;
  tapPrefix: string;
  rootfsPath?: string;
  memoryMb?: string;
  vcpuCount?: string;
  warmPage?: string;
  warmLevel?: string;
  dynamicCpuPolicy?: string;
  dynamicCpuCgroups?: string;
  dynamicCpuMode?: string;
  networkSlotValidateOnClaim?: string;
  slotHelperCleanupGraceMs?: string;
  snapshotWarmUrl?: string;
  /** 0 = unlimited. Limits sessions concurrently in `active-navigation` (goto pressure). */
  maxConcurrentActiveNavigation?: string;
  /** 0 = unlimited. Limits simultaneous microVM launches (launch pacing vs navigation admission). */
  launchConcurrency?: string;
}): Record<string, string> {
  const specific = (name: string): string | undefined =>
    process.env[`BENCH_${options.envPrefix}_${name}`] ??
    process.env[`FIRECRACKER_${options.envPrefix}_${name}`];

  return {
    MAX_SESSIONS: process.env["BENCH_FIRECRACKER_MAX_SESSIONS"] ?? "6",
    MIN_FREE_MEMORY_MB: process.env["BENCH_MIN_FREE_MEMORY_MB"] ?? "0",
    FIRECRACKER_MAX_MICROVM_COUNT:
      process.env["BENCH_FIRECRACKER_MAX_MICROVM_COUNT"] ?? "6",
    FIRECRACKER_GUEST_MEMORY_MB:
      specific("GUEST_MEMORY_MB") ??
      process.env["BENCH_FIRECRACKER_GUEST_MEMORY_MB"] ??
      options.memoryMb ??
      "1024",
    FIRECRACKER_GUEST_VCPU_COUNT:
      specific("GUEST_VCPU_COUNT") ??
      process.env["BENCH_FIRECRACKER_GUEST_VCPU_COUNT"] ??
      options.vcpuCount ??
      "1",
    FIRECRACKER_RESTORE_TIMEOUT_MS:
      process.env["BENCH_FIRECRACKER_RESTORE_TIMEOUT_MS"] ?? "30000",
    FIRECRACKER_BOOT_TIMEOUT_MS:
      process.env["BENCH_FIRECRACKER_BOOT_TIMEOUT_MS"] ?? "60000",
    FIRECRACKER_KERNEL_PATH:
      process.env["BENCH_FIRECRACKER_KERNEL_PATH"] ??
      process.env["FIRECRACKER_KERNEL_PATH"] ??
      "",
    FIRECRACKER_ROOTFS_PATH:
      specific("ROOTFS_PATH") ??
      options.rootfsPath ??
      process.env["BENCH_FIRECRACKER_ROOTFS_PATH"] ??
      process.env["FIRECRACKER_ROOTFS_PATH"] ??
      "",
    FIRECRACKER_SNAPSHOT_DIR:
      specific("SNAPSHOT_DIR") ??
      path.join(process.cwd(), "data", "firecracker", `snapshots-${options.snapshotName}`),
    FIRECRACKER_STATE_DIR:
      specific("STATE_DIR") ??
      process.env["BENCH_FIRECRACKER_STATE_DIR"] ??
      process.env["FIRECRACKER_STATE_DIR"] ??
      path.join(process.cwd(), "data", "firecracker", `state-${options.snapshotName}`),
    FIRECRACKER_API_DIR:
      specific("API_DIR") ??
      process.env["BENCH_FIRECRACKER_API_DIR"] ??
      process.env["FIRECRACKER_API_DIR"] ??
      path.join(process.cwd(), "data", "firecracker", `api-${options.snapshotName}`),
    FIRECRACKER_TAP_PREFIX: specific("TAP_PREFIX") ?? options.tapPrefix,
    FIRECRACKER_ENABLE_INTERNET_EGRESS:
      process.env["BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS"] ??
      process.env["FIRECRACKER_ENABLE_INTERNET_EGRESS"] ??
      "1",
    FIRECRACKER_EGRESS_INTERFACE:
      process.env["BENCH_FIRECRACKER_EGRESS_INTERFACE"] ??
      process.env["FIRECRACKER_EGRESS_INTERFACE"] ??
      "",
    FIRECRACKER_ALLOW_AUTO_SNAPSHOT:
      process.env["BENCH_FIRECRACKER_ALLOW_AUTO_SNAPSHOT"] ??
      process.env["FIRECRACKER_ALLOW_AUTO_SNAPSHOT"] ??
      "1",
    FIRECRACKER_SNAPSHOT_NAME: options.snapshotName,
    FIRECRACKER_SNAPSHOT_WARM_PAGE:
      specific("SNAPSHOT_WARM_PAGE") ??
      process.env["BENCH_FIRECRACKER_SNAPSHOT_WARM_PAGE"] ??
      options.warmPage ??
      "1",
    FIRECRACKER_SNAPSHOT_WARM_LEVEL:
      specific("SNAPSHOT_WARM_LEVEL") ??
      process.env["BENCH_FIRECRACKER_SNAPSHOT_WARM_LEVEL"] ??
      options.warmLevel ??
      "trivial",
    FIRECRACKER_SNAPSHOT_WARM_URL:
      specific("SNAPSHOT_WARM_URL") ??
      process.env["BENCH_FIRECRACKER_SNAPSHOT_WARM_URL"] ??
      options.snapshotWarmUrl ??
      "",
    FIRECRACKER_DYNAMIC_CPU_POLICY: options.dynamicCpuPolicy ?? "0",
    FIRECRACKER_DYNAMIC_CPU_CGROUPS: options.dynamicCpuCgroups ?? "0",
    FIRECRACKER_DYNAMIC_CPU_MODE: options.dynamicCpuMode ?? "hybrid",
    FIRECRACKER_NETWORK_SLOT_VALIDATE_ON_CLAIM:
      options.networkSlotValidateOnClaim ?? "0",
    FIRECRACKER_SLOT_HELPER_CLEANUP_GRACE_MS:
      options.slotHelperCleanupGraceMs ?? "180",
    FIRECRACKER_MAX_CONCURRENT_ACTIVE_NAVIGATION:
      process.env["BENCH_FIRECRACKER_MAX_CONCURRENT_ACTIVE_NAVIGATION"] ??
      options.maxConcurrentActiveNavigation ??
      "0",
    FIRECRACKER_LAUNCH_CONCURRENCY:
      process.env["BENCH_FIRECRACKER_LAUNCH_CONCURRENCY"] ??
      options.launchConcurrency ??
      "0",
  };
}

export const BENCHMARK_PROFILES: ProfileConfig[] = [
  {
    id: "BaseLayer-Bulbasaur-generic-container",
    label: "Profile A: Generic Container Worker",
    benchmarkSupport: "supported",
    mode: "baseline",
    description:
      "Generic multi-session container worker with static concurrency admission.",
    defaultAgentEnv: {
      MAX_SESSIONS: process.env["BENCH_MAX_SESSIONS"] ?? "6",
    },
  },
  {
    id: "BaseLayer-Charizard-managed-node",
    label: "Profile B: Optimized Multi-Session Browser Node",
    benchmarkSupport: "supported",
    mode: "managed",
    description:
      "Browser-aware node agent with admission control and host-native supervision.",
    defaultAgentEnv: {
      MAX_SESSIONS: process.env["BENCH_MAX_SESSIONS"] ?? "6",
      MIN_FREE_MEMORY_MB: process.env["BENCH_MIN_FREE_MEMORY_MB"] ?? "0",
      WARM_POOL_SIZE: process.env["BENCH_WARM_POOL_SIZE"] ?? "6",
      WARM_POOL_RESERVE:
        process.env["BENCH_WARM_POOL_RESERVE"] ??
        "1",
      WARM_POOL_FILL_CONCURRENCY: process.env["BENCH_WARM_POOL_FILL_CONCURRENCY"] ?? "6",
      WARM_RUNTIME_SETTLE_MS: process.env["BENCH_WARM_RUNTIME_SETTLE_MS"] ?? "400",
      WARM_RENDERER_BUDGET: process.env["BENCH_WARM_RENDERER_BUDGET"] ?? "3",
      SESSION_MEMORY_LIMIT_MB: process.env["BENCH_SESSION_MEMORY_LIMIT_MB"] ?? "512",
      SESSION_MEMORY_RESERVATION_MB:
        process.env["BENCH_SESSION_MEMORY_RESERVATION_MB"] ?? "384",
      SESSION_ADMISSION_MEMORY_MB:
        process.env["BENCH_SESSION_ADMISSION_MEMORY_MB"] ?? "192",
      SESSION_SHM_LIMIT_MB: process.env["BENCH_SESSION_SHM_LIMIT_MB"] ?? "128",
      SESSION_ADMISSION_SHM_MB: process.env["BENCH_SESSION_ADMISSION_SHM_MB"] ?? "48",
      SESSION_RENDERER_LIMIT: process.env["BENCH_SESSION_RENDERER_LIMIT"] ?? "6",
      MAX_RENDERERS: process.env["BENCH_MAX_RENDERERS"] ?? "36",
    },
  },
  {
    id: "BaseLayer-Mew-firecracker-headless-shell",
    label: "Profile C: Firecracker Snapshot Tier",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Firecracker-backed per-session tier restored from a clean base snapshot.",
    defaultAgentEnv: {
      MAX_SESSIONS: process.env["BENCH_FIRECRACKER_MAX_SESSIONS"] ?? "1",
      MIN_FREE_MEMORY_MB: process.env["BENCH_MIN_FREE_MEMORY_MB"] ?? "0",
      FIRECRACKER_MAX_MICROVM_COUNT:
        process.env["BENCH_FIRECRACKER_MAX_MICROVM_COUNT"] ?? "1",
      FIRECRACKER_GUEST_MEMORY_MB:
        process.env["BENCH_FIRECRACKER_GUEST_MEMORY_MB"] ?? "1024",
      FIRECRACKER_GUEST_VCPU_COUNT:
        process.env["BENCH_FIRECRACKER_GUEST_VCPU_COUNT"] ?? "2",
      FIRECRACKER_RESTORE_TIMEOUT_MS:
        process.env["BENCH_FIRECRACKER_RESTORE_TIMEOUT_MS"] ?? "30000",
      FIRECRACKER_BOOT_TIMEOUT_MS:
        process.env["BENCH_FIRECRACKER_BOOT_TIMEOUT_MS"] ?? "60000",
      FIRECRACKER_KERNEL_PATH:
        process.env["BENCH_FIRECRACKER_KERNEL_PATH"] ??
        process.env["FIRECRACKER_KERNEL_PATH"] ??
        "",
      FIRECRACKER_ROOTFS_PATH:
        process.env["BENCH_FIRECRACKER_ROOTFS_PATH"] ??
        process.env["FIRECRACKER_ROOTFS_PATH"] ??
        "",
      FIRECRACKER_SNAPSHOT_DIR:
        process.env["BENCH_FIRECRACKER_SNAPSHOT_DIR"] ??
        process.env["FIRECRACKER_SNAPSHOT_DIR"] ??
        "",
      FIRECRACKER_STATE_DIR:
        process.env["BENCH_FIRECRACKER_STATE_DIR"] ??
        process.env["FIRECRACKER_STATE_DIR"] ??
        "",
      FIRECRACKER_API_DIR:
        process.env["BENCH_FIRECRACKER_API_DIR"] ??
        process.env["FIRECRACKER_API_DIR"] ??
        "",
      FIRECRACKER_TAP_PREFIX:
        process.env["BENCH_FIRECRACKER_TAP_PREFIX"] ??
        process.env["FIRECRACKER_TAP_PREFIX"] ??
        "",
      FIRECRACKER_ENABLE_INTERNET_EGRESS:
        process.env["BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS"] ??
        process.env["FIRECRACKER_ENABLE_INTERNET_EGRESS"] ??
        "1",
      FIRECRACKER_EGRESS_INTERFACE:
        process.env["BENCH_FIRECRACKER_EGRESS_INTERFACE"] ??
        process.env["FIRECRACKER_EGRESS_INTERFACE"] ??
        "",
      FIRECRACKER_ALLOW_AUTO_SNAPSHOT:
        process.env["BENCH_FIRECRACKER_ALLOW_AUTO_SNAPSHOT"] ??
        process.env["FIRECRACKER_ALLOW_AUTO_SNAPSHOT"] ??
        "1",
      FIRECRACKER_SNAPSHOT_WARM_PAGE:
        process.env["BENCH_FIRECRACKER_SNAPSHOT_WARM_PAGE"] ??
        process.env["FIRECRACKER_SNAPSHOT_WARM_PAGE"] ??
        "1",
    },
  },
  {
    id: "BaseLayer-Ivysaur-firecracker-vanilla",
    label: "Profile D: Firecracker Vanilla Chrome",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Firecracker-backed per-session tier restored from a minimally configured Chrome snapshot.",
    defaultAgentEnv: {
      MAX_SESSIONS: process.env["BENCH_FIRECRACKER_MAX_SESSIONS"] ?? "1",
      MIN_FREE_MEMORY_MB: process.env["BENCH_MIN_FREE_MEMORY_MB"] ?? "0",
      FIRECRACKER_MAX_MICROVM_COUNT:
        process.env["BENCH_FIRECRACKER_MAX_MICROVM_COUNT"] ?? "1",
      FIRECRACKER_GUEST_MEMORY_MB:
        process.env["BENCH_FIRECRACKER_GUEST_MEMORY_MB"] ?? "1024",
      FIRECRACKER_GUEST_VCPU_COUNT:
        process.env["BENCH_FIRECRACKER_GUEST_VCPU_COUNT"] ?? "2",
      FIRECRACKER_RESTORE_TIMEOUT_MS:
        process.env["BENCH_FIRECRACKER_RESTORE_TIMEOUT_MS"] ?? "30000",
      FIRECRACKER_BOOT_TIMEOUT_MS:
        process.env["BENCH_FIRECRACKER_BOOT_TIMEOUT_MS"] ?? "60000",
      FIRECRACKER_KERNEL_PATH:
        process.env["BENCH_FIRECRACKER_KERNEL_PATH"] ??
        process.env["FIRECRACKER_KERNEL_PATH"] ??
        "",
      FIRECRACKER_ROOTFS_PATH:
        process.env["BENCH_FIRECRACKER_VANILLA_ROOTFS_PATH"] ??
        process.env["FIRECRACKER_VANILLA_ROOTFS_PATH"] ??
        path.join(process.cwd(), "artifacts", "firecracker", "rootfs-vanilla.ext4"),
      FIRECRACKER_SNAPSHOT_DIR:
        process.env["BENCH_FIRECRACKER_VANILLA_SNAPSHOT_DIR"] ??
        process.env["FIRECRACKER_VANILLA_SNAPSHOT_DIR"] ??
        path.join(process.cwd(), "data", "firecracker", "snapshots-vanilla"),
      FIRECRACKER_STATE_DIR:
        process.env["BENCH_FIRECRACKER_VANILLA_STATE_DIR"] ??
        process.env["FIRECRACKER_VANILLA_STATE_DIR"] ??
        path.join(process.cwd(), "data", "firecracker", "state-vanilla"),
      FIRECRACKER_API_DIR:
        process.env["BENCH_FIRECRACKER_VANILLA_API_DIR"] ??
        process.env["FIRECRACKER_VANILLA_API_DIR"] ??
        path.join(process.cwd(), "data", "firecracker", "api-vanilla"),
      FIRECRACKER_TAP_PREFIX:
        process.env["BENCH_FIRECRACKER_VANILLA_TAP_PREFIX"] ??
        process.env["FIRECRACKER_VANILLA_TAP_PREFIX"] ??
        "osbv",
      FIRECRACKER_ENABLE_INTERNET_EGRESS:
        process.env["BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS"] ??
        process.env["FIRECRACKER_ENABLE_INTERNET_EGRESS"] ??
        "1",
      FIRECRACKER_EGRESS_INTERFACE:
        process.env["BENCH_FIRECRACKER_EGRESS_INTERFACE"] ??
        process.env["FIRECRACKER_EGRESS_INTERFACE"] ??
        "",
      FIRECRACKER_ALLOW_AUTO_SNAPSHOT:
        process.env["BENCH_FIRECRACKER_ALLOW_AUTO_SNAPSHOT"] ??
        process.env["FIRECRACKER_ALLOW_AUTO_SNAPSHOT"] ??
        "1",
      FIRECRACKER_SNAPSHOT_WARM_PAGE:
        process.env["BENCH_FIRECRACKER_VANILLA_SNAPSHOT_WARM_PAGE"] ??
        process.env["FIRECRACKER_VANILLA_SNAPSHOT_WARM_PAGE"] ??
        "0",
      FIRECRACKER_DYNAMIC_CPU_POLICY: "0",
      FIRECRACKER_DYNAMIC_CPU_CGROUPS: "0",
    },
  },
  {
    id: "BaseLayer-Venusaur-managed-cold-node",
    label: "Profile F: Managed Cold Node",
    benchmarkSupport: "supported",
    mode: "managed",
    description:
      "Managed node with the warm pool disabled, used to isolate warm-pool benefit and cold burst behavior.",
    defaultAgentEnv: managedExperimentEnv({
      warmPoolSize: "0",
      warmPoolReserve: "0",
      warmPoolFillConcurrency: "1",
      warmRendererBudget: "0",
    }),
  },
  {
    id: "BaseLayer-Squirtle-managed-dense-384mb",
    label: "Profile G: Managed Dense 384MB Node",
    benchmarkSupport: "supported",
    mode: "managed",
    description:
      "Managed density experiment with tighter per-session memory accounting and admission budgets.",
    defaultAgentEnv: managedExperimentEnv({
      maxSessions: "8",
      warmPoolSize: "8",
      warmPoolReserve: "2",
      warmPoolFillConcurrency: "8",
      sessionMemoryLimitMb: "384",
      sessionMemoryReservationMb: "288",
      sessionAdmissionMemoryMb: "144",
      sessionShmLimitMb: "96",
      sessionAdmissionShmMb: "32",
      sessionRendererLimit: "5",
      maxRenderers: "40",
    }),
  },
  {
    id: "BaseLayer-Wartortle-managed-large-shm",
    label: "Profile H: Managed Large SHM Node",
    benchmarkSupport: "supported",
    mode: "managed",
    description:
      "Managed compatibility experiment with larger /dev/shm and renderer budgets for heavier pages.",
    defaultAgentEnv: managedExperimentEnv({
      warmPoolSize: "6",
      warmPoolReserve: "1",
      sessionMemoryLimitMb: "768",
      sessionMemoryReservationMb: "512",
      sessionAdmissionMemoryMb: "256",
      sessionShmLimitMb: "256",
      sessionAdmissionShmMb: "96",
      sessionRendererLimit: "8",
      maxRenderers: "48",
    }),
  },
  {
    id: "BaseLayer-Blastoise-firecracker-slim-512",
    label: "Profile I: Firecracker Slim 512MB",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Headless-shell Firecracker snapshot tier with 512MB guests to test hardened-tier economics.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FC512",
      snapshotName: "fc-512",
      tapPrefix: "osb512",
      memoryMb: "512",
      vcpuCount: "2",
    }),
  },
  {
    id: "BaseLayer-Caterpie-firecracker-slim-384",
    label: "Profile J: Firecracker Slim 384MB",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Headless-shell Firecracker snapshot tier with 384MB guests to find the lower memory bound.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FC384",
      snapshotName: "fc-384",
      tapPrefix: "osb384",
      memoryMb: "384",
      vcpuCount: "2",
    }),
  },
  {
    id: "BaseLayer-Metapod-firecracker-one-vcpu",
    label: "Profile K: Firecracker One vCPU",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Headless-shell Firecracker snapshot tier with 1 vCPU guests to test CPU packing and navigation tail cost.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FC1VCPU",
      snapshotName: "fc-1vcpu",
      tapPrefix: "osb1vc",
      memoryMb: "1024",
      vcpuCount: "1",
    }),
  },
  {
    id: "BaseLayer-Butterfree-firecracker-cdp-warm",
    label: "Profile L: Firecracker CDP Warm Snapshot",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Headless-shell Firecracker snapshot taken at CDP-ready only, without page/context prewarming.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCCDP",
      snapshotName: "fc-cdp",
      tapPrefix: "osbcdp",
      memoryMb: "1024",
      vcpuCount: "2",
      warmLevel: "cdp",
    }),
  },
  {
    id: "BaseLayer-Weedle-firecracker-context-warm",
    label: "Profile M: Firecracker Context Warm Snapshot",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Headless-shell Firecracker snapshot with a warmed Playwright context to test connect/goto tradeoffs.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCCONTEXT",
      snapshotName: "fc-context",
      tapPrefix: "osbctx",
      memoryMb: "1024",
      vcpuCount: "2",
      warmLevel: "context",
    }),
  },
  {
    id: "BaseLayer-Kakuna-firecracker-no-warm",
    label: "Profile N: Firecracker No Warm Page",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Headless-shell Firecracker snapshot with browser warm-page work disabled, used as a snapshot warm-level control.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCNOWARM",
      snapshotName: "fc-nowarm",
      tapPrefix: "osbnw",
      memoryMb: "1024",
      vcpuCount: "2",
      warmPage: "0",
      warmLevel: "cdp",
    }),
  },
  {
    id: "BaseLayer-Mewtwo-full-chromium",
    label: "Profile O: Firecracker Full Chromium",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Full Chromium Firecracker guest using artifacts/firecracker/rootfs-chromium.ext4 when built.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCCHROMIUM",
      snapshotName: "fc-chromium",
      tapPrefix: "osbchr",
      rootfsPath: path.join(process.cwd(), "artifacts", "firecracker", "rootfs-chromium.ext4"),
      memoryMb: "1024",
      vcpuCount: "2",
      warmLevel: "cdp",
    }),
  },
  {
    id: "BaseLayer-Beedrill-full-chromium-512",
    label: "Profile P: Firecracker Full Chromium 512MB",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Full Chromium Firecracker guest at 512MB to test whether compatibility can fit the lower-memory tier.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCCHROMIUM512",
      snapshotName: "fc-chromium-512",
      tapPrefix: "osbch5",
      rootfsPath: path.join(process.cwd(), "artifacts", "firecracker", "rootfs-chromium.ext4"),
      memoryMb: "512",
      vcpuCount: "2",
      warmLevel: "cdp",
    }),
  },
  {
    id: "BaseLayer-Pidgey-network-validate",
    label: "Profile Q: Firecracker Network Validate",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Headless-shell Firecracker profile with network-slot validation on claim to measure safety overhead.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCNETVALIDATE",
      snapshotName: "fc-netvalidate",
      tapPrefix: "osbnv",
      memoryMb: "1024",
      vcpuCount: "2",
      networkSlotValidateOnClaim: "1",
    }),
  },
  {
    id: "BaseLayer-Pidgeotto-fluid-hybrid",
    label: "Profile R: Firecracker Fluid Hybrid CPU",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Headless-shell Firecracker profile with hybrid dynamic CPU policy to retest launch versus navigation tradeoffs.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCFLUIDHYBRID",
      snapshotName: "fc-fluid-hybrid",
      tapPrefix: "osbfh",
      memoryMb: "1024",
      vcpuCount: "2",
      dynamicCpuPolicy: "1",
      dynamicCpuCgroups: "0",
      dynamicCpuMode: "hybrid",
    }),
  },
  {
    id: "BaseLayer-Pidgeot-fluid-always",
    label: "Profile S: Firecracker Fluid Always CPU",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Headless-shell Firecracker profile with always-on dynamic CPU policy to compare against hybrid and baseline.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCFLUIDALWAYS",
      snapshotName: "fc-fluid-always",
      tapPrefix: "osbfa",
      memoryMb: "1024",
      vcpuCount: "2",
      dynamicCpuPolicy: "1",
      dynamicCpuCgroups: "0",
      dynamicCpuMode: "always",
    }),
  },
  {
    id: "BaseLayer-Rattata-fast-slot-reuse",
    label: "Profile X: Firecracker Fast Slot Reuse",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Headless-shell Firecracker profile that skips helper cleanup grace when no stale helper processes exist.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCFASTSLOT",
      snapshotName: "fc-fast-slot",
      tapPrefix: "osbfs",
      memoryMb: "1024",
      vcpuCount: "2",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Raticate-density-512-1vcpu",
    label: "Profile Y: Firecracker Density 1024MB 1vCPU",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Headless-shell Firecracker density profile combining 1024MB guests, 1 vCPU, and fast slot reuse. The profile ID is historical; 512MB OOMs on the current rootfs.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCDENSE5121",
      snapshotName: "fc-density-512-1vcpu",
      tapPrefix: "osbd51",
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Spearow-fluid-density",
    label: "Profile Z: Firecracker Fluid Density",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Headless-shell Firecracker density profile combining 1024MB/1vCPU guests, fast slot reuse, and hybrid dynamic CPU policy. Cgroups stay disabled until the cpu.weight write path is fixed.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCFLUIDDENSE",
      snapshotName: "fc-fluid-density",
      tapPrefix: "osbfd",
      memoryMb: "1024",
      vcpuCount: "1",
      dynamicCpuPolicy: "1",
      dynamicCpuCgroups: "0",
      dynamicCpuMode: "hybrid",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Fearow-density-navcap-12",
    label: "Profile BA: Density + Active-Navigation Cap 12",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Same guest shape as Profile Y (1024MB, 1 vCPU, fast slot reuse) with FIRECRACKER_MAX_CONCURRENT_ACTIVE_NAVIGATION=12 to test goto p95 vs admission rejections at high concurrency.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCNAV12",
      snapshotName: "fc-density-512-1vcpu",
      tapPrefix: "osbn12",
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
      maxConcurrentActiveNavigation: "12",
    }),
  },
  {
    id: "BaseLayer-Ekans-density-navcap-16",
    label: "Profile BB: Density + Active-Navigation Cap 16",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Density baseline with active-navigation cap 16 (common mid-point between c16 and c24 simultaneous nav).",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCNAV16",
      snapshotName: "fc-density-512-1vcpu",
      tapPrefix: "osbn16",
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
      maxConcurrentActiveNavigation: "16",
    }),
  },
  {
    id: "BaseLayer-Arbok-density-navcap-20",
    label: "Profile BC: Density + Active-Navigation Cap 20",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Density baseline with active-navigation cap 20 (lighter admission than c24-all-active).",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCNAV20",
      snapshotName: "fc-density-512-1vcpu",
      tapPrefix: "osbn20",
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
      maxConcurrentActiveNavigation: "20",
    }),
  },
  {
    id: "BaseLayer-Pikachu-density-mem1536",
    label: "Profile BD: Density + 1536 MB RAM",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Raises guest RAM to 1536 MB on the density snapshot to test whether page_goto tail improves enough to justify lower host density.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCD1536",
      snapshotName: "fc-density-512-1vcpu",
      tapPrefix: "osbm1536",
      memoryMb: "1536",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Raichu-density-mem1280",
    label: "Profile BI: Density + 1280 MB RAM",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Raises guest RAM to 1280 MB on the density snapshot to test a smaller memory step above the 1024 MB baseline.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCD1280",
      snapshotName: "fc-density-512-1vcpu",
      tapPrefix: "osbm1280",
      memoryMb: "1280",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Sandshrew-density-mem1792",
    label: "Profile BJ: Density + 1792 MB RAM",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Raises guest RAM to 1792 MB on the density snapshot to test whether goto tail continues improving past 1536 MB.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCD1792",
      snapshotName: "fc-density-512-1vcpu",
      tapPrefix: "osbm1792",
      memoryMb: "1792",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Sandslash-density-mem2048",
    label: "Profile BK: Density + 2048 MB RAM",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Raises guest RAM to 2048 MB on the density snapshot to find whether higher RAM helps enough to justify the density cost.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCD2048",
      snapshotName: "fc-density-512-1vcpu",
      tapPrefix: "osbm2048",
      memoryMb: "2048",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Nidoran-F-density-navcap16-mem1536",
    label: "Profile BE: Density + Nav Cap 16 + 1536 MB",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Combines navigation admission (16) with higher guest memory for c24-style runs where CPU and guest paging may both matter.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCNV16M1536",
      snapshotName: "fc-density-512-1vcpu",
      tapPrefix: "osb16m15",
      memoryMb: "1536",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
      maxConcurrentActiveNavigation: "16",
    }),
  },
  {
    id: "BaseLayer-Nidorina-density-navcap16-mem2048",
    label: "Profile BL: Density + Nav Cap 16 + 2048 MB",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Combines navigation admission cap 16 with 2048 MB guest RAM to test whether the strongest memory step and cap interact.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCNV16M2048",
      snapshotName: "fc-density-512-1vcpu",
      tapPrefix: "osb16m20",
      memoryMb: "2048",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
      maxConcurrentActiveNavigation: "16",
    }),
  },
  {
    id: "BaseLayer-Nidoqueen-fluid-density-navcap-16",
    label: "Profile BF: Fluid Density + Active-Navigation Cap 16",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Profile Z–style hybrid fluid CPU (renice path; cgroups off) plus active-navigation cap 16 to separate fluid policy from raw goto contention.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCFLUIDNV16",
      snapshotName: "fc-fluid-density",
      tapPrefix: "osbfn16",
      memoryMb: "1024",
      vcpuCount: "1",
      dynamicCpuPolicy: "1",
      dynamicCpuCgroups: "0",
      dynamicCpuMode: "hybrid",
      slotHelperCleanupGraceMs: "0",
      maxConcurrentActiveNavigation: "16",
    }),
  },
  {
    id: "BaseLayer-Nidoran-M-fluid-density-cgroups",
    label: "Profile BG: Fluid Density + cgroups cpu.weight",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Same as Profile Z but enables FIRECRACKER_DYNAMIC_CPU_CGROUPS=1 for hosts where cgroup v2 cpu.weight writes succeed (fair evaluation of fluid CPU vs renice-only).",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCFLUIDCG",
      snapshotName: "fc-fluid-density",
      tapPrefix: "osbfcg",
      memoryMb: "1024",
      vcpuCount: "1",
      dynamicCpuPolicy: "1",
      dynamicCpuCgroups: "1",
      dynamicCpuMode: "hybrid",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Nidorino-density-launch-cap-12",
    label: "Profile BH: Density + Launch Concurrency 12",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Caps FIRECRACKER_LAUNCH_CONCURRENCY at 12 to stagger microVM bring-up vs simultaneous navigation (complements nav-cap profiles).",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCLNCH12",
      snapshotName: "fc-density-512-1vcpu",
      tapPrefix: "osbl12",
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
      launchConcurrency: "12",
    }),
  },
  {
    id: "BaseLayer-Nidoking-density-navcap-8",
    label: "Profile BM: Density + Active-Navigation Cap 8",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Density baseline with a strict active-navigation cap 8 to test whether queueing fewer Google navigations cuts c24 goto p50 enough to offset wait time.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCNAV8",
      snapshotName: "fc-density-512-1vcpu",
      tapPrefix: "osbn8",
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
      maxConcurrentActiveNavigation: "8",
    }),
  },
  {
    id: "BaseLayer-Clefairy-2vcpu-navcap-12",
    label: "Profile BN: 2vCPU + Active-Navigation Cap 12",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Two-vCPU guests with only 12 simultaneous Google navigations; trades lower exposed active CPU concurrency for faster per-navigation renderer work.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FC2VNAV12",
      snapshotName: "fc-2vcpu-navcap12",
      tapPrefix: "osb2n12",
      memoryMb: "1024",
      vcpuCount: "2",
      slotHelperCleanupGraceMs: "0",
      maxConcurrentActiveNavigation: "12",
    }),
  },
  {
    id: "BaseLayer-Clefable-2vcpu-navcap-16",
    label: "Profile BO: 2vCPU + Active-Navigation Cap 16",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Two-vCPU guests with 16 simultaneous Google navigations; tests whether c16-style active pressure gives a better c24 lifecycle than 1vCPU all-active.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FC2VNAV16",
      snapshotName: "fc-2vcpu-navcap16",
      tapPrefix: "osb2n16",
      memoryMb: "1024",
      vcpuCount: "2",
      slotHelperCleanupGraceMs: "0",
      maxConcurrentActiveNavigation: "16",
    }),
  },
  {
    id: "BaseLayer-Vulpix-density-cdp-warm",
    label: "Profile BP: Density CDP-Only Warm Snapshot",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "One-vCPU density snapshot taken at CDP-ready only; tests whether skipping page/context prewarm helps real-site first navigation under c24 pressure.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCDCDP",
      snapshotName: "fc-density-cdp-warm",
      tapPrefix: "osbdcdp",
      memoryMb: "1024",
      vcpuCount: "1",
      warmLevel: "cdp",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Ninetales-density-context-warm",
    label: "Profile BQ: Density Context-Warm Snapshot",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "One-vCPU density snapshot with a warmed Playwright context; tests whether pre-created context state reduces real-site goto enough at c24.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCDCTX",
      snapshotName: "fc-density-context-warm",
      tapPrefix: "osbdctx",
      memoryMb: "1024",
      vcpuCount: "1",
      warmLevel: "context",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Jigglypuff-density-target-warm",
    label: "Profile BR: Density Target-Warm Snapshot",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "One-vCPU density snapshot with a pre-created DevTools target only; narrower than context-warm and safer than full page prewarm for real-site goto experiments.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCDTARGET",
      snapshotName: "fc-density-target-warm",
      tapPrefix: "osbdtgt",
      memoryMb: "1024",
      vcpuCount: "1",
      warmLevel: "target",
      snapshotWarmUrl: "about:blank",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Wigglytuff-density-blank-warm",
    label: "Profile BS: Density Blank-Page Warm Snapshot",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "One-vCPU density snapshot with a created context and blank page, but no synthetic page navigation. Tests whether page allocation alone lowers first real-site goto cost.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCDBLANK",
      snapshotName: "fc-density-blank-warm",
      tapPrefix: "osbdblk",
      memoryMb: "1024",
      vcpuCount: "1",
      warmLevel: "blank",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Zubat-density-cdp-warm-navcap-8",
    label: "Profile BT: Density CDP-Warm Snapshot + Nav Cap 8",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "One-vCPU density snapshot at CDP-ready with active navigation capped at 8. Tests whether the best valid goto reduction so far gets stronger when the hottest renderer wave is limited.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCDCDP8",
      snapshotName: "fc-density-cdp-warm-nav8",
      tapPrefix: "osbdc8",
      memoryMb: "1024",
      vcpuCount: "1",
      warmLevel: "cdp",
      slotHelperCleanupGraceMs: "0",
      maxConcurrentActiveNavigation: "8",
    }),
  },
  {
    id: "BaseLayer-Oddish-kernel-goto",
    label: "Profile BU: Firecracker Kernel-Inspired Goto Flags",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Baseline Firecracker density lane with a Kernel-inspired guest Chromium/headless-shell launch preset baked into a separate rootfs.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCKERNELGOTO",
      snapshotName: "fc-kernel-goto",
      tapPrefix: "osbkgt",
      rootfsPath: path.join(
        process.cwd(),
        "artifacts",
        "firecracker",
        "rootfs-kernel-goto.ext4",
      ),
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Gloom-kernel-goto-lite",
    label: "Profile BX: Firecracker Kernel-Inspired Goto Lite",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "A narrower Kernel-inspired guest launch preset that keeps only the subset of extra Chromium flags most likely to help navigation without overfitting the full Kernel bundle.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCKERNELLITE",
      snapshotName: "fc-kernel-goto-lite",
      tapPrefix: "osbkgl",
      rootfsPath: path.join(
        process.cwd(),
        "artifacts",
        "firecracker",
        "rootfs-kernel-goto-lite.ext4",
      ),
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Vileplume-kernel-feature-prune",
    label: "Profile BY: Firecracker Kernel Feature-Prune",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Headless-shell density lane with a larger Kernel-derived disable-features bundle baked into the guest rootfs, without the broader startup flag cargo-culting.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCKERNELFEATURE",
      snapshotName: "fc-kernel-feature-prune",
      tapPrefix: "osbkfp",
      rootfsPath: path.join(
        process.cwd(),
        "artifacts",
        "firecracker",
        "rootfs-kernel-feature-prune.ext4",
      ),
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Gengar-kernel-startup-prune",
    label: "Profile BZ: Firecracker Kernel Startup-Prune",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Headless-shell density lane with only startup/service-pruning flags from the Kernel-style launcher, keeping feature flags close to baseline.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCKERNELSTARTUP",
      snapshotName: "fc-kernel-startup-prune",
      tapPrefix: "osbksp",
      rootfsPath: path.join(
        process.cwd(),
        "artifacts",
        "firecracker",
        "rootfs-kernel-startup-prune.ext4",
      ),
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Machop-gengar-automation-navcap-16",
    label: "Profile BZ2: Gengar + Automation Switches + Nav Cap 16",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Gengar-style startup-prune rootfs plus conservative automation/background switches and FIRECRACKER_MAX_CONCURRENT_ACTIVE_NAVIGATION=16. Tests whether reducing background browser work plus admission control lowers real-site goto without changing BrowserArena semantics.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCGENGARAUTO16",
      snapshotName: "fc-gengar-automation-navcap16",
      tapPrefix: "osbga6",
      rootfsPath: path.join(
        process.cwd(),
        "artifacts",
        "firecracker",
        "rootfs-kernel-startup-prune-automation.ext4",
      ),
      memoryMb: "1024",
      vcpuCount: "1",
      maxConcurrentActiveNavigation: "16",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Machoke-gengar-network-calm-navcap-16",
    label: "Profile BZ3: Gengar + Network-Calm + Nav Cap 16",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Aggressive follow-up to Machop: Gengar-style startup-prune plus background switches, DNS prefetch disable, a small predictor/translation feature prune, and active-navigation cap 16. Keep experimental until Google/Wikipedia/HN parity is verified.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCGENGARNET16",
      snapshotName: "fc-gengar-network-calm-navcap16",
      tapPrefix: "osbgn6",
      rootfsPath: path.join(
        process.cwd(),
        "artifacts",
        "firecracker",
        "rootfs-kernel-startup-prune-network-calm.ext4",
      ),
      memoryMb: "1024",
      vcpuCount: "1",
      maxConcurrentActiveNavigation: "16",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Paras-kernel-goto-ipv6off",
    label: "Profile BV: Firecracker Kernel-Inspired Goto + Guest IPv6 Off",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Same Kernel-inspired guest launch preset as Profile BU, but with IPv6 disabled inside the guest image to test DNS/connect noise reduction.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCKERNELIPV6",
      snapshotName: "fc-kernel-goto-ipv6off",
      tapPrefix: "osbk6o",
      rootfsPath: path.join(
        process.cwd(),
        "artifacts",
        "firecracker",
        "rootfs-kernel-goto-ipv6off.ext4",
      ),
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Dragonite-kernel-balanced",
    label: "Profile CA: Firecracker Kernel Balanced",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Headless-shell density lane that combines the narrower startup-prune bundle with a curated Kernel-derived disable-features set, aiming for a cleaner combined profile than BU.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCKERNELBAL",
      snapshotName: "fc-kernel-balanced",
      tapPrefix: "osbkba",
      rootfsPath: path.join(
        process.cwd(),
        "artifacts",
        "firecracker",
        "rootfs-kernel-balanced.ext4",
      ),
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Parasect-kernel-goto-cdp-warm",
    label: "Profile BW: Firecracker Kernel-Inspired Goto + CDP Warm",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Combines the Kernel-inspired guest launch preset with the CDP-only warm-level to test whether browser-launch tuning stacks with the best valid warm snapshot shape.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCKERNELCDP",
      snapshotName: "fc-kernel-goto-cdp",
      tapPrefix: "osbkgc",
      rootfsPath: path.join(
        process.cwd(),
        "artifacts",
        "firecracker",
        "rootfs-kernel-goto.ext4",
      ),
      memoryMb: "1024",
      vcpuCount: "1",
      warmLevel: "cdp",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Krabby-kernel-startup-prune-lite",
    label: "Profile CB: Firecracker Kernel Startup-Prune Lite",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "A tighter follow-up to Gengar that keeps only the lowest-risk startup/service pruning flags from the Kernel-inspired sweep.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCKERNELSPLITE",
      snapshotName: "fc-kernel-startup-prune-lite",
      tapPrefix: "osbksl",
      rootfsPath: path.join(
        process.cwd(),
        "artifacts",
        "firecracker",
        "rootfs-kernel-startup-prune-lite.ext4",
      ),
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Kingler-kernel-balanced-lite",
    label: "Profile CC: Firecracker Kernel Balanced Lite",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "A tighter follow-up to Dragonite that keeps the balanced startup-prune shape but reduces the feature-prune bundle to the least controversial items.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCKERNELBALLITE",
      snapshotName: "fc-kernel-balanced-lite",
      tapPrefix: "osbkbl",
      rootfsPath: path.join(
        process.cwd(),
        "artifacts",
        "firecracker",
        "rootfs-kernel-balanced-lite.ext4",
      ),
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Horsea-async-gengar-merge",
    label: "Profile CD: Async-Parity + Gengar Merge",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Async-parity rerun candidate: the main Mew density lane merged with Gengar's startup-prune rootfs and async delete semantics.",
    defaultAgentEnv: {
      ...firecrackerExperimentEnv({
        envPrefix: "FCASYNCGENGAR",
        snapshotName: "fc-async-gengar-merge",
        tapPrefix: "osbagg",
        rootfsPath: path.join(
          process.cwd(),
          "artifacts",
          "firecracker",
          "rootfs-kernel-startup-prune.ext4",
        ),
        memoryMb: "1024",
        vcpuCount: "1",
        slotHelperCleanupGraceMs: "0",
      }),
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
    },
  },
  {
    id: "BaseLayer-Seadra-async-dragonite-merge",
    label: "Profile CE: Async-Parity + Dragonite Merge",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Async-parity rerun candidate: the main Mew density lane merged with Dragonite's balanced Kernel-inspired rootfs and async delete semantics.",
    defaultAgentEnv: {
      ...firecrackerExperimentEnv({
        envPrefix: "FCASYNCDRAGONITE",
        snapshotName: "fc-async-dragonite-merge",
        tapPrefix: "osbadr",
        rootfsPath: path.join(
          process.cwd(),
          "artifacts",
          "firecracker",
          "rootfs-kernel-balanced.ext4",
        ),
        memoryMb: "1024",
        vcpuCount: "1",
        slotHelperCleanupGraceMs: "0",
      }),
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
    },
  },
  {
    id: "BaseLayer-Goldeen-async-gloom-merge",
    label: "Profile CF: Async-Parity + Gloom Merge",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Async-parity rerun candidate: the main Mew density lane merged with Gloom's lighter Kernel-inspired launch bundle and async delete semantics.",
    defaultAgentEnv: {
      ...firecrackerExperimentEnv({
        envPrefix: "FCASYNCGLOOM",
        snapshotName: "fc-async-gloom-merge",
        tapPrefix: "osbagl",
        rootfsPath: path.join(
          process.cwd(),
          "artifacts",
          "firecracker",
          "rootfs-kernel-goto-lite.ext4",
        ),
        memoryMb: "1024",
        vcpuCount: "1",
        slotHelperCleanupGraceMs: "0",
      }),
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
    },
  },
  {
    id: "BaseLayer-Poliwag-async-manual-gengar",
    label: "Profile CI: Async Manual Gengar Integration",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Manual async-parity integration using a dedicated rootfs built from a curated Gengar-style launch profile instead of a stacked merge profile.",
    defaultAgentEnv: {
      ...firecrackerExperimentEnv({
        envPrefix: "FCASYNCMANUALGENGAR",
        snapshotName: "fc-async-manual-gengar",
        tapPrefix: "osbapg",
        rootfsPath: path.join(
          process.cwd(),
          "artifacts",
          "firecracker",
          "rootfs-async-manual-gengar.ext4",
        ),
        memoryMb: "1024",
        vcpuCount: "1",
        slotHelperCleanupGraceMs: "0",
      }),
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
    },
  },
  {
    id: "BaseLayer-Poliwhirl-async-manual-dragonite",
    label: "Profile CJ: Async Manual Dragonite Integration",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Manual async-parity integration using a dedicated rootfs built from a curated Dragonite-style launch profile instead of a stacked merge profile.",
    defaultAgentEnv: {
      ...firecrackerExperimentEnv({
        envPrefix: "FCASYNCMANUALDRAGONITE",
        snapshotName: "fc-async-manual-dragonite",
        tapPrefix: "osbapd",
        rootfsPath: path.join(
          process.cwd(),
          "artifacts",
          "firecracker",
          "rootfs-async-manual-dragonite.ext4",
        ),
        memoryMb: "1024",
        vcpuCount: "1",
        slotHelperCleanupGraceMs: "0",
      }),
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
    },
  },
  {
    id: "BaseLayer-Staryu-custom-shell-startup-network",
    label: "Profile CG: Custom Headless-Shell Baseline Build",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Custom-built chrome-headless-shell baseline lane intended for deeper build-level stripping and future source-patched startup/network changes.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCCUSTOMSHELLBASE",
      snapshotName: "fc-custom-shell-baseline",
      tapPrefix: "osbcsb",
      rootfsPath: path.join(
        process.cwd(),
        "artifacts",
        "firecracker",
        "rootfs-custom-shell-baseline.ext4",
      ),
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Starmie-async-custom-shell-merge",
    label: "Profile CH: Async Manual Custom Shell",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Manual async-parity candidate using the custom headless-shell async-manual rootfs on the main Mew runtime semantics.",
    defaultAgentEnv: {
      ...firecrackerExperimentEnv({
        envPrefix: "FCASYNCCUSTOM",
        snapshotName: "fc-async-custom-shell-manual",
        tapPrefix: "osbacs",
        rootfsPath: path.join(
          process.cwd(),
          "artifacts",
          "firecracker",
          "rootfs-custom-shell-async-manual.ext4",
        ),
        memoryMb: "1024",
        vcpuCount: "1",
        slotHelperCleanupGraceMs: "0",
      }),
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
    },
  },
  {
    id: "BaseLayer-Abra-custom-shell-baseline",
    label: "Profile CK: Custom Shell Baseline",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Alias lane for the custom built headless-shell baseline rootfs, intended for direct A/Bs against Mew without extra launch-profile changes.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCCUSTOMSHELLABRA",
      snapshotName: "fc-custom-shell-abra",
      tapPrefix: "osbcsa",
      rootfsPath: path.join(
        process.cwd(),
        "artifacts",
        "firecracker",
        "rootfs-custom-shell-baseline.ext4",
      ),
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Kadabra-custom-shell-startup-prune",
    label: "Profile CL: Custom Shell Startup-Prune",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Custom-built headless-shell lane using the startup-prune launch profile for source/build plus launch-profile combined testing. AWS 2026-04-18 data: worse than Mew on both session_create_runtime and page_goto at c24; use only after page_goto improves vs Abra—do not assume guest startup-prune helps navigation.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCCUSTOMSHELLSTARTUP",
      snapshotName: "fc-custom-shell-startup-prune",
      tapPrefix: "osbcsk",
      rootfsPath: path.join(
        process.cwd(),
        "artifacts",
        "firecracker",
        "rootfs-custom-shell-startup-prune.ext4",
      ),
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Alakazam-custom-shell-async-manual",
    label: "Profile CM: Custom Shell Async Manual",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Custom-built headless-shell lane using the manual async-parity launch profile instead of a stacked merge.",
    defaultAgentEnv: {
      ...firecrackerExperimentEnv({
        envPrefix: "FCCUSTOMSHELLASYNC",
        snapshotName: "fc-custom-shell-async-manual",
        tapPrefix: "osbcsm",
        rootfsPath: path.join(
          process.cwd(),
          "artifacts",
          "firecracker",
          "rootfs-custom-shell-async-manual.ext4",
        ),
        memoryMb: "1024",
        vcpuCount: "1",
        slotHelperCleanupGraceMs: "0",
      }),
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
    },
  },
  {
    id: "BaseLayer-Ditto-custom-shell-kernel-balanced",
    label: "Profile CN: Custom Shell + Kernel Balanced (Combined)",
    benchmarkSupport: "supported",
    mode: "firecracker",
    description:
      "Combined lane (Instance D): custom-built headless-shell binary with kernel-balanced guest launch profile (maps to custom Chromium + Dragonite-like Linux). Build rootfs with FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM and scripts/bench/build-firecracker-rootfs-variants.sh.",
    defaultAgentEnv: firecrackerExperimentEnv({
      envPrefix: "FCCUSTOMSHELLKBAL",
      snapshotName: "fc-custom-shell-kernel-balanced",
      tapPrefix: "osbcskb",
      rootfsPath: path.join(
        process.cwd(),
        "artifacts",
        "firecracker",
        "rootfs-custom-shell-kernel-balanced.ext4",
      ),
      memoryMb: "1024",
      vcpuCount: "1",
      slotHelperCleanupGraceMs: "0",
    }),
  },
  {
    id: "BaseLayer-Venomoth-dedicated-vm",
    label: "Profile E: Dedicated VM Per Session",
    benchmarkSupport: "planned",
    description:
      "Future dedicated-VM-per-session reference profile for isolation-first operators.",
    reason: "Dedicated VM orchestration is not implemented in this repo yet.",
  },
  {
    id: "BaseLayer-Diglett-paused-microvm-pool",
    label: "Profile T: Paused MicroVM Pool",
    benchmarkSupport: "planned",
    description:
      "Future pool of pre-spawned paused Firecracker VMs to reduce process/API socket startup time.",
    reason:
      "The orchestrator does not yet own a reusable paused-microVM pool; current Firecracker profiles spawn per session.",
  },
  {
    id: "BaseLayer-Dugtrio-unikraft-standby",
    label: "Profile U: Unikraft Standby Runtime",
    benchmarkSupport: "planned",
    description:
      "Future Kernel-inspired unikernel standby/snapshot architecture for comparing against Firecracker snapshots.",
    reason:
      "Unikraft packaging and lifecycle integration are not implemented in this repo.",
  },
  {
    id: "BaseLayer-Meowth-lightpanda-runtime",
    label: "Profile V: Lightpanda Runtime",
    benchmarkSupport: "planned",
    description:
      "Low-CPU browser lane for static or simple pages: run `npm run bench:lightpanda-browserarena` or `bench:lightpanda-smoke` after `npm install @lightpanda/browser`. Route compatible traffic here; keep Chromium/Firecracker for full-site and Playwright-complete workloads.",
    reason:
      "Node-agent session lifecycle and provider routing to Lightpanda are not implemented; benchmarks are standalone only.",
  },
  {
    id: "BaseLayer-Persian-managed-ksm-cow",
    label: "Profile W: Managed KSM/CoW Browser Node",
    benchmarkSupport: "planned",
    description:
      "Future managed density profile that requires host-level KSM/CoW setup and profile-layer cloning before benchmark launch.",
    reason:
      "The benchmark harness can set agent env but does not yet configure host KSM or CoW profile layers.",
  },
];

export const SUPPORTED_BENCHMARK_PROFILES = BENCHMARK_PROFILES.filter(
  (profile): profile is SupportedProfileConfig =>
    profile.benchmarkSupport === "supported",
);

const LEGACY_SUPPORTED_PROFILE_ALIASES: Record<string, SupportedProfileId> = {
  "profile-a-generic-container": "BaseLayer-Bulbasaur-generic-container",
  "profile-b-optimized-node": "BaseLayer-Charizard-managed-node",
  "profile-c-firecracker-snapshot": "BaseLayer-Mew-firecracker-headless-shell",
  "profile-d-firecracker-vanilla": "BaseLayer-Ivysaur-firecracker-vanilla",
  "profile-f-managed-cold-node": "BaseLayer-Venusaur-managed-cold-node",
  "profile-g-managed-dense-384mb": "BaseLayer-Squirtle-managed-dense-384mb",
  "profile-h-managed-large-shm": "BaseLayer-Wartortle-managed-large-shm",
  "profile-i-firecracker-slim-512": "BaseLayer-Blastoise-firecracker-slim-512",
  "profile-j-firecracker-slim-384": "BaseLayer-Caterpie-firecracker-slim-384",
  "profile-k-firecracker-one-vcpu": "BaseLayer-Metapod-firecracker-one-vcpu",
  "profile-l-firecracker-cdp-warm": "BaseLayer-Butterfree-firecracker-cdp-warm",
  "profile-m-firecracker-context-warm": "BaseLayer-Weedle-firecracker-context-warm",
  "profile-n-firecracker-no-warm": "BaseLayer-Kakuna-firecracker-no-warm",
  "profile-o-firecracker-full-chromium": "BaseLayer-Mewtwo-full-chromium",
  "profile-p-firecracker-full-chromium-512": "BaseLayer-Beedrill-full-chromium-512",
  "profile-q-firecracker-network-validate": "BaseLayer-Pidgey-network-validate",
  "profile-r-firecracker-fluid-hybrid": "BaseLayer-Pidgeotto-fluid-hybrid",
  "profile-s-firecracker-fluid-always": "BaseLayer-Pidgeot-fluid-always",
  "profile-x-firecracker-fast-slot-reuse": "BaseLayer-Rattata-fast-slot-reuse",
  "profile-y-firecracker-density-512-1vcpu": "BaseLayer-Raticate-density-512-1vcpu",
  "profile-z-firecracker-fluid-density": "BaseLayer-Spearow-fluid-density",
  "profile-ba-firecracker-density-navcap-12": "BaseLayer-Fearow-density-navcap-12",
  "profile-bb-firecracker-density-navcap-16": "BaseLayer-Ekans-density-navcap-16",
  "profile-bc-firecracker-density-navcap-20": "BaseLayer-Arbok-density-navcap-20",
  "profile-bd-firecracker-density-mem1536": "BaseLayer-Pikachu-density-mem1536",
  "profile-bi-firecracker-density-mem1280": "BaseLayer-Raichu-density-mem1280",
  "profile-bj-firecracker-density-mem1792": "BaseLayer-Sandshrew-density-mem1792",
  "profile-bk-firecracker-density-mem2048": "BaseLayer-Sandslash-density-mem2048",
  "profile-be-firecracker-density-navcap16-mem1536":
    "BaseLayer-Nidoran-F-density-navcap16-mem1536",
  "profile-bl-firecracker-density-navcap16-mem2048":
    "BaseLayer-Nidorina-density-navcap16-mem2048",
  "profile-bf-firecracker-fluid-density-navcap-16":
    "BaseLayer-Nidoqueen-fluid-density-navcap-16",
  "profile-bg-firecracker-fluid-density-cgroups":
    "BaseLayer-Nidoran-M-fluid-density-cgroups",
  "profile-bh-firecracker-density-launch-cap-12":
    "BaseLayer-Nidorino-density-launch-cap-12",
  "profile-bm-firecracker-density-navcap-8": "BaseLayer-Nidoking-density-navcap-8",
  "profile-bn-firecracker-2vcpu-navcap-12": "BaseLayer-Clefairy-2vcpu-navcap-12",
  "profile-bo-firecracker-2vcpu-navcap-16": "BaseLayer-Clefable-2vcpu-navcap-16",
  "profile-bp-firecracker-density-cdp-warm": "BaseLayer-Vulpix-density-cdp-warm",
  "profile-bq-firecracker-density-context-warm":
    "BaseLayer-Ninetales-density-context-warm",
  "profile-br-firecracker-density-target-warm":
    "BaseLayer-Jigglypuff-density-target-warm",
  "profile-bs-firecracker-density-blank-warm": "BaseLayer-Wigglytuff-density-blank-warm",
  "profile-bt-firecracker-density-cdp-warm-navcap-8":
    "BaseLayer-Zubat-density-cdp-warm-navcap-8",
  "profile-bu-firecracker-kernel-goto": "BaseLayer-Oddish-kernel-goto",
  "profile-bx-firecracker-kernel-goto-lite": "BaseLayer-Gloom-kernel-goto-lite",
  "profile-by-firecracker-kernel-feature-prune":
    "BaseLayer-Vileplume-kernel-feature-prune",
  "profile-bz-firecracker-kernel-startup-prune":
    "BaseLayer-Gengar-kernel-startup-prune",
  "profile-bz2-firecracker-gengar-automation-navcap-16":
    "BaseLayer-Machop-gengar-automation-navcap-16",
  "profile-bz3-firecracker-gengar-network-calm-navcap-16":
    "BaseLayer-Machoke-gengar-network-calm-navcap-16",
  "profile-bv-firecracker-kernel-goto-ipv6off": "BaseLayer-Paras-kernel-goto-ipv6off",
  "profile-ca-firecracker-kernel-balanced": "BaseLayer-Dragonite-kernel-balanced",
  "profile-bw-firecracker-kernel-goto-cdp-warm": "BaseLayer-Parasect-kernel-goto-cdp-warm",
};

function resolveSupportedProfileId(value: string): SupportedProfileId | undefined {
  const canonical = SUPPORTED_BENCHMARK_PROFILES.find((profile) => profile.id === value);
  if (canonical) {
    return canonical.id;
  }

  return LEGACY_SUPPORTED_PROFILE_ALIASES[value];
}

function isFirecrackerProfileRunnable(profile: SupportedProfileConfig): boolean {
  if (profile.mode !== "firecracker") {
    return true;
  }

  if (process.platform !== "linux") {
    return false;
  }

  return process.env["BENCH_ENABLE_FIRECRACKER"] === "1";
}

function parseRequestedProfileIds(): Set<SupportedProfileId> | undefined {
  const raw = process.env["BENCH_PROFILE_IDS"];
  if (!raw) {
    return undefined;
  }

  const ids = raw
    .split(",")
    .map((value) => resolveSupportedProfileId(value.trim()))
    .filter((value): value is SupportedProfileId => Boolean(value));
  if (ids.length === 0) {
    return undefined;
  }

  return new Set(ids);
}

export const ACTIVE_BENCHMARK_PROFILES = (() => {
  const requested = parseRequestedProfileIds();
  if (!requested) {
    return SUPPORTED_BENCHMARK_PROFILES.filter((profile) =>
      isFirecrackerProfileRunnable(profile),
    );
  }

  return SUPPORTED_BENCHMARK_PROFILES.filter(
    (profile) => requested.has(profile.id) && isFirecrackerProfileRunnable(profile),
  );
})();

export function getSupportedProfile(id: SupportedProfileId | string): SupportedProfileConfig {
  const resolvedId = resolveSupportedProfileId(id);
  const profile = SUPPORTED_BENCHMARK_PROFILES.find((candidate) => candidate.id === resolvedId);
  if (!profile) {
    throw new Error(`Unknown supported profile: ${id}`);
  }

  return profile;
}
