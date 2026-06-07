import { type HostRecord } from "../shared/types.js";

export class SchedulerError extends Error {}

interface HostSelectionOptions {
  preferredRegion?: string;
  runtimeProfile?: string;
}

function effectiveWarmRuntimeProfile(host: HostRecord, runtimeProfile?: string): string | undefined {
  if (runtimeProfile) {
    return runtimeProfile;
  }

  if (host.supportedRuntimeProfiles?.length === 1) {
    return host.supportedRuntimeProfiles[0];
  }

  if (host.metrics.warmPools.length === 1) {
    return host.metrics.warmPools[0]?.runtimeProfile;
  }

  return undefined;
}

function matchingWarmReadyCount(host: HostRecord, runtimeProfile?: string): number {
  const effectiveRuntimeProfile = effectiveWarmRuntimeProfile(host, runtimeProfile);
  if (!effectiveRuntimeProfile) {
    return 0;
  }

  const warmPool = host.metrics.warmPools.find(
    (pool) => pool.runtimeProfile === effectiveRuntimeProfile,
  );
  return warmPool?.readyCount ?? 0;
}

function scoreHost(host: HostRecord, options: HostSelectionOptions = {}): number {
  const capacityHeadroom = host.capacity.maxSessions - host.metrics.activeSessions;
  const memoryHeadroom = host.metrics.freeMemoryMb;
  const shmHeadroom = host.metrics.shmCapacityMb - host.metrics.shmUsedMb;
  const microvmHeadroom =
    host.mode === "firecracker"
      ? host.capacity.maxMicrovmCount - host.metrics.activeMicrovmCount
      : 0;
  const maxNav = host.capacity.maxConcurrentActiveNavigation ?? 0;
  const activeNav = host.metrics.activeNavigationSessionCount ?? 0;
  let navigationHeadroom = 1000;
  if (host.mode === "firecracker" && maxNav > 0) {
    navigationHeadroom = Math.max(0, maxNav - activeNav);
  }
  const warmReadyCount = matchingWarmReadyCount(host, options.runtimeProfile);

  return (
    warmReadyCount * 1_000_000 +
    capacityHeadroom * 10000 +
    microvmHeadroom * 5000 +
    navigationHeadroom * 8000 +
    memoryHeadroom * 10 +
    shmHeadroom
  );
}

export function chooseHost(hosts: HostRecord[], options: HostSelectionOptions = {}): HostRecord {
  const eligible = hosts.filter((host) => {
    const warmReadyCount = matchingWarmReadyCount(host, options.runtimeProfile);
    const canBorrowWarm = warmReadyCount > 0;

    if (host.enabled === false) {
      return false;
    }

    if (host.status !== "healthy" && host.status !== "degraded") {
      return false;
    }

    if (
      options.runtimeProfile &&
      host.supportedRuntimeProfiles &&
      host.supportedRuntimeProfiles.length > 0 &&
      !host.supportedRuntimeProfiles.includes(options.runtimeProfile)
    ) {
      return false;
    }

    // Mirror the microVM-cap escape below (line ~118): a warm-borrow claims a
    // pre-built runtime and adds no new restore load, so a full session count must
    // not reject admission when the host still has warm-ready capacity. Without this
    // escape, concurrent c10 create reservations stack activeSessions to maxSessions
    // mid-wave and the scheduler 503s ("No host eligible") even though warm VMs exist.
    if (host.metrics.activeSessions >= host.capacity.maxSessions && !canBorrowWarm) {
      return false;
    }

    if (host.metrics.activeRendererCount >= host.capacity.maxRendererCount) {
      return false;
    }

    if (host.mode === "baseline") {
      return true;
    }

    if (host.metrics.freeMemoryMb < host.capacity.minFreeMemoryMb) {
      return false;
    }

    const shmPct =
      host.metrics.shmCapacityMb === 0
        ? 0
        : Math.round((host.metrics.shmUsedMb / host.metrics.shmCapacityMb) * 100);
    if (
      host.metrics.shmCapacityMb > 0 &&
      shmPct >= host.capacity.maxShmUtilizationPct
    ) {
      return false;
    }

    if (host.metrics.crashCount5m >= host.capacity.maxCrashCount5m) {
      return false;
    }

    if (host.mode === "firecracker") {
      if (host.metrics.activeMicrovmCount >= host.capacity.maxMicrovmCount && !canBorrowWarm) {
        return false;
      }

      const maxNav = host.capacity.maxConcurrentActiveNavigation ?? 0;
      if (
        maxNav > 0 &&
        (host.metrics.activeNavigationSessionCount ?? 0) >= maxNav
      ) {
        return false;
      }

      const allocatableMemoryMb = Math.max(0, host.metrics.totalMemoryMb - host.capacity.minFreeMemoryMb);
      const projectedReservedMicrovmMemoryMb =
        host.metrics.reservedMicrovmMemoryMb + (canBorrowWarm ? 0 : host.capacity.microvmMemoryMb);
      if (allocatableMemoryMb > 0 && projectedReservedMicrovmMemoryMb > allocatableMemoryMb) {
        return false;
      }
    }

    return true;
  });

  if (eligible.length === 0) {
    throw new SchedulerError("No host is currently eligible for session admission.");
  }

  const sameRegionEligible =
    options.preferredRegion &&
    eligible.some((host) => host.region === options.preferredRegion)
      ? eligible.filter((host) => host.region === options.preferredRegion)
      : eligible;

  return sameRegionEligible.sort(
    (left, right) => scoreHost(right, options) - scoreHost(left, options),
  )[0];
}
