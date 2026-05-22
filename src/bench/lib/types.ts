export type SupportedProfileId =
  | "BaseLayer-Bulbasaur-generic-container"
  | "BaseLayer-Charizard-managed-node"
  | "BaseLayer-Mew-firecracker-headless-shell"
  | "BaseLayer-Ivysaur-firecracker-vanilla"
  | "BaseLayer-Venusaur-managed-cold-node"
  | "BaseLayer-Squirtle-managed-dense-384mb"
  | "BaseLayer-Wartortle-managed-large-shm"
  | "BaseLayer-Blastoise-firecracker-slim-512"
  | "BaseLayer-Caterpie-firecracker-slim-384"
  | "BaseLayer-Metapod-firecracker-one-vcpu"
  | "BaseLayer-Butterfree-firecracker-cdp-warm"
  | "BaseLayer-Weedle-firecracker-context-warm"
  | "BaseLayer-Kakuna-firecracker-no-warm"
  | "BaseLayer-Mewtwo-full-chromium"
  | "BaseLayer-Beedrill-full-chromium-512"
  | "BaseLayer-Pidgey-network-validate"
  | "BaseLayer-Pidgeotto-fluid-hybrid"
  | "BaseLayer-Pidgeot-fluid-always"
  | "BaseLayer-Rattata-fast-slot-reuse"
  | "BaseLayer-Raticate-density-512-1vcpu"
  | "BaseLayer-Spearow-fluid-density"
  | "BaseLayer-Fearow-density-navcap-12"
  | "BaseLayer-Ekans-density-navcap-16"
  | "BaseLayer-Arbok-density-navcap-20"
  | "BaseLayer-Pikachu-density-mem1536"
  | "BaseLayer-Raichu-density-mem1280"
  | "BaseLayer-Sandshrew-density-mem1792"
  | "BaseLayer-Sandslash-density-mem2048"
  | "BaseLayer-Nidoran-F-density-navcap16-mem1536"
  | "BaseLayer-Nidorina-density-navcap16-mem2048"
  | "BaseLayer-Nidoqueen-fluid-density-navcap-16"
  | "BaseLayer-Nidoran-M-fluid-density-cgroups"
  | "BaseLayer-Nidorino-density-launch-cap-12"
  | "BaseLayer-Nidoking-density-navcap-8"
  | "BaseLayer-Clefairy-2vcpu-navcap-12"
  | "BaseLayer-Clefable-2vcpu-navcap-16"
  | "BaseLayer-Vulpix-density-cdp-warm"
  | "BaseLayer-Ninetales-density-context-warm"
  | "BaseLayer-Jigglypuff-density-target-warm"
  | "BaseLayer-Wigglytuff-density-blank-warm"
  | "BaseLayer-Zubat-density-cdp-warm-navcap-8"
  | "BaseLayer-Oddish-kernel-goto"
  | "BaseLayer-Gloom-kernel-goto-lite"
  | "BaseLayer-Vileplume-kernel-feature-prune"
  | "BaseLayer-Gengar-kernel-startup-prune"
  | "BaseLayer-Machop-gengar-automation-navcap-16"
  | "BaseLayer-Machoke-gengar-network-calm-navcap-16"
  | "BaseLayer-Paras-kernel-goto-ipv6off"
  | "BaseLayer-Dragonite-kernel-balanced"
  | "BaseLayer-Parasect-kernel-goto-cdp-warm"
  | "BaseLayer-Krabby-kernel-startup-prune-lite"
  | "BaseLayer-Kingler-kernel-balanced-lite"
  | "BaseLayer-Horsea-async-gengar-merge"
  | "BaseLayer-Seadra-async-dragonite-merge"
  | "BaseLayer-Goldeen-async-gloom-merge"
  | "BaseLayer-Poliwag-async-manual-gengar"
  | "BaseLayer-Poliwhirl-async-manual-dragonite"
  | "BaseLayer-Staryu-custom-shell-startup-network"
  | "BaseLayer-Starmie-async-custom-shell-merge"
  | "BaseLayer-Abra-custom-shell-baseline"
  | "BaseLayer-Kadabra-custom-shell-startup-prune"
  | "BaseLayer-Alakazam-custom-shell-async-manual"
  | "BaseLayer-Ditto-custom-shell-kernel-balanced";

export type UnsupportedProfileId =
  | "BaseLayer-Venomoth-dedicated-vm"
  | "BaseLayer-Diglett-paused-microvm-pool"
  | "BaseLayer-Dugtrio-unikraft-standby"
  | "BaseLayer-Meowth-lightpanda-runtime"
  | "BaseLayer-Persian-managed-ksm-cow";

export type ProfileId = SupportedProfileId | UnsupportedProfileId;

export interface SupportedProfileConfig {
  id: SupportedProfileId;
  label: string;
  benchmarkSupport: "supported";
  mode: "baseline" | "managed" | "firecracker";
  description: string;
  defaultAgentEnv: Record<string, string>;
}

export interface UnsupportedProfileConfig {
  id: UnsupportedProfileId;
  label: string;
  benchmarkSupport: "planned";
  description: string;
  reason: string;
}

export type ProfileConfig = SupportedProfileConfig | UnsupportedProfileConfig;

export interface SessionResponse {
  sessionId: string;
  status: string;
  hostId: string;
  connectUrl: string;
  cdpUrl: string;
  playwrightUrl: string;
  puppeteerUrl: string;
  debugHttpUrl: string;
  expiresAt: string;
  createdAt: string;
  launchTimings?: {
    totalMs: number;
    networkSetupMs?: number;
    networkClaimMs?: number;
    networkValidateMs?: number;
    networkPrepareMissMs?: number;
    helperCleanupMs?: number;
    processSpawnMs?: number;
    configureMs?: number;
    relayReadyMs?: number;
    cdpReadyMs?: number;
    cdpSocketReadyMs?: number;
    cdpVersionReadyMs?: number;
    cdpTargetListReadyMs?: number;
  };
}

/** DOM Performance API snapshot after first `page.goto` (real sites; data URLs may be sparse). */
export interface NavigationMetricsSnapshot {
  /** `PerformanceNavigationTiming.responseStart` (ms since navigation start). */
  responseStartMs?: number;
  domContentLoadedEventEndMs?: number;
  loadEventEndMs?: number;
  /** `first-paint` entry startTime when available. */
  firstPaintMs?: number;
  /** `first-contentful-paint` entry startTime when available. */
  firstContentfulPaintMs?: number;
  transferSizeBytes?: number;
  decodedBodySizeBytes?: number;
  /** `domainLookupEnd - domainLookupStart` when both are set (DNS phase). */
  dnsLookupMs?: number;
  /** `connectEnd - connectStart` (TCP + TLS setup window; includes TLS when HTTPS). */
  tcpConnectMs?: number;
  /** TLS segment when `secureConnectionStart` is set: `connectEnd - secureConnectionStart`. */
  tlsMs?: number;
  /** TTFB-style: `responseStart - requestStart`. */
  requestToResponseMs?: number;
  /** Main-thread / DOM: `domContentLoadedEventEnd - responseStart`. */
  responseToDomContentLoadedMs?: number;
}

/**
 * Aligned with BrowserArena `hello-browser` stage names (see browserarena-results.md).
 * `session_release_ms` is end-to-end API delete including host teardown (control plane awaits agent terminate).
 */
export interface IterationResult {
  session_creation_ms: number;
  session_connect_ms: number;
  page_goto_ms: number;
  session_release_ms: number;
  total_ms: number;
  ok: boolean;
  /** From Playwright `browser.version()` after CDP connect. */
  browserVersion?: string;
  navigationMetrics?: NavigationMetricsSnapshot;
  /** When `ok` is false. */
  failureClass?: BenchFailureClass;
  failureMessage?: string;
}

export type BenchFailureClass =
  | "timeout"
  | "network"
  | "admission"
  | "http_client"
  | "http_server"
  | "browser_crash"
  | "unknown";

export interface LatencyMetricStats {
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  stddev: number;
}

export interface LatencyBenchmarkResult {
  profileId: ProfileId;
  label: string;
  iterations: IterationResult[];
  successRate: number;
  session_creation_ms: LatencyMetricStats;
  session_connect_ms: LatencyMetricStats;
  page_goto_ms: LatencyMetricStats;
  session_release_ms: LatencyMetricStats;
  total_ms: LatencyMetricStats;
  /** Per-iteration total lifecycle; not a sum of stage percentiles. */
  browserarena_latency_ms: LatencyMetricStats;
  /** Populated when iterations include DOM navigation timings (real URLs). */
  firstContentfulPaintMs?: LatencyMetricStats;
  runMetadata?: BenchmarkRunMetadata;
}

export interface DensityLevelResult {
  requestedConcurrency: number;
  sessionCreateSuccesses: number;
  navigationSuccesses: number;
  createSuccessRate: number;
  navigationSuccessRate: number;
  avgCreateMs: number;
  /** First navigation wall time after CDP connect: context/page setup, `page.goto`, optional bench-ready wait, `title()`. */
  avgNavigateMs: number;
  /** Same boundaries as sequential `measureBrowserArenaStages` / BrowserArena `page_goto_ms`. */
  avgPageGotoMs?: number;
  p50PageGotoMs?: number;
  p95PageGotoMs?: number;
  p99PageGotoMs?: number;
  maxPageGotoMs?: number;
  stddevPageGotoMs?: number;
  /** `avgCreateMs + avgSessionConnectMs + avgNavigateMs`, for density lifecycle comparison. */
  avgLifecycleMs?: number;
  /** `avgCreateMs + avgSessionConnectMs + avgPageGotoMs`, narrower BrowserArena-stage lifecycle proxy. */
  avgCreateConnectGotoMs?: number;
  avgNavigationQueueWaitMs?: number;
  p95NavigationQueueWaitMs?: number;
  avgConnectQueueWaitMs?: number;
  p95ConnectQueueWaitMs?: number;
  avgDeleteMs?: number;
  p95DeleteMs?: number;
  avgLifecycleWithDeleteMs?: number;
  avgCreateConnectGotoDeleteMs?: number;
  /** CDP `connectOverCDP` duration only. */
  avgSessionConnectMs?: number;
  p50SessionConnectMs?: number;
  p95SessionConnectMs?: number;
  p99SessionConnectMs?: number;
  maxSessionConnectMs?: number;
  stddevSessionConnectMs?: number;
  p99DeleteMs?: number;
  maxDeleteMs?: number;
  /** Mean first-contentful-paint (ms) when navigation metrics were available. */
  avgFirstContentfulPaintMs?: number;
  /** Counts by `classifyBenchFailure` for failed session creates. */
  createFailureTaxonomy?: Record<string, number>;
  /** Counts for failed navigations / exerciseSession. */
  navigationFailureTaxonomy?: Record<string, number>;
  /** Counts for failed session DELETE / teardown. */
  deleteFailureTaxonomy?: Record<string, number>;
  soakSeconds: number;
  workloadMode?: "steady" | "bursty";
  burstCount?: number;
  burstRoundsPerBurst?: number;
  burstIdleMs?: number;
  burstStaggerMs?: number;
  activeSessionCount: number;
  idleSessionCount: number;
  soakActionSuccesses: number;
  soakActionFailures: number;
  hostStatus: string;
  hostActiveSessions: number;
  hostActiveRendererCount: number;
  hostTrackedMemoryMb: number;
  hostTrackedShmUsedMb: number;
  crashCount5m: number;
  pressureSampleCount: number;
  peakTrackedMemoryMb: number;
  peakMemoryPressurePct: number;
  peakTrackedShmUsedMb: number;
  peakCpuUtilizationPct: number;
  peakLoadAvg1m: number;
  avgLaunchTotalMs?: number;
  avgLaunchNetworkSetupMs?: number;
  avgLaunchNetworkClaimMs?: number;
  avgLaunchNetworkValidateMs?: number;
  avgLaunchHelperCleanupMs?: number;
  avgLaunchProcessSpawnMs?: number;
  avgLaunchConfigureMs?: number;
  avgLaunchCdpReadyMs?: number;
  avgLaunchCdpSocketReadyMs?: number;
  avgLaunchCdpVersionReadyMs?: number;
  avgLaunchCdpTargetListReadyMs?: number;
  p95LaunchTotalMs?: number;
  p95LaunchHelperCleanupMs?: number;
  p95LaunchProcessSpawnMs?: number;
  p95LaunchConfigureMs?: number;
  p95LaunchCdpReadyMs?: number;
  reportPath?: string;
}

export interface DensityBenchmarkResult {
  profileId: ProfileId;
  label: string;
  levels: DensityLevelResult[];
  maxStableConcurrency: number;
  runMetadata?: BenchmarkRunMetadata;
}

/** Captured once per benchmark process (kernel/rootfs stats, host shape). */
export interface BenchmarkRunMetadata {
  collectedAt: string;
  os: string;
  platform: string;
  nodeVersion: string;
  profileId?: string;
  cpuModel?: string;
  transparentHugepage?: string;
  cgroupControllers?: string;
  firecrackerVersion?: string;
  firecrackerKernelPath?: string;
  firecrackerKernelBytes?: number;
  firecrackerKernelMtimeMs?: number;
  firecrackerKernelVersionLabel?: string;
  firecrackerRootfsPath?: string;
  firecrackerRootfsBytes?: number;
  firecrackerRootfsMtimeMs?: number;
}

export interface ManagedChild {
  pid: number;
  output: string[];
  logPath?: string;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  onceExit: () => Promise<void>;
  killed: () => boolean;
}

export interface AgentHealth {
  ok: boolean;
  hostId: string;
  mode: "baseline" | "managed" | "firecracker";
  activeSessions: number;
  launchReservations: number;
  preparingRuntimeCount: number;
  preparingSessionRuntimeCount?: number;
  preparingWarmRuntimeCount?: number;
  warmPoolDepth: number;
  warmPoolTarget: number;
  activeRendererCount?: number;
  trackedMemoryMb?: number;
  trackedShmUsedMb?: number;
  activeMicrovmCount?: number;
  networkSlotCount?: number;
  freeNetworkSlotCount?: number;
  preparingNetworkPool?: boolean;
  reservedMicrovmMemoryMb?: number;
  avgRestoreMs?: number;
  cpuUtilizationPct?: number;
  loadAvg1m?: number;
  loadAvg5m?: number;
  highPrioritySessionCount?: number;
}

export interface HostSnapshot {
  hostId: string;
  status: string;
  metrics: {
    totalMemoryMb: number;
    freeMemoryMb: number;
    usedMemoryMb: number;
    memoryPressurePct: number;
    shmCapacityMb: number;
    shmUsedMb: number;
    activeSessions: number;
    activeRendererCount: number;
    trackedMemoryMb: number;
    trackedShmUsedMb: number;
    crashCount5m: number;
    activeMicrovmCount: number;
    reservedMicrovmMemoryMb: number;
    avgRestoreMs: number;
    cpuUtilizationPct: number;
    loadAvg1m: number;
    loadAvg5m: number;
    highPrioritySessionCount: number;
  };
}

export interface SessionSnapshot {
  sessionId: string;
  status: string;
  exitReason?: string;
  lastKnownMetrics?: {
    memoryMb: number;
    cpuPct: number;
    rendererCount: number;
    shmUsedMb: number;
    memoryLimitMb: number;
    shmLimitMb: number;
    activityState?: "launching" | "active-navigation" | "interactive-idle" | "soak-idle";
    schedulerWeight?: number;
  };
}

export interface PressureSample {
  collectedAt: string;
  host?: HostSnapshot;
  sessions: SessionSnapshot[];
  summary: {
    sessionCount: number;
    trackedSessionMemoryMb: number;
    trackedSessionShmUsedMb: number;
    trackedSessionRendererCount: number;
    trackedSessionCpuPct: number;
    maxSessionMemoryMb: number;
    maxSessionRendererCount: number;
    maxSessionCpuPct: number;
  };
}
