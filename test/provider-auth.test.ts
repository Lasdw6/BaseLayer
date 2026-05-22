import { describe, expect, it } from "vitest";

import {
  applyPartnerScopeToCreateRequest,
  canPartnerAccessSession,
  filterHostsForPartner,
  filterSessionsForPartner,
  ProviderApiKeyStore,
} from "../src/api/provider-auth.js";
import type { SessionRecord } from "../src/shared/types.js";

function buildSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: overrides.sessionId ?? "session-1",
    browser: "chromium",
    status: "running",
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
    containerName: "container-1",
    runtimeKind: "container",
    provider: {
      upstreamProvider: "browser-use",
      providerSessionId: "bu-session-1",
      tenantId: "tenant-a",
      projectId: "project-a",
      workflowId: "workflow-a",
      workloadClass: "agent-soak",
      ...(overrides.provider ?? {}),
    },
    ...(overrides ?? {}),
  };
}

describe("provider auth helpers", () => {
  it("authenticates bearer and explicit API key headers", () => {
    const store = new ProviderApiKeyStore(
      [
        {
          keyId: "partner-1",
          apiKey: "secret-1",
          enabled: true,
          tenantId: "tenant-a",
          upstreamProvider: "browser-use",
        },
      ],
      true,
    );

    expect(
      store.authenticate({
        authorization: "Bearer secret-1",
      }),
    ).toMatchObject({
      keyId: "partner-1",
      tenantId: "tenant-a",
      upstreamProvider: "browser-use",
    });

    expect(
      store.authenticate({
        "x-baselayer-api-key": "secret-1",
      }),
    ).toMatchObject({
      keyId: "partner-1",
    });
  });

  it("injects tenant and provider scope into partner session creates", () => {
    const scoped = applyPartnerScopeToCreateRequest(
      {
        browser: "chromium",
        keepAlive: false,
        timeoutSec: 300,
        idleTimeoutSec: 60,
        runtimeProfile: "BaseLayer-Mew-firecracker-headless-shell",
        provider: {
          providerSessionId: "bu-1",
          workflowId: "wf-1",
        },
      },
      {
        keyId: "partner-1",
        tenantId: "tenant-a",
        upstreamProvider: "browser-use",
        allowedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
      },
    );

    expect(scoped.provider).toMatchObject({
      providerSessionId: "bu-1",
      workflowId: "wf-1",
      tenantId: "tenant-a",
      upstreamProvider: "browser-use",
    });
  });

  it("filters sessions by partner scope and search keys", () => {
    const sessions = [
      buildSession(),
      buildSession({
        sessionId: "session-2",
        provider: {
          upstreamProvider: "browser-use",
          providerSessionId: "bu-session-2",
          tenantId: "tenant-a",
          projectId: "project-b",
          workflowId: "workflow-b",
          workloadClass: "agent-soak",
        },
      }),
      buildSession({
        sessionId: "session-3",
        provider: {
          upstreamProvider: "other-provider",
          providerSessionId: "other-session",
          tenantId: "tenant-b",
          projectId: "project-z",
          workflowId: "workflow-z",
          workloadClass: "agent-soak",
        },
      }),
    ];

    const visible = filterSessionsForPartner(
      sessions,
      {
        tenantId: "tenant-a",
        workflowId: "workflow-b",
      },
      {
        keyId: "partner-1",
        tenantId: "tenant-a",
        upstreamProvider: "browser-use",
      },
    );

    expect(visible.map((session) => session.sessionId)).toEqual(["session-2"]);
    expect(canPartnerAccessSession(sessions[0]!, { keyId: "k", tenantId: "tenant-a" })).toBe(true);
    expect(canPartnerAccessSession(sessions[2]!, { keyId: "k", tenantId: "tenant-a" })).toBe(false);
  });

  it("filters hosts by allowed region and runtime profile", () => {
    const hosts = [
      {
        hostId: "host-1",
        name: "host-1",
        apiUrl: "http://127.0.0.1:4000",
        mode: "firecracker" as const,
        region: "us-east-2",
        status: "healthy" as const,
        supportedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
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
          maxConcurrentActiveNavigation: 0,
        },
        metrics: {
          totalMemoryMb: 1000,
          freeMemoryMb: 500,
          usedMemoryMb: 500,
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
          warmPools: [],
        },
        registeredAt: "2026-01-01T00:00:00.000Z",
        reportedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        hostId: "host-2",
        name: "host-2",
        apiUrl: "http://127.0.0.1:5000",
        mode: "firecracker" as const,
        region: "us-west-2",
        status: "healthy" as const,
        supportedRuntimeProfiles: ["BaseLayer-Gengar-kernel-startup-prune"],
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
          maxConcurrentActiveNavigation: 0,
        },
        metrics: {
          totalMemoryMb: 1000,
          freeMemoryMb: 500,
          usedMemoryMb: 500,
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
          warmPools: [],
        },
        registeredAt: "2026-01-01T00:00:00.000Z",
        reportedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        hostId: "host-3",
        name: "host-3",
        apiUrl: "http://127.0.0.1:6000",
        mode: "firecracker" as const,
        status: "healthy" as const,
        supportedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
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
          maxConcurrentActiveNavigation: 0,
        },
        metrics: {
          totalMemoryMb: 1000,
          freeMemoryMb: 500,
          usedMemoryMb: 500,
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
          warmPools: [],
        },
        registeredAt: "2026-01-01T00:00:00.000Z",
        reportedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const filtered = filterHostsForPartner(hosts, {
      keyId: "partner-1",
      allowedRegions: ["us-east-2"],
      allowedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
    });

    expect(filtered.map((host) => host.hostId)).toEqual(["host-1"]);
  });
});
