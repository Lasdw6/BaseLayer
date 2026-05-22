import {
  cleanupContainers,
  createSession,
  measureBrowserArenaStages,
  startProfileBenchmark,
  stopProfileBenchmark,
} from "./lib/harness.js";
import {
  getBrowserArenaPageGotoWaitUntil,
  getBrowserArenaPageUrl,
  shouldUseLocalBenchSite,
} from "./lib/browserarena.js";
import { classifyBenchFailure } from "./lib/bench-failures.js";
import { collectBenchmarkRunMetadata } from "./lib/bench-metadata.js";
import { ACTIVE_BENCHMARK_PROFILES } from "./lib/profiles.js";
import { startBenchSite } from "./lib/site.js";
import { metricStatsFull } from "./lib/stats.js";
import { type LatencyBenchmarkResult, type LatencyMetricStats } from "./lib/types.js";

const iterations = Number.parseInt(process.env["BENCH_ITERATIONS"] ?? "5", 10);
const warmupIterations = Number.parseInt(process.env["BENCH_WARMUP_ITERATIONS"] ?? "10", 10);

function metricStats(values: number[]): LatencyMetricStats {
  return metricStatsFull(values);
}

async function runLatencyBenchmark(): Promise<LatencyBenchmarkResult[]> {
  await cleanupContainers();
  const useLocalBenchSite = shouldUseLocalBenchSite();
  const site = useLocalBenchSite ? await startBenchSite() : null;

  function pageUrlForWorkload(index: number): string {
    if (site) {
      return site.urlForVariant(String((index % 3) + 1));
    }
    return getBrowserArenaPageUrl();
  }

  try {
    const results: LatencyBenchmarkResult[] = [];
    let basePort = 3100;
    for (const profile of ACTIVE_BENCHMARK_PROFILES) {
      const context = await startProfileBenchmark(profile, basePort);
      basePort += 200;
      const runMetadata = await collectBenchmarkRunMetadata(profile);
      try {
        for (let index = 0; index < warmupIterations; index += 1) {
          const { session } = await createSession(context.controlPlaneUrl);
          await measureBrowserArenaStages(
            context.controlPlaneUrl,
            session,
            pageUrlForWorkload(0),
          );
        }

        const iterationResults: LatencyBenchmarkResult["iterations"] = [];
        for (let index = 0; index < iterations; index += 1) {
          try {
            const { session, createMs: session_creation_ms } = await createSession(
              context.controlPlaneUrl,
            );
            const stages = await measureBrowserArenaStages(
              context.controlPlaneUrl,
              session,
              pageUrlForWorkload(index),
            );
            iterationResults.push({
              session_creation_ms,
              session_connect_ms: stages.session_connect_ms,
              page_goto_ms: stages.page_goto_ms,
              session_release_ms: stages.session_release_ms,
              total_ms:
                session_creation_ms +
                stages.session_connect_ms +
                stages.page_goto_ms +
                stages.session_release_ms,
              ok: true,
              browserVersion: stages.browserVersion,
              navigationMetrics: stages.navigationMetrics,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            iterationResults.push({
              session_creation_ms: 0,
              session_connect_ms: 0,
              page_goto_ms: 0,
              session_release_ms: 0,
              total_ms: 0,
              ok: false,
              failureClass: classifyBenchFailure(message),
              failureMessage: message,
            });
          }
        }

        const okIterations = iterationResults.filter((r) => r.ok);
        const successRate = iterations === 0 ? 0 : okIterations.length / iterations;

        const sc = okIterations.map((r) => r.session_creation_ms);
        const sconn = okIterations.map((r) => r.session_connect_ms);
        const pg = okIterations.map((r) => r.page_goto_ms);
        const sr = okIterations.map((r) => r.session_release_ms);
        const total = okIterations.map((r) => r.total_ms);
        const fcpVals = okIterations
          .map((r) => r.navigationMetrics?.firstContentfulPaintMs)
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

        results.push({
          profileId: profile.id,
          label: profile.label,
          iterations: iterationResults,
          successRate,
          session_creation_ms: metricStats(sc),
          session_connect_ms: metricStats(sconn),
          page_goto_ms: metricStats(pg),
          session_release_ms: metricStats(sr),
          total_ms: metricStats(total),
          browserarena_latency_ms: metricStats(total),
          firstContentfulPaintMs: fcpVals.length > 0 ? metricStats(fcpVals) : undefined,
          runMetadata,
        });
      } finally {
        await stopProfileBenchmark(context);
        await cleanupContainers();
      }
    }

    return results;
  } finally {
    if (site) {
      await site.close();
    }
  }
}

const results = await runLatencyBenchmark();
const useLocalBenchSite = shouldUseLocalBenchSite();
console.log(
  JSON.stringify(
    {
      benchmark: "latency",
      schema: "browserarena-stages-v2",
      benchNavigation: useLocalBenchSite
        ? { mode: "local-bench-site" as const }
        : { mode: "browserarena" as const, url: getBrowserArenaPageUrl() },
      pageGotoWaitUntil: getBrowserArenaPageGotoWaitUntil(),
      iterations,
      warmupIterations,
      results,
    },
    null,
    2,
  ),
);
