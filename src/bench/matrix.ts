import { BENCHMARK_PROFILES } from "./lib/profiles.js";
import { cleanupContainers } from "./lib/harness.js";
import { type DensityBenchmarkResult, type LatencyBenchmarkResult } from "./lib/types.js";

async function runScript(script: string): Promise<unknown> {
  const childProcess = await import("node:child_process");
  const util = await import("node:util");
  const execFileAsync = util.promisify(childProcess.execFile);
  const { stdout } = await execFileAsync(process.execPath, [script], {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function summarizeComparison(
  latency: LatencyBenchmarkResult[],
  density: DensityBenchmarkResult[],
): Record<string, unknown> {
  const baselineLatency = latency.find(
    (result) => result.profileId === "BaseLayer-Bulbasaur-generic-container",
  );
  const managedLatency = latency.find(
    (result) => result.profileId === "BaseLayer-Charizard-managed-node",
  );
  const baselineDensity = density.find(
    (result) => result.profileId === "BaseLayer-Bulbasaur-generic-container",
  );
  const managedDensity = density.find(
    (result) => result.profileId === "BaseLayer-Charizard-managed-node",
  );

  return {
    managedVsBaseline: {
      session_creation_ms_delta:
        (managedLatency?.session_creation_ms.avg ?? 0) -
        (baselineLatency?.session_creation_ms.avg ?? 0),
      session_connect_ms_delta:
        (managedLatency?.session_connect_ms.avg ?? 0) -
        (baselineLatency?.session_connect_ms.avg ?? 0),
      page_goto_ms_delta:
        (managedLatency?.page_goto_ms.avg ?? 0) -
        (baselineLatency?.page_goto_ms.avg ?? 0),
      session_release_ms_delta:
        (managedLatency?.session_release_ms.avg ?? 0) -
        (baselineLatency?.session_release_ms.avg ?? 0),
      browserarena_latency_ms_delta:
        (managedLatency?.browserarena_latency_ms.avg ?? 0) -
        (baselineLatency?.browserarena_latency_ms.avg ?? 0),
      stableConcurrencyDelta:
        (managedDensity?.maxStableConcurrency ?? 0) -
        (baselineDensity?.maxStableConcurrency ?? 0),
    },
  };
}

await cleanupContainers();
const latencyReport = (await runScript("dist/bench/latency.js")) as {
  results: LatencyBenchmarkResult[];
};
const densityReport = (await runScript("dist/bench/density.js")) as {
  results: DensityBenchmarkResult[];
};

console.log(
  JSON.stringify(
    {
      benchmark: "matrix",
      profiles: BENCHMARK_PROFILES,
      latency: latencyReport.results,
      density: densityReport.results,
      comparison: summarizeComparison(latencyReport.results, densityReport.results),
    },
    null,
    2,
  ),
);
