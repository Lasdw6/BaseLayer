import { describe, expect, it } from "vitest";

import { chooseHost } from "../src/api/scheduler.js";
import { type HostRecord } from "../src/shared/types.js";

function host(overrides: Partial<HostRecord>): HostRecord {
  return {
    hostId: "host-a",
    name: "host-a",
    apiUrl: "http://127.0.0.1:4000",
    mode: "managed",
    status: "healthy",
    capacity: {
      maxSessions: 4,
      maxRendererCount: 8,
      sessionMemoryLimitMb: 512,
      sessionShmLimitMb: 128,
      sessionRendererLimit: 2,
      minFreeMemoryMb: 1024,
      maxShmUtilizationPct: 90,
      maxCrashCount5m: 3,
      maxMicrovmCount: 0,
      microvmMemoryMb: 0,
      microvmVcpuCount: 0,
    },
    metrics: {
      totalMemoryMb: 16000,
      freeMemoryMb: 8000,
      usedMemoryMb: 8000,
      memoryPressurePct: 50,
      shmCapacityMb: 1024,
      shmUsedMb: 128,
      activeSessions: 1,
      activeRendererCount: 1,
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
      coldAdmitRemaining: 3,
      warmPools: [],
    },
    registeredAt: "2026-01-01T00:00:00.000Z",
    reportedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("chooseHost", () => {
  it("selects the healthiest managed host with the most headroom", () => {
    const selected = chooseHost([
      host({ hostId: "host-a", metrics: { ...host({}).metrics, freeMemoryMb: 2048 } }),
      host({ hostId: "host-b", apiUrl: "http://127.0.0.1:4001", metrics: { ...host({}).metrics, freeMemoryMb: 8192 } }),
    ]);

    expect(selected.hostId).toBe("host-b");
  });

  it("rejects a managed host below admission thresholds", () => {
    expect(() =>
      chooseHost([
        host({
          metrics: {
            ...host({}).metrics,
            freeMemoryMb: 256,
          },
        }),
      ]),
    ).toThrow(/eligible/);
  });

  it("allows baseline hosts to admit purely by capacity", () => {
    const selected = chooseHost([
      host({
        hostId: "baseline-host",
        mode: "baseline",
        metrics: {
          ...host({}).metrics,
          freeMemoryMb: 32,
          shmCapacityMb: 0,
          shmUsedMb: 0,
        },
      }),
    ]);

    expect(selected.hostId).toBe("baseline-host");
  });

  it("rejects firecracker hosts that are already at microVM capacity", () => {
    expect(() =>
      chooseHost([
        host({
          mode: "firecracker",
          capacity: {
            ...host({}).capacity,
            maxMicrovmCount: 2,
            microvmMemoryMb: 1024,
          },
          metrics: {
            ...host({}).metrics,
            activeMicrovmCount: 2,
            reservedMicrovmMemoryMb: 2048,
          },
        }),
      ]),
    ).toThrow(/eligible/);
  });

  it("allows a firecracker host at microVM capacity when matching warm workers are ready", () => {
    const selected = chooseHost(
      [
        host({
          hostId: "warm-capped-host",
          mode: "firecracker",
          supportedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
          capacity: {
            ...host({}).capacity,
            maxMicrovmCount: 2,
            microvmMemoryMb: 1024,
          },
          metrics: {
            ...host({}).metrics,
            activeMicrovmCount: 2,
            reservedMicrovmMemoryMb: 2048,
            warmPools: [
              {
                runtimeProfile: "BaseLayer-Mew-firecracker-headless-shell",
                readyCount: 1,
                targetCount: 2,
                refillInFlight: 0,
              },
            ],
          },
        }),
      ],
      { runtimeProfile: "BaseLayer-Mew-firecracker-headless-shell" },
    );

    expect(selected.hostId).toBe("warm-capped-host");
  });

  it("rejects firecracker hosts whose reserved guest memory is already full", () => {
    expect(() =>
      chooseHost([
        host({
          mode: "firecracker",
          capacity: {
            ...host({}).capacity,
            minFreeMemoryMb: 1024,
            maxMicrovmCount: 8,
            microvmMemoryMb: 2048,
          },
          metrics: {
            ...host({}).metrics,
            totalMemoryMb: 4096,
            freeMemoryMb: 2500,
            usedMemoryMb: 1596,
            reservedMicrovmMemoryMb: 2048,
            activeMicrovmCount: 1,
          },
        }),
      ]),
    ).toThrow(/eligible/);
  });

  it("prefers hosts in the requested region when eligible", () => {
    const selected = chooseHost(
      [
        host({
          hostId: "host-use1",
          region: "us-east-1",
          apiUrl: "http://127.0.0.1:4001",
          metrics: { ...host({}).metrics, freeMemoryMb: 12000 },
        }),
        host({
          hostId: "host-use2",
          region: "us-east-2",
          apiUrl: "http://127.0.0.1:4002",
          metrics: { ...host({}).metrics, freeMemoryMb: 7000 },
        }),
      ],
      { preferredRegion: "us-east-2" },
    );

    expect(selected.hostId).toBe("host-use2");
  });

  it("filters hosts by supported runtime profile when requested", () => {
    const selected = chooseHost(
      [
        host({
          hostId: "host-a",
          supportedRuntimeProfiles: ["BaseLayer-Gengar-kernel-startup-prune"],
        }),
        host({
          hostId: "host-b",
          apiUrl: "http://127.0.0.1:4001",
          supportedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
        }),
      ],
      { runtimeProfile: "BaseLayer-Mew-firecracker-headless-shell" },
    );

    expect(selected.hostId).toBe("host-b");
  });

  it("prefers warm-ready hosts for the requested runtime profile", () => {
    const selected = chooseHost(
      [
        host({
          hostId: "cold-host",
          supportedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
          metrics: {
            ...host({}).metrics,
            freeMemoryMb: 12000,
            warmPools: [],
          },
        }),
        host({
          hostId: "warm-host",
          apiUrl: "http://127.0.0.1:4001",
          supportedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
          metrics: {
            ...host({}).metrics,
            freeMemoryMb: 7000,
            warmPools: [
              {
                runtimeProfile: "BaseLayer-Mew-firecracker-headless-shell",
                readyCount: 2,
                targetCount: 4,
                refillInFlight: 0,
              },
            ],
          },
        }),
      ],
      { runtimeProfile: "BaseLayer-Mew-firecracker-headless-shell" },
    );

    expect(selected.hostId).toBe("warm-host");
  });

  it("treats a single-profile warm pool as eligible even when the request omits runtimeProfile", () => {
    const selected = chooseHost([
      host({
        hostId: "cold-host",
        supportedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
        metrics: {
          ...host({}).metrics,
          freeMemoryMb: 12000,
          warmPools: [],
        },
      }),
      host({
        hostId: "warm-host",
        apiUrl: "http://127.0.0.1:4001",
        supportedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
        mode: "firecracker",
        capacity: {
          ...host({}).capacity,
          maxMicrovmCount: 2,
          microvmMemoryMb: 1024,
        },
        metrics: {
          ...host({}).metrics,
          activeMicrovmCount: 2,
          reservedMicrovmMemoryMb: 2048,
          freeMemoryMb: 7000,
          warmPools: [
            {
              runtimeProfile: "BaseLayer-Mew-firecracker-headless-shell",
              readyCount: 1,
              targetCount: 2,
              refillInFlight: 0,
            },
          ],
        },
      }),
    ]);

    expect(selected.hostId).toBe("warm-host");
  });
});
