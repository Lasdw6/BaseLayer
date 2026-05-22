import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProviderHostAllowlist } from "../src/api/provider-hosts.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ProviderHostAllowlist", () => {
  it("loads entries and applies host metadata overrides", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baselayer-provider-hosts-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "provider-hosts.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        [
          {
            hostId: "use2-metal-1",
            apiUrl: "http://10.0.0.24:4000",
            region: "us-east-2",
            mode: "firecracker",
            enabled: true,
            labels: { provider: "aws" },
            supportedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
          },
        ],
        null,
        2,
      ),
    );

    const allowlist = ProviderHostAllowlist.load(configPath, false);
    const enriched = allowlist.enrichRegisteredHost({
      hostId: "use2-metal-1",
      name: "use2-metal-1",
      apiUrl: "http://127.0.0.1:4000",
      mode: "managed",
      status: "healthy",
      capacity: {
        maxSessions: 4,
        maxRendererCount: 8,
        sessionMemoryLimitMb: 512,
        sessionShmLimitMb: 128,
        sessionRendererLimit: 2,
        minFreeMemoryMb: 512,
        maxShmUtilizationPct: 90,
        maxCrashCount5m: 3,
        maxMicrovmCount: 4,
        microvmMemoryMb: 1024,
        microvmVcpuCount: 1,
        maxConcurrentActiveNavigation: 0,
      },
      metrics: {
        totalMemoryMb: 16000,
        freeMemoryMb: 12000,
        usedMemoryMb: 4000,
        memoryPressurePct: 25,
        shmCapacityMb: 1024,
        shmUsedMb: 64,
        activeSessions: 0,
        activeRendererCount: 0,
        trackedMemoryMb: 0,
        trackedShmUsedMb: 0,
        crashCount5m: 0,
        activeMicrovmCount: 0,
        reservedMicrovmMemoryMb: 0,
        avgRestoreMs: 0,
        cpuUtilizationPct: 5,
        loadAvg1m: 0.2,
        loadAvg5m: 0.1,
        highPrioritySessionCount: 0,
        activeNavigationSessionCount: 0,
        coldAdmitRemaining: 4,
        warmPools: [],
      },
      registeredAt: "2026-04-21T00:00:00.000Z",
      reportedAt: "2026-04-21T00:00:00.000Z",
    });

    expect(allowlist.enforced).toBe(true);
    expect(allowlist.isAllowed("use2-metal-1")).toBe(true);
    expect(allowlist.isAllowed("unknown-host")).toBe(false);
    expect(enriched.apiUrl).toBe("http://10.0.0.24:4000");
    expect(enriched.region).toBe("us-east-2");
    expect(enriched.mode).toBe("firecracker");
    expect(enriched.allowlisted).toBe(true);
    expect(enriched.supportedRuntimeProfiles).toEqual([
      "BaseLayer-Mew-firecracker-headless-shell",
    ]);
  });
});
