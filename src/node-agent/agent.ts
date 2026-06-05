import crypto from "node:crypto";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { runtimeConfig, agentConfig, controlPlaneConfig } from "../shared/config.js";
import { log, logError } from "../shared/logging.js";
import { expiresAtFromNow } from "../shared/time.js";
import {
  type AgentMode,
  type CreateSessionRequest,
  type HostHeartbeat,
  type HostRegistration,
  type RuntimeLaunchResult,
  type SessionLogSnapshot,
  type SessionActivityState,
} from "../shared/types.js";
import {
  dockerInspectPorts,
  dockerInspectRunning,
  dockerInspectState,
  dockerLogs,
  dockerRemove,
  dockerRendererCount,
  dockerRun,
  dockerShmUsage,
  dockerStats,
  waitForLogMatch,
  waitForHttp,
  waitForJson,
} from "./docker.js";
import { FirecrackerOrchestrator, cleanupFirecrackerHostResources } from "./firecracker.js";
import { collectHostMetrics, type HostMetricsSnapshot } from "./host-metrics.js";

interface ManagedSession {
  sessionId: string;
  containerId: string;
  containerName: string;
  runtimeKind: "container" | "microvm";
  startedAt: string;
  expiresAt: string;
  keepAlive: boolean;
  timeoutSec: number;
  idleTimeoutSec: number;
  mode: AgentMode;
  lastKnownMetrics?: {
    memoryMb: number;
    cpuPct: number;
    rendererCount: number;
    shmUsedMb: number;
    memoryLimitMb: number;
    shmLimitMb: number;
    activityState: SessionActivityState;
    schedulerWeight: number;
  };
  recentLogs?: SessionLogSnapshot;
}

interface PreparedRuntime {
  containerId: string;
  containerName: string;
  browserWsPath: string;
  relayPort: number;
}

interface WarmPoolCapacityReport {
  runtimeProfile: string;
  readyCount: number;
  targetCount: number;
  refillInFlight: number;
}

interface WarmPoolCapacityReportInput {
  mode: AgentMode;
  warmPoolSize: number;
  supportedRuntimeProfiles: string[];
  firecrackerWarmPoolSessionCount: number;
  managedWarmPoolCount: number;
  preparingWarmRuntimeCount: number;
}

interface FirecrackerWarmRuntimeSelectionInput {
  mode: AgentMode;
  warmPoolSize: number;
  supportedRuntimeProfiles: string[];
  requestedRuntimeProfile: string | undefined;
  proxyProfile: string | undefined;
  readyWarmSessionCount: number;
}

interface FirecrackerWarmFillTargetInput {
  warmPoolSize: number;
  warmPoolFillConcurrency: number;
  maxMicrovmCount: number;
  activeMicrovmCount: number;
  preparingWarmRuntimeCount: number;
  readyWarmSessionCount: number;
}

export function computeLaunchReservationStaleThresholdMs(
  firecrackerRestoreTimeoutMs: number,
  remoteCreateTimeoutMs: number,
): number {
  return Math.max(
    Math.max(firecrackerRestoreTimeoutMs + 5_000, 35_000),
    remoteCreateTimeoutMs + 1_000,
  );
}

export function resolveWarmPoolRuntimeProfile(
  supportedRuntimeProfiles: string[],
): string | undefined {
  if (supportedRuntimeProfiles.length !== 1) {
    return undefined;
  }
  return supportedRuntimeProfiles[0];
}

export function resolveEligibleFirecrackerWarmRuntimeProfile(
  input: FirecrackerWarmRuntimeSelectionInput,
): string | undefined {
  if (input.mode !== "firecracker" || input.warmPoolSize <= 0) {
    return undefined;
  }

  if (input.proxyProfile) {
    return undefined;
  }

  const runtimeProfile = resolveWarmPoolRuntimeProfile(input.supportedRuntimeProfiles);
  if (!runtimeProfile) {
    return undefined;
  }

  if (input.requestedRuntimeProfile && input.requestedRuntimeProfile !== runtimeProfile) {
    return undefined;
  }

  if (input.readyWarmSessionCount <= 0) {
    return undefined;
  }

  return runtimeProfile;
}

export function computeFirecrackerWarmFillTarget(
  input: FirecrackerWarmFillTargetInput,
): number {
  const remainingCapacity =
    input.maxMicrovmCount - (input.activeMicrovmCount + input.preparingWarmRuntimeCount);
  const missingWarmSlots =
    input.warmPoolSize - (input.readyWarmSessionCount + input.preparingWarmRuntimeCount);

  return Math.max(
    0,
    Math.min(
      missingWarmSlots,
      remainingCapacity,
      Math.max(1, input.warmPoolFillConcurrency),
    ),
  );
}

export function shouldDeferWarmPoolMaintenance(input: {
  mode: AgentMode;
  activeSessionCount: number;
  launchReservationCount: number;
  preparingSessionRuntimeCount: number;
}): boolean {
  if (input.mode !== "managed") {
    return false;
  }

  return (
    input.activeSessionCount > 0 ||
    input.launchReservationCount > 0 ||
    input.preparingSessionRuntimeCount > 0
  );
}

export function buildWarmPoolCapacityReports(
  input: WarmPoolCapacityReportInput,
): WarmPoolCapacityReport[] {
  if (input.warmPoolSize <= 0) {
    return [];
  }

  const runtimeProfile = resolveWarmPoolRuntimeProfile(input.supportedRuntimeProfiles);
  if (!runtimeProfile) {
    return [];
  }

  return [
    {
      runtimeProfile,
      readyCount:
        input.mode === "firecracker"
          ? input.firecrackerWarmPoolSessionCount
          : input.managedWarmPoolCount,
      targetCount: input.warmPoolSize,
      refillInFlight: input.preparingWarmRuntimeCount,
    },
  ];
}

class AsyncGate {
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.limit <= 0) {
      return () => undefined;
    }

    if (this.#active >= this.limit) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }

    this.#active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#active = Math.max(0, this.#active - 1);
      this.#waiters.shift()?.();
    };
  }
}

export class NodeAgent {
  readonly #sessions = new Map<string, ManagedSession>();

  readonly #firecracker = new FirecrackerOrchestrator();

  // Warm-prep (refill) gate. Kept SEPARATE from cold restores so a cold-restore burst
  // can never queue ahead of refill on a shared FIFO and starve the warm pool — the
  // positive-feedback cliff that collapsed c10 reliability.
  readonly #firecrackerLaunchGate = new AsyncGate(agentConfig.firecrackerLaunchConcurrency);
  // Cold restores (warm-pool fallback + no-warm-profile path) get their own small gate.
  readonly #coldRestoreGate = new AsyncGate(agentConfig.firecrackerColdRestoreConcurrency);

  readonly #crashEvents: number[] = [];

  readonly #warmPool: PreparedRuntime[] = [];
  readonly #firecrackerWarmPoolSessionIds: string[] = [];

  #warmPoolFillPromise: Promise<void> | undefined;

  readonly #terminatingSessionIds = new Map<string, number>();

  readonly #launchReservations = new Map<string, number>();
  readonly #activeFirecrackerLaunchSessionIds = new Set<string>();

  #preparingSessionRuntimeCount = 0;

  #preparingWarmRuntimeCount = 0;

  #lastHostMetrics: HostMetricsSnapshot | undefined;

  readonly #hostCpuCount = os.cpus().length;

  #launchReservationCount(): number {
    return this.#launchReservations.size;
  }

  #pruneStaleLaunchReservations(nowMs = Date.now()): void {
    const staleThresholdMs = computeLaunchReservationStaleThresholdMs(
      agentConfig.firecrackerRestoreTimeoutMs,
      controlPlaneConfig.remoteCreateTimeoutMs,
    );
    for (const [sessionId, reservedAtMs] of this.#launchReservations.entries()) {
      if (nowMs - reservedAtMs < staleThresholdMs) {
        continue;
      }

      if (this.#activeFirecrackerLaunchSessionIds.has(sessionId)) {
        continue;
      }

      if (this.#sessions.has(sessionId) || this.#firecracker.hasSession(sessionId)) {
        continue;
      }

      this.#launchReservations.delete(sessionId);
      log("node-agent", "stale-launch-reservation-cleared", {
        sessionId,
        reservedAtMs,
        staleThresholdMs,
      });
    }
  }

  #markSessionTerminating(sessionId: string): void {
    this.#terminatingSessionIds.set(sessionId, Date.now() + 15_000);
  }

  #isSessionTerminating(sessionId: string): boolean {
    const expiresAt = this.#terminatingSessionIds.get(sessionId);
    if (!expiresAt) {
      return false;
    }

    if (expiresAt <= Date.now()) {
      this.#terminatingSessionIds.delete(sessionId);
      return false;
    }

    return true;
  }

  #scheduleWarmPoolMaintenance(): void {
    if (agentConfig.warmPoolSize <= 0) {
      return;
    }

    queueMicrotask(() => {
      void this.ensureWarmPool().catch((error) => {
        logError("node-agent", "warm-pool-fill-failed", error);
      });
    });
  }

  #sendHeartbeatSoon(reason: string): void {
    void this.sendHeartbeat().catch((error) => {
      logError("node-agent", "immediate-heartbeat-failed", error, { reason });
    });
  }

  async prepareRuntimeMode(): Promise<void> {
    if (agentConfig.mode !== "firecracker") {
      return;
    }

    await this.#firecracker.reconcileStaleResources();

    if (!this.#firecracker.snapshotExists()) {
      if (!agentConfig.firecrackerAllowAutoSnapshot) {
        throw new Error(
          `Firecracker snapshot '${agentConfig.firecrackerSnapshotName}' is missing. ` +
            "Create it with 'npm run bench:firecracker-proof' or enable FIRECRACKER_ALLOW_AUTO_SNAPSHOT=1.",
        );
      }

      await this.#firecracker.ensureBaseSnapshot();
    }

    await this.#firecracker.prepareNetworkPool(true);
  }

  async shutdown(): Promise<void> {
    const sessionIds = [...this.#sessions.keys()];
    await Promise.allSettled(
      sessionIds.map((sessionId) => this.terminateSession(sessionId, "agent-shutdown")),
    );

    const warmRuntimes = this.#warmPool.splice(0, this.#warmPool.length);
    await Promise.allSettled(
      warmRuntimes.map((runtime) => dockerRemove(runtime.containerId).catch(() => undefined)),
    );
    const warmFirecrackerSessionIds = this.#firecrackerWarmPoolSessionIds.splice(
      0,
      this.#firecrackerWarmPoolSessionIds.length,
    );
    await Promise.allSettled(
      warmFirecrackerSessionIds.map((sessionId) =>
        this.#firecracker.terminateSession(sessionId).catch(() => undefined),
      ),
    );

    if (agentConfig.mode === "firecracker") {
      await cleanupFirecrackerHostResources().catch(() => undefined);
    }
  }

  async register(): Promise<void> {
    const payload: HostRegistration = {
      hostId: agentConfig.hostId,
      name: agentConfig.hostName,
      apiUrl:
        agentConfig.publicApiUrl || `http://${agentConfig.apiHost}:${agentConfig.port}`,
      mode: agentConfig.mode,
      region: agentConfig.region || undefined,
      instanceType: agentConfig.instanceType || undefined,
      labels: agentConfig.labels,
      supportedRuntimeProfiles:
        agentConfig.supportedRuntimeProfiles.length > 0
          ? agentConfig.supportedRuntimeProfiles
          : undefined,
      capacity: {
        maxSessions: agentConfig.maxSessions,
        maxRendererCount: agentConfig.maxRendererCount,
        sessionMemoryLimitMb: agentConfig.sessionMemoryLimitMb,
        sessionShmLimitMb: agentConfig.sessionShmLimitMb,
        sessionRendererLimit: agentConfig.sessionRendererLimit,
        minFreeMemoryMb: agentConfig.minFreeMemoryMb,
        maxShmUtilizationPct: agentConfig.maxShmUtilizationPct,
        maxCrashCount5m: agentConfig.maxCrashCount5m,
        maxMicrovmCount: agentConfig.firecrackerMaxMicrovmCount,
        microvmMemoryMb: agentConfig.firecrackerGuestMemoryMb,
        microvmVcpuCount: agentConfig.firecrackerGuestVcpuCount,
        maxConcurrentActiveNavigation: agentConfig.firecrackerMaxConcurrentActiveNavigation,
      },
    };

    const response = await fetch(`${agentConfig.controlPlaneUrl}/internal/hosts/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Failed to register node agent: ${response.status} ${await response.text()}`);
    }
  }

  async sendHeartbeat(): Promise<HostHeartbeat> {
    const hostMetrics = await collectHostMetrics();
    this.#lastHostMetrics = hostMetrics;
    const footprint = this.#sessionFootprintSummary();
    const crashCount5m = this.#countCrashes(Date.now() - 5 * 60 * 1000);
    const status = this.#deriveStatus({
      ...hostMetrics,
      activeSessions: this.#sessions.size + this.#launchReservationCount(),
      activeRendererCount: footprint.activeRendererCount,
      crashCount5m,
      activeNavigationSessionCount:
        agentConfig.mode === "firecracker" ? this.#firecracker.activeNavigationSessionCount : 0,
    });

    const activeSessions = this.#sessions.size + this.#launchReservationCount();
    const warmPools = this.#warmPoolCapacityReports();
    const payload: HostHeartbeat = {
      hostId: agentConfig.hostId,
      mode: agentConfig.mode,
      status,
      capacity: {
        maxSessions: agentConfig.maxSessions,
        maxRendererCount: agentConfig.maxRendererCount,
        sessionMemoryLimitMb: agentConfig.sessionMemoryLimitMb,
        sessionShmLimitMb: agentConfig.sessionShmLimitMb,
        sessionRendererLimit: agentConfig.sessionRendererLimit,
        minFreeMemoryMb: agentConfig.minFreeMemoryMb,
        maxShmUtilizationPct: agentConfig.maxShmUtilizationPct,
        maxCrashCount5m: agentConfig.maxCrashCount5m,
        maxMicrovmCount: agentConfig.firecrackerMaxMicrovmCount,
        microvmMemoryMb: agentConfig.firecrackerGuestMemoryMb,
        microvmVcpuCount: agentConfig.firecrackerGuestVcpuCount,
        maxConcurrentActiveNavigation: agentConfig.firecrackerMaxConcurrentActiveNavigation,
      },
      metrics: {
        ...hostMetrics,
        activeSessions,
        activeRendererCount: footprint.activeRendererCount,
        trackedMemoryMb: footprint.trackedMemoryMb,
        trackedShmUsedMb: footprint.trackedShmUsedMb,
        crashCount5m,
        activeMicrovmCount: this.#firecracker.activeMicrovmCount,
        reservedMicrovmMemoryMb: this.#firecracker.reservedMemoryMb,
        avgRestoreMs: this.#firecracker.averageRestoreMs,
        cpuUtilizationPct: hostMetrics.cpuUtilizationPct,
        loadAvg1m: hostMetrics.loadAvg1m,
        loadAvg5m: hostMetrics.loadAvg5m,
        highPrioritySessionCount: this.#firecracker.highPrioritySessionCount,
        activeNavigationSessionCount:
          agentConfig.mode === "firecracker" ? this.#firecracker.activeNavigationSessionCount : 0,
        coldAdmitRemaining: this.#coldAdmitRemaining(activeSessions),
        warmPools,
      },
      reportedAt: new Date().toISOString(),
    };

    const response = await fetch(
      `${agentConfig.controlPlaneUrl}/internal/hosts/${agentConfig.hostId}/heartbeat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to send heartbeat: ${response.status} ${await response.text()}`);
    }

    return payload;
  }

  async launchSession(input: CreateSessionRequest & { sessionId: string }): Promise<RuntimeLaunchResult> {
    const releaseReservation = await this.#reserveLaunchSlot(input.sessionId);
    let releaseLaunchGate: (() => void) | undefined;
    let trackedFirecrackerLaunch = false;

    try {
      let runtime: RuntimeLaunchResult;
      if (agentConfig.mode === "firecracker") {
        this.#activeFirecrackerLaunchSessionIds.add(input.sessionId);
        trackedFirecrackerLaunch = true;
        const warmedRuntimeProfile = this.#effectiveFirecrackerWarmRuntimeProfile(
          input.runtimeProfile,
          input.proxyProfile,
        );
        if (warmedRuntimeProfile) {
          runtime = await this.#acquireWarmFirecrackerRuntime(
            input.sessionId,
            warmedRuntimeProfile,
          );
        } else {
          await this.#assertAdmission();
          releaseLaunchGate = await this.#coldRestoreGate.acquire();
          runtime = await this.#firecracker.restoreSession(input.sessionId, {
            proxyProfile: input.proxyProfile,
          });
        }
      } else {
        await this.#assertAdmission();
        runtime = await this.#launchContainerSession(input.sessionId);
      }

      this.#sessions.set(input.sessionId, {
        sessionId: input.sessionId,
        containerId: runtime.containerId,
        containerName: runtime.containerName,
        runtimeKind: runtime.runtimeKind,
        startedAt: runtime.startedAt,
        expiresAt: expiresAtFromNow(input.timeoutSec),
        keepAlive: input.keepAlive,
        timeoutSec: input.timeoutSec,
        idleTimeoutSec: input.idleTimeoutSec,
        mode: agentConfig.mode,
        lastKnownMetrics: {
          memoryMb:
            runtime.runtimeKind === "microvm"
              ? this.#firecracker.sessionMetrics(input.sessionId)?.memoryMb ??
                agentConfig.firecrackerGuestMemoryMb
              : 0,
          cpuPct: 0,
          rendererCount: runtime.runtimeKind === "microvm" ? 1 : 0,
          shmUsedMb: 0,
          memoryLimitMb:
            runtime.runtimeKind === "microvm"
              ? agentConfig.firecrackerGuestMemoryMb
              : agentConfig.sessionMemoryLimitMb,
          shmLimitMb:
            runtime.runtimeKind === "microvm"
              ? agentConfig.sessionShmLimitMb
              : agentConfig.sessionShmLimitMb,
          activityState:
            runtime.runtimeKind === "microvm" ? "launching" : "interactive-idle",
          schedulerWeight:
            runtime.runtimeKind === "microvm"
              ? agentConfig.firecrackerCpuWeightLaunching
              : 0,
        },
      });

      log("node-agent", "session-launched", {
        sessionId: input.sessionId,
        containerId: runtime.containerId,
        mode: agentConfig.mode,
        runtimeKind: runtime.runtimeKind,
      });

      this.#scheduleWarmPoolMaintenance();
      this.#sendHeartbeatSoon("session-launched");

      return runtime;
    } catch (error) {
      throw error;
    } finally {
      if (trackedFirecrackerLaunch) {
        this.#activeFirecrackerLaunchSessionIds.delete(input.sessionId);
      }
      releaseLaunchGate?.();
      releaseReservation();
    }
  }

  async terminateSession(sessionId: string, reason = "terminated-by-api"): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.#markSessionTerminating(sessionId);
    try {
      const recentLogs = await this.getSessionLogSnapshot(sessionId);
      this.#sessions.delete(sessionId);
      if (session.runtimeKind === "microvm") {
        await this.#firecracker.terminateSession(sessionId).catch(() => undefined);
      } else {
        await dockerRemove(session.containerId).catch(() => undefined);
      }
      await this.#postSessionUpdate(sessionId, {
        status: "terminated",
        exitReason: reason,
        recentLogs,
      });
    } finally {
      this.#scheduleWarmPoolMaintenance();
      this.#sendHeartbeatSoon("session-terminated");
    }
  }

  async getSessionLogSnapshot(sessionId: string): Promise<SessionLogSnapshot | undefined> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    if (session.runtimeKind === "microvm") {
      return this.#firecracker.sessionLogSnapshot(sessionId);
    }

    const lines = (await dockerLogs(session.containerId)).slice(-80);
    return {
      source: "node-agent-container",
      capturedAt: new Date().toISOString(),
      lines,
    };
  }

  async markSessionActivity(
    sessionId: string,
    activityState: SessionActivityState,
  ): Promise<boolean> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return false;
    }

    if (session.runtimeKind === "microvm") {
      const updated = this.#firecracker.markSessionActivity(sessionId, activityState);
      if (!updated) {
        return false;
      }
      session.lastKnownMetrics = {
        memoryMb: session.lastKnownMetrics?.memoryMb ?? agentConfig.firecrackerGuestMemoryMb,
        cpuPct: session.lastKnownMetrics?.cpuPct ?? 0,
        rendererCount: session.lastKnownMetrics?.rendererCount ?? 1,
        shmUsedMb: session.lastKnownMetrics?.shmUsedMb ?? 0,
        memoryLimitMb: agentConfig.firecrackerGuestMemoryMb,
        shmLimitMb: agentConfig.sessionShmLimitMb,
        activityState,
        schedulerWeight:
          this.#firecracker.sessionMetrics(sessionId)?.schedulerWeight ??
          session.lastKnownMetrics?.schedulerWeight ??
          0,
      };
      return true;
    }

    session.lastKnownMetrics = {
      memoryMb: session.lastKnownMetrics?.memoryMb ?? 0,
      cpuPct: session.lastKnownMetrics?.cpuPct ?? 0,
      rendererCount: session.lastKnownMetrics?.rendererCount ?? 0,
      shmUsedMb: session.lastKnownMetrics?.shmUsedMb ?? 0,
      memoryLimitMb: session.lastKnownMetrics?.memoryLimitMb ?? agentConfig.sessionMemoryLimitMb,
      shmLimitMb: session.lastKnownMetrics?.shmLimitMb ?? agentConfig.sessionShmLimitMb,
      activityState,
      schedulerWeight: 0,
    };
    return true;
  }

  async monitorSessions(): Promise<void> {
    this.#pruneStaleLaunchReservations();
    this.#firecracker.refreshScheduling();
    const sessions = [...this.#sessions.values()];

    const microvmSessions = sessions.filter((s) => s.runtimeKind === "microvm");
    const containerSessions = sessions.filter((s) => s.runtimeKind === "container");

    for (const session of microvmSessions) {
      const metrics = this.#firecracker.sessionMetrics(session.sessionId);
      const running = this.#firecracker.hasSession(session.sessionId);

      if (!running) {
        this.#sessions.delete(session.sessionId);
        const terminatedByAgent = this.#isSessionTerminating(session.sessionId);
        await this.#firecracker.terminateSession(session.sessionId).catch(() => undefined);
        if (!terminatedByAgent) {
          this.#recordCrash();
        }
        await this.#postSessionUpdate(session.sessionId, {
          status: terminatedByAgent ? "terminated" : "failed",
          exitReason: terminatedByAgent ? "terminated-by-api" : "microvm-exited",
          recentLogs: this.#firecracker.sessionLogSnapshot(session.sessionId),
        }).catch(() => undefined);
        continue;
      }

      session.lastKnownMetrics = {
        memoryMb: metrics?.memoryMb ?? agentConfig.firecrackerGuestMemoryMb,
        cpuPct: metrics?.cpuPct ?? 0,
        rendererCount: metrics?.rendererCount ?? 1,
        shmUsedMb: metrics?.shmUsedMb ?? 0,
        memoryLimitMb: agentConfig.firecrackerGuestMemoryMb,
        shmLimitMb: agentConfig.sessionShmLimitMb,
        activityState: metrics?.activityState ?? "interactive-idle",
        schedulerWeight: metrics?.schedulerWeight ?? 0,
      };

      await this.#postSessionUpdate(session.sessionId, {
        status: "running",
        lastKnownMetrics: session.lastKnownMetrics,
      }).catch((error) => {
        logError("node-agent", "session-update-failed", error, {
          sessionId: session.sessionId,
        });
      });

      if (new Date(session.expiresAt).getTime() <= Date.now()) {
        await this.terminateSession(session.sessionId, "timeout-expired");
      }
    }

    const containerChecks = containerSessions.map(async (session) => {
      const state = await dockerInspectState(session.containerId).catch(() => ({
        running: false,
        exitCode: 1,
        oomKilled: false,
      }));
      return { session, state };
    });
    const containerStates = await Promise.all(containerChecks);

    const aliveContainers = containerStates.filter((c) => c.state.running);
    const deadContainers = containerStates.filter((c) => !c.state.running);

    for (const { session, state } of deadContainers) {
      this.#sessions.delete(session.sessionId);
      const logs = await dockerLogs(session.containerId);
      const terminatedByAgent = this.#isSessionTerminating(session.sessionId);
      if (!terminatedByAgent && (state.oomKilled || state.exitCode !== 0)) {
        this.#recordCrash();
      }
      await this.#postSessionUpdate(session.sessionId, {
        status:
          terminatedByAgent || (!state.oomKilled && state.exitCode === 0)
            ? "terminated"
            : "failed",
        exitReason:
          logs.at(-1) ||
          (terminatedByAgent
            ? "terminated-by-api"
            : undefined) ||
          (state.oomKilled
            ? "container-oom-killed"
            : state.exitCode === 0
              ? "browser-closed"
              : `container-exited-${state.exitCode}`),
        recentLogs: {
          source: "node-agent-container",
          capturedAt: new Date().toISOString(),
          lines: logs.slice(-80),
        },
      }).catch(() => undefined);
    }

    const aliveChecks = aliveContainers.map(async ({ session }) => {
      const [stats, rendererCount, shm] = await Promise.all([
        dockerStats(session.containerId).catch(() => ({ memoryMb: 0, cpuPct: 0 })),
        dockerRendererCount(session.containerId),
        dockerShmUsage(session.containerId),
      ]);
      return { session, stats, rendererCount, shm };
    });
    const aliveMetrics = await Promise.all(aliveChecks);

    for (const { session, stats, rendererCount, shm } of aliveMetrics) {
      session.lastKnownMetrics = {
        memoryMb: stats.memoryMb,
        cpuPct: stats.cpuPct,
        rendererCount,
        shmUsedMb: shm.usedMb,
        memoryLimitMb: agentConfig.sessionMemoryLimitMb,
        shmLimitMb: agentConfig.sessionShmLimitMb,
        activityState: "interactive-idle",
        schedulerWeight: 0,
      };

      await this.#postSessionUpdate(session.sessionId, {
        status: "running",
        lastKnownMetrics: session.lastKnownMetrics,
      }).catch((error) => {
        logError("node-agent", "session-update-failed", error, {
          sessionId: session.sessionId,
        });
      });

      if (rendererCount > agentConfig.sessionRendererLimit) {
        await this.terminateSession(session.sessionId, "renderer-limit-exceeded");
        continue;
      }

      if (stats.memoryMb >= agentConfig.sessionMemoryLimitMb) {
        await this.terminateSession(session.sessionId, "memory-limit-exceeded");
        continue;
      }

      if (shm.usedMb >= agentConfig.sessionShmLimitMb) {
        await this.terminateSession(session.sessionId, "shm-limit-exceeded");
        continue;
      }

      if (new Date(session.expiresAt).getTime() <= Date.now()) {
        await this.terminateSession(session.sessionId, "timeout-expired");
      }
    }

    if (agentConfig.mode === "firecracker") {
      await this.#firecracker
        .reconcileTrackedSessions(
          new Set([
            ...this.#sessions.keys(),
            ...this.#firecrackerWarmPoolSessionIds,
          ]),
        )
        .catch((error) => {
          logError("node-agent", "firecracker-session-reconcile-failed", error);
        });
    }
  }

  async ensureWarmPool(): Promise<void> {
    if (agentConfig.warmPoolSize <= 0) {
      return;
    }

    if (
      shouldDeferWarmPoolMaintenance({
        mode: agentConfig.mode,
        activeSessionCount: this.#sessions.size,
        launchReservationCount: this.#launchReservationCount(),
        preparingSessionRuntimeCount: this.#preparingSessionRuntimeCount,
      })
    ) {
      return;
    }

    if (this.#warmPoolFillPromise) {
      return this.#warmPoolFillPromise;
    }

    this.#warmPoolFillPromise = (async () => {
      try {
        if (agentConfig.mode === "firecracker") {
          const runtimeProfile = this.#warmPoolRuntimeProfile();
          if (!runtimeProfile) {
            return;
          }

          await this.#firecracker.revalidateWarmSessions(runtimeProfile);
          for (let index = this.#firecrackerWarmPoolSessionIds.length - 1; index >= 0; index -= 1) {
            if (!this.#firecracker.hasSession(this.#firecrackerWarmPoolSessionIds[index])) {
              this.#firecrackerWarmPoolSessionIds.splice(index, 1);
            }
          }

          let targetBuildCount = computeFirecrackerWarmFillTarget({
            warmPoolSize: agentConfig.warmPoolSize,
            warmPoolFillConcurrency: agentConfig.warmPoolFillConcurrency,
            maxMicrovmCount: agentConfig.firecrackerMaxMicrovmCount,
            activeMicrovmCount: this.#firecracker.activeMicrovmCount,
            preparingWarmRuntimeCount: this.#preparingWarmRuntimeCount,
            readyWarmSessionCount: this.#firecrackerWarmPoolSessionIds.length,
          });

          // Safe refill pacing: cap per-tick fan-out so one refill round doesn't launch a
          // burst of parallel snapshot restores that contends with the wave's live
          // navigations (the contention that times out CDP readiness and kills guests
          // mid-goto -> page.goto "target closed"). This is a CAP, never a block, and is
          // NOT keyed on active-session count (that would starve the pool permanently
          // under sustained c10). Once the pool drops below a critical floor we refill at
          // the full computed rate to recover fast.
          const readyWarmCount = this.#firecrackerWarmPoolSessionIds.length;
          const criticalWarmFloor = Math.max(2, Math.floor(agentConfig.warmPoolSize * 0.25));
          if (readyWarmCount >= criticalWarmFloor) {
            const perTickFillCap = Math.max(1, Math.floor(agentConfig.warmPoolFillConcurrency / 2));
            targetBuildCount = Math.min(targetBuildCount, perTickFillCap);
          }

          await Promise.allSettled(
            Array.from({ length: targetBuildCount }, async () => {
              const warmSessionId = `warm-${crypto.randomUUID()}`;
              this.#preparingWarmRuntimeCount += 1;
              try {
                // Bound concurrent warm restores with the same launch gate the active
                // create path uses (#acquireWarmFirecrackerRuntime). Without this, a
                // warm-fill round fans out up to fillConcurrency parallel snapshot
                // restores whose mem-file page-faults saturate host IO and time out CDP
                // readiness ('cdp-version'/'cdp-websocket-upgrade') on cold rounds.
                const releaseLaunchGate = await this.#firecrackerLaunchGate.acquire();
                try {
                  await this.#firecracker.prepareWarmSession(warmSessionId, {
                    runtimeProfile,
                  });
                } finally {
                  releaseLaunchGate();
                }
                this.#firecrackerWarmPoolSessionIds.push(warmSessionId);
                log("node-agent", "warm-firecracker-prepared", {
                  sessionId: warmSessionId,
                  runtimeProfile,
                  poolDepth: this.#firecrackerWarmPoolSessionIds.length,
                });
              } catch (error) {
                logError("node-agent", "warm-firecracker-prepare-failed", error, {
                  sessionId: warmSessionId,
                  runtimeProfile,
                });
              } finally {
                this.#preparingWarmRuntimeCount = Math.max(0, this.#preparingWarmRuntimeCount - 1);
              }
            }),
          );
          return;
        }

        const remainingCapacity =
          agentConfig.maxSessions +
          agentConfig.warmPoolReserve -
          (
            this.#sessions.size +
            this.#launchReservationCount() +
            this.#warmPool.length +
            this.#preparingSessionRuntimeCount +
            this.#preparingWarmRuntimeCount
          );
        const missingWarmSlots =
          agentConfig.warmPoolSize -
          (this.#warmPool.length + this.#preparingWarmRuntimeCount);
        const targetBuildCount = Math.max(
          0,
          Math.min(
            missingWarmSlots,
            remainingCapacity,
            Math.max(1, agentConfig.warmPoolFillConcurrency),
          ),
        );

        await Promise.allSettled(
          Array.from({ length: targetBuildCount }, async () => {
            const prepared = await this.#prepareRuntime(`warm-${crypto.randomUUID()}`, {
              kind: "warm",
              recordCrashOnFailure: false,
            });
            this.#warmPool.push(prepared);
            log("node-agent", "warm-runtime-prepared", {
              containerId: prepared.containerId,
              poolDepth: this.#warmPool.length,
            });
          }),
        );
      } finally {
        this.#warmPoolFillPromise = undefined;
        this.#sendHeartbeatSoon("warm-pool-maintained");
      }
    })();

    return this.#warmPoolFillPromise;
  }

  getHealthSnapshot(): {
    activeSessions: number;
    launchReservations: number;
    preparingRuntimeCount: number;
    preparingSessionRuntimeCount: number;
    preparingWarmRuntimeCount: number;
    warmPoolDepth: number;
    warmPoolTarget: number;
    activeRendererCount: number;
    trackedMemoryMb: number;
    trackedShmUsedMb: number;
    activeMicrovmCount: number;
    networkSlotCount: number;
    freeNetworkSlotCount: number;
    preparingNetworkPool: boolean;
    reservedMicrovmMemoryMb: number;
    avgRestoreMs: number;
    cpuUtilizationPct: number;
    loadAvg1m: number;
    loadAvg5m: number;
    highPrioritySessionCount: number;
    coldAdmitRemaining: number;
    warmPools: WarmPoolCapacityReport[];
  } {
    const footprint = this.#sessionFootprintSummary();
    return {
      activeSessions: this.#sessions.size,
      launchReservations: this.#launchReservationCount(),
      preparingRuntimeCount:
        this.#preparingSessionRuntimeCount + this.#preparingWarmRuntimeCount,
      preparingSessionRuntimeCount: this.#preparingSessionRuntimeCount,
      preparingWarmRuntimeCount: this.#preparingWarmRuntimeCount,
      warmPoolDepth:
        agentConfig.mode === "firecracker"
          ? this.#firecrackerWarmPoolSessionIds.length
          : this.#warmPool.length,
      warmPoolTarget: agentConfig.warmPoolSize,
      activeRendererCount: footprint.activeRendererCount,
      trackedMemoryMb: footprint.trackedMemoryMb,
      trackedShmUsedMb: footprint.trackedShmUsedMb,
      activeMicrovmCount: this.#firecracker.activeMicrovmCount,
      networkSlotCount: this.#firecracker.networkSlotCount,
      freeNetworkSlotCount: this.#firecracker.freeNetworkSlotCount,
      preparingNetworkPool: this.#firecracker.preparingNetworkPool,
      reservedMicrovmMemoryMb: this.#firecracker.reservedMemoryMb,
      avgRestoreMs: this.#firecracker.averageRestoreMs,
      cpuUtilizationPct: this.#lastHostMetrics?.cpuUtilizationPct ?? 0,
      loadAvg1m: this.#lastHostMetrics?.loadAvg1m ?? 0,
      loadAvg5m: this.#lastHostMetrics?.loadAvg5m ?? 0,
      highPrioritySessionCount: this.#firecracker.highPrioritySessionCount,
      coldAdmitRemaining: this.#coldAdmitRemaining(
        this.#sessions.size + this.#launchReservationCount(),
      ),
      warmPools: this.#warmPoolCapacityReports(),
    };
  }

  async #acquireWarmRuntime(): Promise<PreparedRuntime | undefined> {
    while (this.#warmPool.length > 0) {
      const prepared = this.#warmPool.shift();
      if (!prepared) {
        return undefined;
      }

      const running = await dockerInspectRunning(prepared.containerId).catch(() => false);
      if (running) {
        this.#scheduleWarmPoolMaintenance();
        return prepared;
      }

      await dockerRemove(prepared.containerId).catch(() => undefined);
    }

    return undefined;
  }

  async #acquireWarmFirecrackerRuntime(
    sessionId: string,
    runtimeProfile: string,
  ): Promise<RuntimeLaunchResult> {
    const waitDeadlineMs =
      agentConfig.firecrackerWarmWaitMs > 0
        ? Date.now() + agentConfig.firecrackerWarmWaitMs
        : 0;
    let promptedWarmRefill = false;

    while (true) {
      while (this.#firecrackerWarmPoolSessionIds.length > 0) {
        const warmSessionId = this.#firecrackerWarmPoolSessionIds.shift();
        if (!warmSessionId) {
          break;
        }

        try {
          const claimed = await this.#firecracker.claimWarmSession(warmSessionId, sessionId);
          if (claimed) {
            this.#scheduleWarmPoolMaintenance();
            return claimed;
          }
        } catch (error) {
          logError("node-agent", "warm-firecracker-claim-failed", error, {
            warmSessionId,
            requestedSessionId: sessionId,
            runtimeProfile,
          });
        }
      }

      if (waitDeadlineMs <= 0 || Date.now() >= waitDeadlineMs) {
        break;
      }

      if (!promptedWarmRefill) {
        promptedWarmRefill = true;
        this.#scheduleWarmPoolMaintenance();
        log("node-agent", "warm-firecracker-waiting-for-refill", {
          requestedSessionId: sessionId,
          runtimeProfile,
          waitMs: agentConfig.firecrackerWarmWaitMs,
        });
      }

      await sleep(Math.min(100, Math.max(1, waitDeadlineMs - Date.now())));
    }

    if (!agentConfig.firecrackerWarmFallbackToCold) {
      throw new Error(
        `Warm Firecracker pool did not produce a ready session within ${agentConfig.firecrackerWarmWaitMs} ms.`,
      );
    }

    await this.#assertAdmission();
    const releaseLaunchGate = await this.#coldRestoreGate.acquire();
    try {
      return await this.#firecracker.restoreSession(sessionId, {});
    } finally {
      releaseLaunchGate();
    }
  }

  async #prepareRuntime(
    sessionIdentity: string,
    options: { kind?: "session" | "warm"; recordCrashOnFailure?: boolean } = {},
  ): Promise<PreparedRuntime> {
    const kind = options.kind ?? "session";
    if (kind === "warm") {
      this.#preparingWarmRuntimeCount += 1;
    } else {
      this.#preparingSessionRuntimeCount += 1;
    }
    const containerName = `baselayer-${sessionIdentity}`;
    let containerId = "";

    try {
      containerId = await dockerRun({
        image: agentConfig.runtimeImage,
        name: containerName,
        sessionId: sessionIdentity,
        autoRemove: !agentConfig.keepFailedRuntimes,
        memoryMb: agentConfig.sessionMemoryLimitMb,
        memoryReservationMb: agentConfig.sessionMemoryReservationMb,
        shmSizeMb: agentConfig.sessionShmLimitMb,
        network: agentConfig.sessionNetwork,
        addHostGateway: true,
        env: {
          PLAYWRIGHT_WS_PATH: runtimeConfig.wsPath,
        },
      });

      const ports = await dockerInspectPorts(containerId);
      const relayPort = this.#requiredPort(ports, runtimeConfig.port);
      const healthPort = this.#requiredPort(ports, runtimeConfig.healthPort);
      const healthUrl = `http://${agentConfig.relayProbeHost}:${healthPort}/health`;
      await waitForHttp(healthUrl, 30_000);
      const browserWsPath = await this.#resolveBrowserWsPath(containerId, relayPort);
      if (kind === "warm" && agentConfig.warmRuntimeSettleMs > 0) {
        await sleep(agentConfig.warmRuntimeSettleMs);
      }
      return {
        containerId,
        containerName,
        browserWsPath,
        relayPort,
      };
    } catch (error) {
      if (options.recordCrashOnFailure !== false) {
        this.#recordCrash();
      }
      const logs = containerId ? await dockerLogs(containerId).catch(() => []) : [];
      if (containerId && !agentConfig.keepFailedRuntimes) {
        await dockerRemove(containerId).catch(() => undefined);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        logs.length > 0
          ? `${message}\nruntime-logs:\n${logs.join("\n")}`
          : message,
      );
    } finally {
      if (kind === "warm") {
        this.#preparingWarmRuntimeCount = Math.max(0, this.#preparingWarmRuntimeCount - 1);
      } else {
        this.#preparingSessionRuntimeCount = Math.max(0, this.#preparingSessionRuntimeCount - 1);
      }
    }
  }

  #requiredPort(
    ports: Array<{ privatePort: number; publicPort: number }>,
    privatePort: number,
  ): number {
    const match = ports.find((item) => item.privatePort === privatePort);
    if (!match) {
      throw new Error(`Container did not expose private port ${privatePort}`);
    }

    return match.publicPort;
  }

  #browserWsPathFromDebuggerUrl(webSocketDebuggerUrl: string): string {
    try {
      const parsed = new URL(webSocketDebuggerUrl);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return "/devtools/browser";
    }
  }

  async #resolveBrowserWsPath(containerId: string, relayPort: number): Promise<string> {
    try {
      const version = await waitForJson<{ webSocketDebuggerUrl: string }>(
        `http://${agentConfig.relayProbeHost}:${relayPort}/json/version`,
        10_000,
      );
      return this.#browserWsPathFromDebuggerUrl(version.webSocketDebuggerUrl);
    } catch {
      const cdpLog = await waitForLogMatch(
        containerId,
        /DevTools listening on ws:\/\/127\.0\.0\.1:\d+(\/devtools\/browser\/[^\s"]+)/,
        20_000,
      );
      return cdpLog[1] ?? "/devtools/browser";
    }
  }

  #hasLaunchCapacity(): boolean {
    // Allow borrowing up to warm-ready depth above maxSessions: a warm claim consumes a
    // pre-built microVM (already counted against the real microVM cap), so it adds no new
    // capacity. This mirrors the scheduler + deriveStatus warm-borrow escapes so the
    // agent doesn't reject warm-claimable creates that the control plane admitted.
    const warmReadyForBorrow =
      agentConfig.mode === "firecracker" ? this.#firecrackerWarmPoolSessionIds.length : 0;
    return (
      this.#sessions.size + this.#launchReservationCount() <
      agentConfig.maxSessions + warmReadyForBorrow
    );
  }

  async #reserveLaunchSlot(sessionId: string): Promise<() => void> {
    const waitMs = Math.max(0, agentConfig.launchAdmissionWaitMs);
    const deadlineMs = waitMs > 0 ? Date.now() + waitMs : 0;

    while (true) {
      this.#pruneStaleLaunchReservations();
      if (this.#hasLaunchCapacity()) {
        this.#launchReservations.set(sessionId, Date.now());
        return () => {
          this.#launchReservations.delete(sessionId);
        };
      }

      if (deadlineMs <= 0 || Date.now() >= deadlineMs) {
        throw new Error("Host is at its configured session capacity.");
      }

      await sleep(Math.min(
        Math.max(25, agentConfig.launchAdmissionPollMs),
        Math.max(1, deadlineMs - Date.now()),
      ));
    }
  }

  #sessionFootprintSummary(): {
    activeRendererCount: number;
    trackedMemoryMb: number;
    trackedShmUsedMb: number;
  } {
    let activeRendererCount = 0;
    let trackedMemoryMb = 0;
    let trackedShmUsedMb = 0;

    for (const session of this.#sessions.values()) {
      trackedMemoryMb += session.lastKnownMetrics?.memoryMb ?? 0;
      trackedShmUsedMb += session.lastKnownMetrics?.shmUsedMb ?? 0;
      activeRendererCount +=
        session.runtimeKind === "microvm"
          ? 1
          : Math.max(session.lastKnownMetrics?.rendererCount ?? 0, 1);
    }

    return {
      activeRendererCount,
      trackedMemoryMb,
      trackedShmUsedMb,
    };
  }

  #coldAdmitRemaining(activeSessions: number): number {
    if (agentConfig.mode === "firecracker") {
      return Math.max(
        0,
        agentConfig.firecrackerMaxMicrovmCount
          - this.#firecracker.activeMicrovmCount
          - this.#preparingWarmRuntimeCount
          - this.#launchReservationCount(),
      );
    }

    return Math.max(
      0,
      agentConfig.maxSessions - activeSessions - this.#preparingSessionRuntimeCount,
    );
  }

  #warmPoolCapacityReports(): WarmPoolCapacityReport[] {
    return buildWarmPoolCapacityReports({
      mode: agentConfig.mode,
      warmPoolSize: agentConfig.warmPoolSize,
      supportedRuntimeProfiles: agentConfig.supportedRuntimeProfiles,
      firecrackerWarmPoolSessionCount: this.#firecrackerWarmPoolSessionIds.length,
      managedWarmPoolCount: this.#warmPool.length,
      preparingWarmRuntimeCount: this.#preparingWarmRuntimeCount,
    });
  }

  #warmPoolRuntimeProfile(): string | undefined {
    return resolveWarmPoolRuntimeProfile(agentConfig.supportedRuntimeProfiles);
  }

  #effectiveFirecrackerWarmRuntimeProfile(
    requestedRuntimeProfile: string | undefined,
    proxyProfile: string | undefined,
  ): string | undefined {
    return resolveEligibleFirecrackerWarmRuntimeProfile({
      mode: agentConfig.mode,
      warmPoolSize: agentConfig.warmPoolSize,
      supportedRuntimeProfiles: agentConfig.supportedRuntimeProfiles,
      requestedRuntimeProfile,
      proxyProfile,
      readyWarmSessionCount: this.#firecrackerWarmPoolSessionIds.length,
    });
  }

  async #assertAdmission(): Promise<void> {
    if (agentConfig.mode === "baseline") {
      return;
    }

    const metrics = await collectHostMetrics();
    const crashCount5m = this.#countCrashes(Date.now() - 5 * 60 * 1000);

    if (agentConfig.mode === "firecracker") {
      const projectedMicrovmCount =
        this.#firecracker.activeMicrovmCount +
        this.#preparingWarmRuntimeCount +
        Math.max(1, this.#launchReservationCount());
      if (projectedMicrovmCount > agentConfig.firecrackerMaxMicrovmCount) {
        throw new Error("Host microVM capacity would be exceeded by another session.");
      }

      const projectedReservedMemoryMb = projectedMicrovmCount * agentConfig.firecrackerGuestMemoryMb;
      const allocatableMemoryMb = Math.max(0, metrics.totalMemoryMb - agentConfig.minFreeMemoryMb);

      if (metrics.freeMemoryMb < agentConfig.minFreeMemoryMb) {
        throw new Error("Host does not have enough free memory headroom for another session.");
      }

      if (allocatableMemoryMb > 0 && projectedReservedMemoryMb > allocatableMemoryMb) {
        throw new Error("Host guest memory budget would be exceeded by another session.");
      }

      if (crashCount5m >= agentConfig.maxCrashCount5m) {
        throw new Error("Host recent crash rate is above the admission threshold.");
      }

      const loadAdmissionThreshold =
        this.#hostCpuCount * agentConfig.firecrackerCpuAdmissionLoadRatio;
      if (
        metrics.cpuUtilizationPct >= agentConfig.firecrackerCpuAdmissionPct &&
        metrics.loadAvg1m >= loadAdmissionThreshold
      ) {
        throw new Error("Host CPU utilization is above the Firecracker admission threshold.");
      }

      if (
        agentConfig.firecrackerMaxConcurrentActiveNavigation > 0 &&
        this.#firecracker.activeNavigationSessionCount >=
          agentConfig.firecrackerMaxConcurrentActiveNavigation
      ) {
        throw new Error("Host is at the configured concurrent active-navigation limit.");
      }

      return;
    }

    const footprint = this.#sessionFootprintSummary();
    const warmTransferCount = Math.min(this.#launchReservationCount(), this.#warmPool.length);
    const coldLaunchCount = Math.max(0, this.#launchReservationCount() - this.#warmPool.length);
    const projectedTrackedMemoryMb =
      footprint.trackedMemoryMb +
      this.#warmPool.length * agentConfig.sessionMemoryReservationMb +
      this.#preparingWarmRuntimeCount * agentConfig.sessionMemoryReservationMb +
      coldLaunchCount *
        Math.max(
          agentConfig.sessionAdmissionMemoryMb,
          agentConfig.sessionMemoryReservationMb,
        );
    const projectedShmUsedMb =
      footprint.trackedShmUsedMb +
      this.#warmPool.length * agentConfig.sessionAdmissionShmMb +
      this.#preparingWarmRuntimeCount * agentConfig.sessionAdmissionShmMb +
      coldLaunchCount * agentConfig.sessionAdmissionShmMb;
    const projectedRendererCount =
      footprint.activeRendererCount +
      this.#warmPool.length * agentConfig.warmRendererBudget +
      this.#preparingWarmRuntimeCount * agentConfig.warmRendererBudget +
      coldLaunchCount * agentConfig.sessionRendererLimit +
      warmTransferCount *
        Math.max(0, agentConfig.sessionRendererLimit - agentConfig.warmRendererBudget);
    const allocatableMemoryMb = Math.max(0, metrics.totalMemoryMb - agentConfig.minFreeMemoryMb);
    const allocatableShmMb =
      metrics.shmCapacityMb > 0
        ? Math.floor((metrics.shmCapacityMb * agentConfig.maxShmUtilizationPct) / 100)
        : 0;

    if (projectedRendererCount > agentConfig.maxRendererCount) {
      throw new Error("Host renderer capacity would be exceeded by another session.");
    }

    if (allocatableMemoryMb > 0 && projectedTrackedMemoryMb > allocatableMemoryMb) {
      throw new Error("Host tracked memory budget would be exceeded by another session.");
    }

    if (metrics.freeMemoryMb < agentConfig.minFreeMemoryMb) {
      throw new Error("Host does not have enough free memory headroom for another session.");
    }

    if (allocatableShmMb > 0 && projectedShmUsedMb > allocatableShmMb) {
      throw new Error("Host /dev/shm utilization is above the admission threshold.");
    }

    if (crashCount5m >= agentConfig.maxCrashCount5m) {
      throw new Error("Host recent crash rate is above the admission threshold.");
    }

  }

  #deriveStatus(metrics: {
    freeMemoryMb: number;
    shmCapacityMb: number;
    shmUsedMb: number;
    activeSessions: number;
    activeRendererCount: number;
    crashCount5m: number;
    cpuUtilizationPct: number;
    loadAvg1m: number;
    activeNavigationSessionCount?: number;
  }): "healthy" | "degraded" | "no-admit" | "draining" {
    // Warm-borrow consistency: a full session count or microVM count must NOT flip
    // the host to no-admit while warm-ready VMs exist. A warm claim reuses a
    // pre-built microVM and adds no restore load. Without this, the scheduler's
    // status gate rejects the host before its own warm-borrow escape can run.
    const warmReadyForBorrow =
      agentConfig.mode === "firecracker" ? this.#firecrackerWarmPoolSessionIds.length : 0;
    if (metrics.activeSessions >= agentConfig.maxSessions && warmReadyForBorrow === 0) {
      return "no-admit";
    }

    if (agentConfig.mode === "baseline") {
      return "healthy";
    }

    const shmPct =
      metrics.shmCapacityMb === 0
        ? 0
        : Math.round((metrics.shmUsedMb / metrics.shmCapacityMb) * 100);
    if (
      metrics.freeMemoryMb < agentConfig.minFreeMemoryMb ||
      metrics.activeRendererCount >= agentConfig.maxRendererCount ||
      (agentConfig.mode === "firecracker" &&
        metrics.cpuUtilizationPct >= agentConfig.firecrackerCpuAdmissionPct &&
        metrics.loadAvg1m >= this.#hostCpuCount * agentConfig.firecrackerCpuAdmissionLoadRatio) ||
      (agentConfig.mode === "firecracker" &&
        this.#firecracker.activeMicrovmCount >= agentConfig.firecrackerMaxMicrovmCount &&
        warmReadyForBorrow === 0) ||
      (agentConfig.mode === "firecracker" &&
        agentConfig.firecrackerMaxConcurrentActiveNavigation > 0 &&
        (metrics.activeNavigationSessionCount ?? 0) >=
          agentConfig.firecrackerMaxConcurrentActiveNavigation) ||
      (metrics.shmCapacityMb > 0 &&
        shmPct >= agentConfig.maxShmUtilizationPct) ||
      metrics.crashCount5m >= agentConfig.maxCrashCount5m
    ) {
      return "no-admit";
    }

    return "healthy";
  }

  #recordCrash(): void {
    this.#crashEvents.push(Date.now());
    const cutoff = Date.now() - 5 * 60 * 1000;
    while (this.#crashEvents[0] && this.#crashEvents[0] < cutoff) {
      this.#crashEvents.shift();
    }
  }

  #countCrashes(since: number): number {
    return this.#crashEvents.filter((event) => event >= since).length;
  }

  async #postSessionUpdate(
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const response = await fetch(
      `${agentConfig.controlPlaneUrl}/internal/sessions/${sessionId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Control plane rejected session update: ${response.status} ${await response.text()}`,
      );
    }
  }

  async #launchContainerSession(sessionId: string): Promise<RuntimeLaunchResult> {
    let prepared = await this.#acquireWarmRuntime();
    prepared ??= await this.#prepareRuntime(sessionId);

    return {
      sessionId,
      containerId: prepared.containerId,
      containerName: prepared.containerName,
      runtimeKind: "container",
      connectUrl: `ws://${agentConfig.publicHost}:${prepared.relayPort}${prepared.browserWsPath}`,
      cdpUrl: `ws://${agentConfig.publicHost}:${prepared.relayPort}${prepared.browserWsPath}`,
      playwrightUrl: `ws://${agentConfig.publicHost}:${prepared.relayPort}${prepared.browserWsPath}`,
      puppeteerUrl: `ws://${agentConfig.publicHost}:${prepared.relayPort}${prepared.browserWsPath}`,
      debugHttpUrl: `http://${agentConfig.publicHost}:${prepared.relayPort}/json/version`,
      startedAt: new Date().toISOString(),
    };
  }
}
