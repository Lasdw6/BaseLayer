import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const DEFAULT_BROWSERARENA_PATHS = [
  "data/benchmarks/aws-baremetal-m5zn-2026-04-11/browserarena-results.jsonl",
  "data/browserarena/baselayer-seq-2026-04-09/results.jsonl",
];

const DEFAULT_DENSITY_PATHS = [
  "data/benchmarks/gcp-n2s8/density-profile-a-generic-container-c50.json",
  "data/benchmarks/gcp-n2s8/density-profile-b-optimized-node-c50.json",
  "data/benchmarks/gcp-n2s8-phase3/density-profile-c-firecracker-snapshot-c24.json",
];

const SOTA_TARGETS = {
  sequential: {
    reliabilityPct: 99.9,
    p50TotalMs: 1_000,
    p95TotalMs: 1_500,
    p95ReleaseMs: 100,
  },
  concurrent16: {
    reliabilityPct: 99.9,
    p50TotalMs: 1_100,
    p95TotalMs: 1_800,
  },
  providerEconomics: {
    minCostReductionPct: 30,
    strongCostReductionPct: 50,
    minStableConcurrencyImprovementPct: 30,
  },
};

type BrowserArenaRecord = {
  session_creation_ms: number | null;
  session_connect_ms: number | null;
  page_goto_ms: number | null;
  session_release_ms: number | null;
  success: boolean;
  error_stage?: string | null;
  concurrency?: number;
};

type DensityArtifact = {
  benchmark: string;
  profileId: string;
  profileLabel: string;
  requestedConcurrency: number;
  soakSeconds: number;
  createOutcomes: Array<
    | {
        ok: true;
        createMs: number;
      }
    | {
        ok: false;
        error?: string;
      }
  >;
  navigationOutcomes: Array<
    | {
        ok: true;
        createMs?: number;
        navigateMs: number;
        sessionConnectMs?: number;
        pageGotoMs?: number;
        benchReadyWaitMs?: number;
        soakActionSuccesses: number;
        soakActionFailures: number;
      }
    | {
        ok: false;
        error?: string;
      }
  >;
  pressureSamples?: Array<{
    host?: {
      metrics?: {
        trackedMemoryMb?: number;
        trackedShmUsedMb?: number;
        cpuUtilizationPct?: number;
        memoryPressurePct?: number;
        activeRendererCount?: number;
      };
    };
  }>;
};

type Stats = {
  avg: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  min: number | null;
  max: number | null;
};

function envNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function csvEnv(name: string, defaults: string[]): string[] {
  const raw = process.env[name]?.trim();
  const values = raw
    ? raw.split(",").map((value) => value.trim()).filter(Boolean)
    : defaults;
  return values.map((value) => path.resolve(root, value));
}

function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function stats(values: number[]): Stats {
  const xs = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (xs.length === 0) {
    return { avg: null, p50: null, p95: null, p99: null, min: null, max: null };
  }
  const percentile = (p: number): number => {
    const index = Math.max(0, Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1));
    return xs[index]!;
  };
  const mid = Math.floor(xs.length / 2);
  const p50 = xs.length % 2 === 1 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
  return {
    avg: round(xs.reduce((sum, value) => sum + value, 0) / xs.length),
    p50: round(p50),
    p95: round(percentile(95)),
    p99: round(percentile(99)),
    min: round(xs[0]!),
    max: round(xs[xs.length - 1]!),
  };
}

function readJsonl(filePath: string): BrowserArenaRecord[] {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BrowserArenaRecord);
}

function stageTotal(record: BrowserArenaRecord): number | undefined {
  const fields = [
    record.session_creation_ms,
    record.session_connect_ms,
    record.page_goto_ms,
    record.session_release_ms,
  ];
  if (fields.some((value) => typeof value !== "number")) {
    return undefined;
  }
  return (
    (record.session_creation_ms ?? 0) +
    (record.session_connect_ms ?? 0) +
    (record.page_goto_ms ?? 0) +
    (record.session_release_ms ?? 0)
  );
}

function pass(value: number | null, max: number): boolean | null {
  return value === null ? null : value <= max;
}

function passMin(value: number | null, min: number): boolean | null {
  return value === null ? null : value >= min;
}

function summarizeBrowserArena(filePath: string, options: {
  hostHourlyUsd?: number;
  hostUtilization?: number;
  hostConcurrency?: number;
}): Record<string, unknown> {
  const records = readJsonl(filePath);
  const successful = records.filter((record) => record.success);
  const failuresByStage = new Map<string, number>();
  for (const record of records) {
    if (!record.success) {
      const stage = record.error_stage ?? "unknown";
      failuresByStage.set(stage, (failuresByStage.get(stage) ?? 0) + 1);
    }
  }

  const totalStats = stats(successful.map((record) => stageTotal(record)).filter((value): value is number => typeof value === "number"));
  const concurrency = options.hostConcurrency ?? Math.max(1, ...records.map((record) => record.concurrency ?? 1));
  const hostUtilization = options.hostUtilization ?? 0.7;
  const estimatedCostPer1kLifecycleStartsUsd =
    options.hostHourlyUsd !== undefined && options.hostConcurrency !== undefined && totalStats.p50 !== null
      ? round(
          (1_000 * options.hostHourlyUsd * (totalStats.p50 / 1000)) /
            (concurrency * 3600 * hostUtilization * Math.max(successful.length / Math.max(records.length, 1), 0.0001)),
          4,
        )
      : null;

  const releaseStats = stats(successful.map((record) => record.session_release_ms).filter((value): value is number => typeof value === "number"));
  const reliabilityPct = round((successful.length / Math.max(records.length, 1)) * 100);
  const isConcurrent16Shape = concurrency >= 16;
  return {
    path: path.relative(root, filePath),
    records: records.length,
    successes: successful.length,
    reliabilityPct,
    concurrency,
    browserArenaShape: isConcurrent16Shape ? "concurrent-16" : "sequential",
    timingsMs: {
      create: stats(successful.map((record) => record.session_creation_ms).filter((value): value is number => typeof value === "number")),
      connect: stats(successful.map((record) => record.session_connect_ms).filter((value): value is number => typeof value === "number")),
      goto: stats(successful.map((record) => record.page_goto_ms).filter((value): value is number => typeof value === "number")),
      release: releaseStats,
      total: totalStats,
      browserArenaLeaderboardLatency: {
        p50StageMedianSum: round(
          (stats(successful.map((record) => record.session_creation_ms).filter((value): value is number => typeof value === "number")).p50 ?? 0) +
          (stats(successful.map((record) => record.session_connect_ms).filter((value): value is number => typeof value === "number")).p50 ?? 0) +
          (stats(successful.map((record) => record.page_goto_ms).filter((value): value is number => typeof value === "number")).p50 ?? 0) +
          (releaseStats.p50 ?? 0),
        ),
      },
    },
    estimatedCostPer1kLifecycleStartsUsd,
    failuresByStage: Object.fromEntries(failuresByStage),
    sotaSequentialGate: {
      reliability: passMin(reliabilityPct, SOTA_TARGETS.sequential.reliabilityPct),
      p50Total: pass(totalStats.p50, SOTA_TARGETS.sequential.p50TotalMs),
      p95Total: pass(totalStats.p95, SOTA_TARGETS.sequential.p95TotalMs),
      p95Release: pass(releaseStats.p95, SOTA_TARGETS.sequential.p95ReleaseMs),
    },
    sotaConcurrent16Gate: isConcurrent16Shape
      ? {
          reliability: passMin(reliabilityPct, SOTA_TARGETS.concurrent16.reliabilityPct),
          p50Total: pass(totalStats.p50, SOTA_TARGETS.concurrent16.p50TotalMs),
          p95Total: pass(totalStats.p95, SOTA_TARGETS.concurrent16.p95TotalMs),
        }
      : null,
  };
}

function readDensityArtifact(filePath: string): DensityArtifact {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as DensityArtifact;
}

function successfulCreates(artifact: DensityArtifact): number[] {
  return artifact.createOutcomes
    .filter((outcome): outcome is { ok: true; createMs: number } => outcome.ok)
    .map((outcome) => outcome.createMs);
}

function successfulNavigations(artifact: DensityArtifact): Array<{
  navigateMs: number;
  pageGotoMs?: number;
  sessionConnectMs?: number;
  soakActionFailures: number;
}> {
  return artifact.navigationOutcomes
    .filter(
      (
        outcome,
      ): outcome is {
        ok: true;
        navigateMs: number;
        soakActionFailures: number;
        soakActionSuccesses: number;
        createMs?: number;
        pageGotoMs?: number;
        sessionConnectMs?: number;
      } => outcome.ok,
    )
    .map((outcome) => ({
      navigateMs: outcome.navigateMs,
      pageGotoMs: outcome.pageGotoMs,
      sessionConnectMs: outcome.sessionConnectMs,
      soakActionFailures: outcome.soakActionFailures,
    }));
}

function maxPressureMetric(artifact: DensityArtifact, metric: "trackedMemoryMb" | "trackedShmUsedMb" | "cpuUtilizationPct" | "memoryPressurePct" | "activeRendererCount"): number | null {
  const values = (artifact.pressureSamples ?? [])
    .map((sample) => sample.host?.metrics?.[metric])
    .filter((value): value is number => typeof value === "number");
  return values.length === 0 ? null : round(Math.max(...values));
}

function summarizeDensity(filePath: string, options: {
  hostHourlyUsd?: number;
  hostUtilization?: number;
  hostVcpu?: number;
  hostMemoryGb?: number;
}): Record<string, unknown> {
  const artifact = readDensityArtifact(filePath);
  const creates = successfulCreates(artifact);
  const navigations = successfulNavigations(artifact);
  const createSuccessRate = creates.length / Math.max(artifact.requestedConcurrency, 1);
  const navigationSuccessRate = navigations.length / Math.max(artifact.requestedConcurrency, 1);
  const successRate = createSuccessRate * navigationSuccessRate;
  const hostUtilization = options.hostUtilization ?? 0.7;
  const stable = createSuccessRate === 1 && navigationSuccessRate === 1 && navigations.every((outcome) => outcome.soakActionFailures === 0);
  const effectiveConcurrency = artifact.requestedConcurrency * successRate;
  const costPerStableBrowserHourUsd =
    options.hostHourlyUsd !== undefined && effectiveConcurrency > 0
      ? round(options.hostHourlyUsd / (effectiveConcurrency * hostUtilization), 4)
      : null;
  return {
    path: path.relative(root, filePath),
    profileId: artifact.profileId,
    profileLabel: artifact.profileLabel,
    requestedConcurrency: artifact.requestedConcurrency,
    stable,
    createSuccessRate: round(createSuccessRate, 4),
    navigationSuccessRate: round(navigationSuccessRate, 4),
    soakActionFailures: navigations.reduce((sum, outcome) => sum + outcome.soakActionFailures, 0),
    timingsMs: {
      create: stats(creates),
      navigate: stats(navigations.map((outcome) => outcome.navigateMs)),
      ...(navigations.some((outcome) => typeof outcome.pageGotoMs === "number")
        ? {
            pageGoto: stats(
              navigations
                .map((outcome) => outcome.pageGotoMs)
                .filter((value): value is number => typeof value === "number"),
            ),
          }
        : {}),
      ...(navigations.some((outcome) => typeof outcome.sessionConnectMs === "number")
        ? {
            sessionConnect: stats(
              navigations
                .map((outcome) => outcome.sessionConnectMs)
                .filter((value): value is number => typeof value === "number"),
            ),
          }
        : {}),
    },
    density: {
      sessionsPerVcpu:
        options.hostVcpu && options.hostVcpu > 0
          ? round(artifact.requestedConcurrency / options.hostVcpu, 4)
          : null,
      sessionsPerGb:
        options.hostMemoryGb && options.hostMemoryGb > 0
          ? round(artifact.requestedConcurrency / options.hostMemoryGb, 4)
          : null,
      costPerStableBrowserHourUsd,
    },
    pressure: {
      peakTrackedMemoryMb: maxPressureMetric(artifact, "trackedMemoryMb"),
      peakTrackedShmUsedMb: maxPressureMetric(artifact, "trackedShmUsedMb"),
      peakCpuUtilizationPct: maxPressureMetric(artifact, "cpuUtilizationPct"),
      peakMemoryPressurePct: maxPressureMetric(artifact, "memoryPressurePct"),
      peakRendererCount: maxPressureMetric(artifact, "activeRendererCount"),
    },
  };
}

const hostHourlyUsd = envNumber("PROVIDER_SCORECARD_HOST_HOURLY_USD");
const hostUtilization = envNumber("PROVIDER_SCORECARD_HOST_UTILIZATION") ?? 0.7;
const hostVcpu = envNumber("PROVIDER_SCORECARD_HOST_VCPU");
const hostMemoryGb = envNumber("PROVIDER_SCORECARD_HOST_MEMORY_GB");
const hostConcurrency = envNumber("PROVIDER_SCORECARD_HOST_CONCURRENCY");
const browserArenaPaths = csvEnv("PROVIDER_SCORECARD_BROWSERARENA_PATHS", DEFAULT_BROWSERARENA_PATHS)
  .filter((filePath) => fs.existsSync(filePath));
const densityPaths = csvEnv("PROVIDER_SCORECARD_DENSITY_PATHS", DEFAULT_DENSITY_PATHS)
  .filter((filePath) => fs.existsSync(filePath));

console.log(JSON.stringify({
  benchmark: "provider-scorecard",
  schema: "provider-scorecard-v1",
  targets: SOTA_TARGETS,
  inputs: {
    hostHourlyUsd: hostHourlyUsd ?? null,
    hostUtilization,
    hostVcpu: hostVcpu ?? null,
    hostMemoryGb: hostMemoryGb ?? null,
    browserArenaPaths: browserArenaPaths.map((filePath) => path.relative(root, filePath)),
    densityPaths: densityPaths.map((filePath) => path.relative(root, filePath)),
  },
  browserArena: browserArenaPaths.map((filePath) => summarizeBrowserArena(filePath, {
    hostHourlyUsd,
    hostUtilization,
    hostConcurrency,
  })),
  density: densityPaths.map((filePath) => summarizeDensity(filePath, {
    hostHourlyUsd,
    hostUtilization,
    hostVcpu,
    hostMemoryGb,
  })),
}, null, 2));
