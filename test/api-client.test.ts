import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRemoteSession,
  RemoteSessionCreateError,
  resolveRemoteCreateTimeoutMs,
} from "../src/api/client.js";
import type { HostRecord } from "../src/shared/types.js";

function buildHost(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    hostId: "host-1",
    name: "host-1",
    apiUrl: "http://127.0.0.1:4000",
    mode: "firecracker",
    status: "healthy",
    supportedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
    capacity: {
      maxSessions: 4,
      maxRendererCount: 4,
      sessionMemoryLimitMb: 1024,
      sessionShmLimitMb: 128,
      sessionRendererLimit: 1,
      minFreeMemoryMb: 512,
      maxShmUtilizationPct: 90,
      maxCrashCount5m: 3,
      maxMicrovmCount: 4,
      microvmMemoryMb: 1024,
      microvmVcpuCount: 1,
      maxConcurrentActiveNavigation: 0,
    },
    metrics: {
      totalMemoryMb: 8192,
      freeMemoryMb: 4096,
      usedMemoryMb: 4096,
      memoryPressurePct: 50,
      shmCapacityMb: 1024,
      shmUsedMb: 128,
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
      coldAdmitRemaining: 4,
      warmPools: [],
    },
    registeredAt: "2026-01-01T00:00:00.000Z",
    reportedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createRemoteSession", () => {
  it("aligns firecracker create timeout with restore-retry budget", () => {
    const timeoutMs = resolveRemoteCreateTimeoutMs(buildHost(), 45_000);
    expect(timeoutMs).toBeGreaterThanOrEqual(90_000);
  });

  it("does not inflate managed-mode create timeout", () => {
    const timeoutMs = resolveRemoteCreateTimeoutMs(buildHost({ mode: "managed" }), 45_000);
    expect(timeoutMs).toBe(45_000);
  });

  it("applies an explicit timeout signal to node-agent create", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(
        JSON.stringify({
          sessionId: "session-1",
          containerId: "vm-1",
          containerName: "vm-1",
          runtimeKind: "microvm",
          connectUrl: "ws://127.0.0.1:4000/devtools/browser/abc",
          cdpUrl: "ws://127.0.0.1:4000/devtools/browser/abc",
          playwrightUrl: "ws://127.0.0.1:4000/devtools/browser/abc",
          puppeteerUrl: "ws://127.0.0.1:4000/devtools/browser/abc",
          debugHttpUrl: "http://127.0.0.1:4000/json/version",
          startedAt: "2026-01-01T00:00:00.000Z",
          launchTimings: { totalMs: 0 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createRemoteSession(
      buildHost(),
      {
        browser: "chromium",
        keepAlive: false,
        timeoutSec: 300,
        idleTimeoutSec: 60,
        runtimeProfile: "BaseLayer-Mew-firecracker-headless-shell",
        sessionId: "session-1",
      },
      { timeoutMs: 25 },
    );

    expect(result.runtimeKind).toBe("microvm");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("raises a typed timeout error when node-agent create exceeds the configured bound", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    );

    await expect(
      createRemoteSession(
        buildHost(),
        {
          browser: "chromium",
          keepAlive: false,
          timeoutSec: 300,
          idleTimeoutSec: 60,
          sessionId: "session-timeout",
        },
        { timeoutMs: 5, retries: 0 },
      ),
    ).rejects.toMatchObject<Partial<RemoteSessionCreateError>>({
      name: "RemoteSessionCreateError",
      kind: "timeout",
      hostId: "host-1",
      sessionId: "session-timeout",
    });
  });

  it("raises a typed response error when the node-agent rejects create", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 503 })),
    );

    await expect(
      createRemoteSession(
        buildHost(),
        {
          browser: "chromium",
          keepAlive: false,
          timeoutSec: 300,
          idleTimeoutSec: 60,
          sessionId: "session-bad-response",
        },
        { retries: 0 },
      ),
    ).rejects.toMatchObject<Partial<RemoteSessionCreateError>>({
      name: "RemoteSessionCreateError",
      kind: "response",
      hostId: "host-1",
      sessionId: "session-bad-response",
    });
  });
});
