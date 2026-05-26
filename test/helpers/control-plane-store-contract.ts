import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ControlPlaneStoreBackend } from "../../src/api/store-contract.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function host() {
  return {
    hostId: "host-1",
    name: "host-1",
    apiUrl: "http://127.0.0.1:4000",
    mode: "baseline" as const,
    status: "healthy" as const,
    capacity: {
      maxSessions: 2,
      maxRendererCount: 4,
      sessionMemoryLimitMb: 512,
      sessionShmLimitMb: 128,
      sessionRendererLimit: 2,
      minFreeMemoryMb: 0,
      maxShmUtilizationPct: 100,
      maxCrashCount5m: 5,
      maxMicrovmCount: 0,
      microvmMemoryMb: 0,
      microvmVcpuCount: 0,
    },
    metrics: {
      totalMemoryMb: 4096,
      freeMemoryMb: 3072,
      usedMemoryMb: 1024,
      memoryPressurePct: 50,
      shmCapacityMb: 0,
      shmUsedMb: 0,
      activeSessions: 0,
      activeRendererCount: 0,
      trackedMemoryMb: 0,
      trackedShmUsedMb: 0,
      crashCount5m: 0,
      activeMicrovmCount: 0,
      reservedMicrovmMemoryMb: 0,
      avgRestoreMs: 0,
      cpuUtilizationPct: 0,
      loadAvg1m: 0,
      loadAvg5m: 0,
      highPrioritySessionCount: 0,
      activeNavigationSessionCount: 0,
      coldAdmitRemaining: 2,
      warmPools: [
        {
          runtimeProfile: "BaseLayer-Mew-firecracker-headless-shell",
          readyCount: 1,
          targetCount: 1,
          refillInFlight: 0,
        },
      ],
    },
    registeredAt: "2026-01-01T00:00:00.000Z",
    reportedAt: "2026-01-01T00:00:00.000Z",
  };
}

function session() {
  return {
    sessionId: "session-1",
    browser: "chromium" as const,
    status: "running" as const,
    hostId: "host-1",
    connectUrl: "ws://127.0.0.1:3001/playwright",
    cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
    playwrightUrl: "ws://127.0.0.1:3001/playwright",
    puppeteerUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
    debugHttpUrl: "http://127.0.0.1:9222/json/version",
    keepAlive: false,
    timeoutSec: 900,
    idleTimeoutSec: 120,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:15:00.000Z",
    containerId: "container-1",
    containerName: "baselayer-session-1",
    runtimeKind: "container" as const,
    runtimeProfile: "BaseLayer-Mew-firecracker-headless-shell",
    region: "us-east-2",
    provider: {
      upstreamProvider: "browser-use",
      providerSessionId: "provider-session-1",
      tenantId: "tenant-1",
      projectId: "project-1",
      workflowId: "workflow-1",
      workloadClass: "agent-soak",
    },
    sessionTags: {
      provider: "browser-use",
      tenant: "tenant-1",
    },
  };
}

export function runControlPlaneStoreContractSuite(
  name: string,
  createStore: (statePath: string) => ControlPlaneStoreBackend,
): void {
  describe(name, () => {
    it("persists hosts, sessions, events, and idempotency records", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baselayer-store-"));
      tempDirs.push(dir);
      const statePath = path.join(dir, "state.json");

      const store = createStore(statePath);
      store.upsertHost(host());
      store.upsertSession(session());
      store.appendSessionEvent({
        eventId: "event-1",
        sessionId: "session-1",
        ts: "2026-01-01T00:00:01.000Z",
        source: "control-plane",
        type: "session-created",
        status: "running",
        data: {
          hostId: "host-1",
          runtimeKind: "container",
        },
      });
      store.upsertIdempotencyRecord("partner-1:POST:/v1/sessions:key-1", {
        scopeKey: "partner-1",
        idempotencyKey: "key-1",
        method: "POST",
        route: "/v1/sessions",
        requestHash: "abc123",
        sessionId: "session-1",
        responseStatus: 201,
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const reloaded = createStore(statePath);
      expect(reloaded.getHost("host-1")?.name).toBe("host-1");
      expect(reloaded.getSession("session-1")?.runtimeProfile).toBe(
        "BaseLayer-Mew-firecracker-headless-shell",
      );
      expect(reloaded.getSessionEvents("session-1")).toHaveLength(1);
      expect(reloaded.getIdempotencyRecord("partner-1:POST:/v1/sessions:key-1")).toMatchObject({
        scopeKey: "partner-1",
        sessionId: "session-1",
        responseStatus: 201,
      });
    });

    it("supports indexed-style session queries through the store contract", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baselayer-store-"));
      tempDirs.push(dir);
      const statePath = path.join(dir, "state.json");
      const store = createStore(statePath);

      store.upsertHost(host());
      store.upsertSession(session());
      store.upsertSession({
        ...session(),
        sessionId: "session-2",
        region: "us-east-1",
        runtimeProfile: "BaseLayer-Gengar-kernel-startup-prune",
        provider: {
          ...session().provider,
          providerSessionId: "provider-session-2",
          workflowId: "workflow-2",
        },
      });

      expect(
        store.querySessions({
          providerSessionId: "provider-session-1",
        }),
      ).toHaveLength(1);
      expect(
        store.querySessions({
          runtimeProfile: "BaseLayer-Gengar-kernel-startup-prune",
          region: "us-east-1",
        }),
      ).toHaveLength(1);
      expect(store.querySessions({})).toHaveLength(2);
    });

    it("refreshes reads across store instances that share one state file", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baselayer-store-"));
      tempDirs.push(dir);
      const statePath = path.join(dir, "state.json");

      const writer = createStore(statePath);
      const reader = createStore(statePath);

      writer.upsertHost(host());

      expect(reader.getHost("host-1")?.hostId).toBe("host-1");
    });

    it("reloads before write so separate store instances do not clobber each other", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baselayer-store-"));
      tempDirs.push(dir);
      const statePath = path.join(dir, "state.json");

      const hostWriter = createStore(statePath);
      const sessionWriter = createStore(statePath);

      hostWriter.upsertHost(host());
      sessionWriter.upsertSession(session());

      const reloaded = createStore(statePath);
      expect(reloaded.getHost("host-1")?.hostId).toBe("host-1");
      expect(reloaded.getSession("session-1")?.sessionId).toBe("session-1");
    });

    it("reserves host capacity for create and exposes the effective host view", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baselayer-store-"));
      tempDirs.push(dir);
      const statePath = path.join(dir, "state.json");
      const store = createStore(statePath);

      store.upsertHost({
        ...host(),
        mode: "firecracker",
        capacity: {
          ...host().capacity,
          maxMicrovmCount: 4,
          microvmMemoryMb: 1024,
          microvmVcpuCount: 1,
        },
        metrics: {
          ...host().metrics,
          activeMicrovmCount: 1,
          reservedMicrovmMemoryMb: 1024,
        },
      });

      const reserved = store.reserveHostForCreate({
        sessionId: "11111111-1111-4111-8111-111111111111",
        runtimeProfile: "BaseLayer-Mew-firecracker-headless-shell",
        preferredRegion: "us-east-2",
        ttlMs: 30_000,
      });

      expect(reserved.host.hostId).toBe("host-1");
      expect(reserved.reservation.warmExpected).toBe(true);
      expect(store.listHostCreateReservations("host-1")).toHaveLength(1);

      const effectiveHost = store.getHost("host-1");
      expect(effectiveHost?.metrics.activeSessions).toBe(1);
      expect(effectiveHost?.metrics.activeRendererCount).toBe(1);
      expect(effectiveHost?.metrics.coldAdmitRemaining).toBe(1);
      expect(effectiveHost?.metrics.warmPools[0]?.readyCount).toBe(0);

      const secondReservation = store.reserveHostForCreate({
        sessionId: "22222222-2222-4222-8222-222222222222",
        runtimeProfile: "BaseLayer-Mew-firecracker-headless-shell",
        preferredRegion: "us-east-2",
        ttlMs: 30_000,
      });
      expect(secondReservation.reservation.warmExpected).toBe(false);
      expect(store.getHost("host-1")?.metrics.activeMicrovmCount).toBe(2);

      store.releaseHostCreateReservation(reserved.reservation.reservationId);
      store.releaseHostCreateReservation(secondReservation.reservation.reservationId);
      expect(store.listHostCreateReservations("host-1")).toHaveLength(0);
      expect(store.getHost("host-1")?.metrics.warmPools[0]?.readyCount).toBe(1);
    });

    it("marks a single-profile warm reservation as warm-expected even when the request omits runtimeProfile", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baselayer-store-"));
      tempDirs.push(dir);
      const statePath = path.join(dir, "state.json");
      const store = createStore(statePath);

      store.upsertHost({
        ...host(),
        mode: "firecracker",
        supportedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
        capacity: {
          ...host().capacity,
          maxMicrovmCount: 1,
          microvmMemoryMb: 1024,
          microvmVcpuCount: 1,
        },
        metrics: {
          ...host().metrics,
          activeMicrovmCount: 1,
          reservedMicrovmMemoryMb: 1024,
        },
      });

      const reserved = store.reserveHostForCreate({
        sessionId: "33333333-3333-4333-8333-333333333333",
        preferredRegion: "us-east-2",
        ttlMs: 30_000,
      });

      expect(reserved.host.hostId).toBe("host-1");
      expect(reserved.reservation.warmExpected).toBe(true);
      expect(reserved.reservation.runtimeProfile).toBe("BaseLayer-Mew-firecracker-headless-shell");
      expect(store.getHost("host-1")?.metrics.warmPools[0]?.readyCount).toBe(0);
    });

    it("can batch reservation release, session persistence, event append, and idempotency in one mutation", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baselayer-store-"));
      tempDirs.push(dir);
      const statePath = path.join(dir, "state.json");
      const store = createStore(statePath);

      store.upsertHost(host());
      const reserved = store.reserveHostForCreate({
        sessionId: "11111111-1111-4111-8111-111111111111",
        runtimeProfile: "BaseLayer-Mew-firecracker-headless-shell",
        preferredRegion: "us-east-2",
        ttlMs: 30_000,
      });

      const mutation = store.commitSessionMutation({
        releaseReservationId: reserved.reservation.reservationId,
        session: session(),
        event: {
          eventId: "event-1",
          sessionId: "session-1",
          ts: "2026-01-01T00:00:01.000Z",
          source: "control-plane",
          type: "session-created",
          status: "running",
        },
        idempotency: {
          storageKey: "partner-1:POST:/v1/sessions:key-1",
          record: {
            scopeKey: "partner-1",
            idempotencyKey: "key-1",
            method: "POST",
            route: "/v1/sessions",
            requestHash: "abc123",
            sessionId: "session-1",
            responseStatus: 201,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
      });

      expect(mutation.session?.sessionId).toBe("session-1");
      expect(mutation.event?.eventId).toBe("event-1");
      expect(mutation.idempotency?.sessionId).toBe("session-1");
      expect(mutation.persistMs).toBeGreaterThanOrEqual(0);
      expect(store.listHostCreateReservations("host-1")).toHaveLength(0);
      expect(store.getSession("session-1")?.sessionId).toBe("session-1");
      expect(store.getSessionEvents("session-1")).toHaveLength(1);
      expect(store.getIdempotencyRecord("partner-1:POST:/v1/sessions:key-1")?.sessionId).toBe(
        "session-1",
      );
    });

    it("does not free async-delete capacity until the host heartbeat reports teardown", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baselayer-store-"));
      tempDirs.push(dir);
      const statePath = path.join(dir, "state.json");
      const store = createStore(statePath);

      store.upsertHost({
        ...host(),
        mode: "firecracker",
        capacity: {
          ...host().capacity,
          maxSessions: 16,
          maxRendererCount: 16,
          maxMicrovmCount: 16,
          microvmMemoryMb: 1024,
          microvmVcpuCount: 1,
        },
        metrics: {
          ...host().metrics,
          activeSessions: 16,
          activeRendererCount: 16,
          activeMicrovmCount: 16,
          reservedMicrovmMemoryMb: 16 * 1024,
          coldAdmitRemaining: 0,
        },
        reportedAt: "2099-01-01T00:00:10.000Z",
      });

      store.commitSessionMutation({
        addDeleteReservation: {
          reservationId: "delete-res-1",
          sessionId: "44444444-4444-4444-8444-444444444444",
          hostId: "host-1",
          runtimeKind: "microvm",
          rendererCount: 1,
          createdAt: "2099-01-01T00:00:11.000Z",
          expiresAt: "2099-01-01T00:00:26.000Z",
        },
      });

      const effectiveBeforeHeartbeat = store.getHost("host-1");
      expect(effectiveBeforeHeartbeat?.metrics.activeSessions).toBe(16);
      expect(effectiveBeforeHeartbeat?.metrics.activeMicrovmCount).toBe(16);
      expect(effectiveBeforeHeartbeat?.metrics.coldAdmitRemaining).toBe(0);

      store.upsertHost({
        ...(effectiveBeforeHeartbeat ?? host()),
        metrics: {
          ...(effectiveBeforeHeartbeat?.metrics ?? host().metrics),
          activeSessions: 15,
          activeRendererCount: 15,
          activeMicrovmCount: 15,
          reservedMicrovmMemoryMb: 15 * 1024,
          coldAdmitRemaining: 1,
        },
        reportedAt: "2099-01-01T00:00:12.000Z",
      });

      const effectiveAfterHeartbeat = store.getHost("host-1");
      expect(effectiveAfterHeartbeat?.metrics.activeSessions).toBe(15);
      expect(effectiveAfterHeartbeat?.metrics.activeMicrovmCount).toBe(15);
      expect(effectiveAfterHeartbeat?.metrics.coldAdmitRemaining).toBe(1);
    });
  });
}
