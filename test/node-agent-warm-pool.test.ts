import { describe, expect, it } from "vitest";

import {
  canReleaseFirecrackerNetworkSlot,
  shouldRetryFirecrackerRestoreError,
} from "../src/node-agent/firecracker.js";
import {
  buildWarmPoolCapacityReports as buildAgentWarmPoolCapacityReports,
  computeLaunchReservationStaleThresholdMs,
  computeFirecrackerWarmFillTarget as computeAgentFirecrackerWarmFillTarget,
  resolveEligibleFirecrackerWarmRuntimeProfile as resolveAgentEligibleFirecrackerWarmRuntimeProfile,
  resolveWarmPoolRuntimeProfile as resolveAgentWarmPoolRuntimeProfile,
  shouldDeferWarmPoolMaintenance as shouldAgentDeferWarmPoolMaintenance,
} from "../src/node-agent/agent.js";

describe("node-agent warm pool helpers", () => {
  it("only exposes a warm pool runtime profile when exactly one profile is configured", () => {
    expect(resolveAgentWarmPoolRuntimeProfile([])).toBeUndefined();
    expect(
      resolveAgentWarmPoolRuntimeProfile([
        "BaseLayer-Mew-firecracker-headless-shell",
        "BaseLayer-Gengar-kernel-startup-prune",
      ]),
    ).toBeUndefined();
    expect(
      resolveAgentWarmPoolRuntimeProfile(["BaseLayer-Mew-firecracker-headless-shell"]),
    ).toBe("BaseLayer-Mew-firecracker-headless-shell");
  });

  it("only allows Firecracker warm borrowing when the request matches the single warm profile", () => {
    const base = {
      mode: "firecracker" as const,
      warmPoolSize: 4,
      supportedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
      proxyProfile: undefined,
      readyWarmSessionCount: 1,
    };

    expect(
      resolveAgentEligibleFirecrackerWarmRuntimeProfile({
        ...base,
        requestedRuntimeProfile: undefined,
      }),
    ).toBe("BaseLayer-Mew-firecracker-headless-shell");
    expect(
      resolveAgentEligibleFirecrackerWarmRuntimeProfile({
        ...base,
        requestedRuntimeProfile: "BaseLayer-Mew-firecracker-headless-shell",
      }),
    ).toBe("BaseLayer-Mew-firecracker-headless-shell");
    expect(
      resolveAgentEligibleFirecrackerWarmRuntimeProfile({
        ...base,
        requestedRuntimeProfile: "BaseLayer-Gengar-kernel-startup-prune",
      }),
    ).toBeUndefined();
    expect(
      resolveAgentEligibleFirecrackerWarmRuntimeProfile({
        ...base,
        requestedRuntimeProfile: undefined,
        proxyProfile: "residential-us",
      }),
    ).toBeUndefined();
    expect(
      resolveAgentEligibleFirecrackerWarmRuntimeProfile({
        ...base,
        requestedRuntimeProfile: undefined,
        readyWarmSessionCount: 0,
      }),
    ).toBeUndefined();
  });

  it("caps Firecracker warm fill by missing slots, remaining capacity, and fill concurrency", () => {
    expect(
      computeAgentFirecrackerWarmFillTarget({
        warmPoolSize: 4,
        warmPoolFillConcurrency: 3,
        maxMicrovmCount: 8,
        activeMicrovmCount: 2,
        preparingWarmRuntimeCount: 0,
        readyWarmSessionCount: 1,
      }),
    ).toBe(3);

    expect(
      computeAgentFirecrackerWarmFillTarget({
        warmPoolSize: 4,
        warmPoolFillConcurrency: 5,
        maxMicrovmCount: 3,
        activeMicrovmCount: 2,
        preparingWarmRuntimeCount: 0,
        readyWarmSessionCount: 1,
      }),
    ).toBe(1);

    expect(
      computeAgentFirecrackerWarmFillTarget({
        warmPoolSize: 4,
        warmPoolFillConcurrency: 2,
        maxMicrovmCount: 8,
        activeMicrovmCount: 2,
        preparingWarmRuntimeCount: 1,
        readyWarmSessionCount: 3,
      }),
    ).toBe(0);
  });

  it("requests refill again after a warm borrow drains the pool but host capacity remains", () => {
    expect(
      computeAgentFirecrackerWarmFillTarget({
        warmPoolSize: 1,
        warmPoolFillConcurrency: 1,
        maxMicrovmCount: 4,
        activeMicrovmCount: 1,
        preparingWarmRuntimeCount: 0,
        readyWarmSessionCount: 0,
      }),
    ).toBe(1);
  });

  it("only defers automatic warm-pool maintenance for the managed runtime", () => {
    expect(
      shouldAgentDeferWarmPoolMaintenance({
        mode: "managed",
        activeSessionCount: 1,
        launchReservationCount: 0,
        preparingSessionRuntimeCount: 0,
      }),
    ).toBe(true);

    expect(
      shouldAgentDeferWarmPoolMaintenance({
        mode: "firecracker",
        activeSessionCount: 1,
        launchReservationCount: 0,
        preparingSessionRuntimeCount: 0,
      }),
    ).toBe(false);

    expect(
      shouldAgentDeferWarmPoolMaintenance({
        mode: "firecracker",
        activeSessionCount: 0,
        launchReservationCount: 1,
        preparingSessionRuntimeCount: 0,
      }),
    ).toBe(false);
  });

  it("reports warm pool capacity only for a single configured profile", () => {
    expect(
      buildAgentWarmPoolCapacityReports({
        mode: "firecracker",
        warmPoolSize: 0,
        supportedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
        firecrackerWarmPoolSessionCount: 2,
        managedWarmPoolCount: 0,
        preparingWarmRuntimeCount: 1,
      }),
    ).toEqual([]);

    expect(
      buildAgentWarmPoolCapacityReports({
        mode: "firecracker",
        warmPoolSize: 4,
        supportedRuntimeProfiles: [
          "BaseLayer-Mew-firecracker-headless-shell",
          "BaseLayer-Gengar-kernel-startup-prune",
        ],
        firecrackerWarmPoolSessionCount: 2,
        managedWarmPoolCount: 0,
        preparingWarmRuntimeCount: 1,
      }),
    ).toEqual([]);

    expect(
      buildAgentWarmPoolCapacityReports({
        mode: "firecracker",
        warmPoolSize: 4,
        supportedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
        firecrackerWarmPoolSessionCount: 2,
        managedWarmPoolCount: 0,
        preparingWarmRuntimeCount: 1,
      }),
    ).toEqual([
      {
        runtimeProfile: "BaseLayer-Mew-firecracker-headless-shell",
        readyCount: 2,
        targetCount: 4,
        refillInFlight: 1,
      },
    ]);

    expect(
      buildAgentWarmPoolCapacityReports({
        mode: "managed",
        warmPoolSize: 3,
        supportedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
        firecrackerWarmPoolSessionCount: 0,
        managedWarmPoolCount: 1,
        preparingWarmRuntimeCount: 2,
      }),
    ).toEqual([
      {
        runtimeProfile: "BaseLayer-Mew-firecracker-headless-shell",
        readyCount: 1,
        targetCount: 3,
        refillInFlight: 2,
      },
    ]);
  });

  it("reports empty-but-refilling warm state instead of pretending readiness", () => {
    expect(
      buildAgentWarmPoolCapacityReports({
        mode: "firecracker",
        warmPoolSize: 2,
        supportedRuntimeProfiles: ["BaseLayer-Mew-firecracker-headless-shell"],
        firecrackerWarmPoolSessionCount: 0,
        managedWarmPoolCount: 0,
        preparingWarmRuntimeCount: 1,
      }),
    ).toEqual([
      {
        runtimeProfile: "BaseLayer-Mew-firecracker-headless-shell",
        readyCount: 0,
        targetCount: 2,
        refillInFlight: 1,
      },
    ]);
  });

  it("never releases unhealthy or rebuilding Firecracker slots back to the free pool", () => {
    expect(canReleaseFirecrackerNetworkSlot("reserved")).toBe(true);
    expect(canReleaseFirecrackerNetworkSlot("free")).toBe(false);
    expect(canReleaseFirecrackerNetworkSlot("unhealthy")).toBe(false);
    expect(canReleaseFirecrackerNetworkSlot("rebuilding")).toBe(false);
    expect(canReleaseFirecrackerNetworkSlot(undefined)).toBe(false);
  });

  it("keeps stale launch reservations alive past the control-plane create timeout", () => {
    expect(computeLaunchReservationStaleThresholdMs(30_000, 45_000)).toBe(46_000);
    expect(computeLaunchReservationStaleThresholdMs(60_000, 45_000)).toBe(65_000);
  });

  it("only retries restore failures that look like transient local CDP readiness misses", () => {
    expect(
      shouldRetryFirecrackerRestoreError(
        new Error("Timed out waiting for http://127.0.0.1:30123/json/version: fetch failed"),
      ),
    ).toBe(true);
    expect(
      shouldRetryFirecrackerRestoreError(
        new Error("Timed out waiting for http://127.0.0.1:30123/json/list"),
      ),
    ).toBe(true);
    expect(
      shouldRetryFirecrackerRestoreError(
        new Error("Timed out waiting for websocket upgrade on 127.0.0.1 relay"),
      ),
    ).toBe(true);
    expect(
      shouldRetryFirecrackerRestoreError(
        new Error("Firecracker snapshot 'foo' is missing. Expected rootfs /x/rootfs.ext4."),
      ),
    ).toBe(false);
    expect(
      shouldRetryFirecrackerRestoreError(new Error("No prepared Firecracker network slots are available.")),
    ).toBe(false);
  });
});
