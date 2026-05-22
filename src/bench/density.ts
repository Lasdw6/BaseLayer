import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { classifyBenchFailure } from "./lib/bench-failures.js";
import { collectBenchmarkRunMetadata } from "./lib/bench-metadata.js";
import {
  collectNavigationMetricsFromPage,
  collectPressureSample,
  cleanupContainers,
  connectBrowser,
  createSession,
  deleteSession,
  getHostSnapshot,
  getSessionSnapshots,
  markSessionActivity,
  startProfileBenchmark,
  stopProfileBenchmark,
  waitForAgentReady,
  writeBenchmarkArtifact,
} from "./lib/harness.js";
import {
  getBrowserArenaPageGotoWaitUntil,
  getBrowserArenaPageUrl,
  pageNavigationExpectsBenchReadyMarker,
  shouldUseLocalBenchSite,
} from "./lib/browserarena.js";
import { ACTIVE_BENCHMARK_PROFILES } from "./lib/profiles.js";
import { startBenchSite } from "./lib/site.js";
import { average, metricStatsFull, percentile } from "./lib/stats.js";
import {
  type DensityBenchmarkResult,
  type DensityLevelResult,
  type NavigationMetricsSnapshot,
} from "./lib/types.js";

function taxonomyFromSettledFailures(outcomes: PromiseSettledResult<unknown>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const o of outcomes) {
    if (o.status === "fulfilled") {
      continue;
    }
    const msg = o.reason instanceof Error ? o.reason.message : String(o.reason);
    const c = classifyBenchFailure(msg);
    counts[c] = (counts[c] ?? 0) + 1;
  }
  return counts;
}

const maxConcurrency = Number.parseInt(process.env["BENCH_MAX_CONCURRENCY"] ?? "4", 10);
const concurrencyStep = Number.parseInt(process.env["BENCH_CONCURRENCY_STEP"] ?? "1", 10);
const requestedConcurrencyValues = (process.env["BENCH_CONCURRENCY_VALUES"] ?? "")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0);
const successThreshold = Number.parseFloat(process.env["BENCH_SUCCESS_THRESHOLD"] ?? "1");
const warmupIterations = Number.parseInt(process.env["BENCH_WARMUP_ITERATIONS"] ?? "1", 10);
const soakSeconds = Number.parseInt(process.env["BENCH_SOAK_SECONDS"] ?? "10", 10);
const activeSessionRatio = Number.parseFloat(process.env["BENCH_ACTIVE_SESSION_RATIO"] ?? "0.5");
const activeRoundsPerSession = Number.parseInt(
  process.env["BENCH_ACTIVE_ROUNDS_PER_SESSION"] ?? "3",
  10,
);
const activePauseMs = Number.parseInt(process.env["BENCH_ACTIVE_PAUSE_MS"] ?? "500", 10);
const sampleIntervalMs = Number.parseInt(process.env["BENCH_PRESSURE_SAMPLE_MS"] ?? "1000", 10);
const reportDir = process.env["BENCH_REPORT_DIR"] ?? path.join(process.cwd(), "data", "benchmarks");
const workloadMode = process.env["BENCH_WORKLOAD_MODE"] === "bursty" ? "bursty" : "steady";
const burstCount = Number.parseInt(process.env["BENCH_BURST_COUNT"] ?? "3", 10);
const burstRoundsPerBurst = Number.parseInt(process.env["BENCH_BURST_ROUNDS"] ?? "2", 10);
const burstIdleMs = Number.parseInt(process.env["BENCH_BURST_IDLE_MS"] ?? "5000", 10);
const burstStaggerMs = Number.parseInt(process.env["BENCH_BURST_STAGGER_MS"] ?? "250", 10);
const browserCloseTimeoutMs = Number.parseInt(
  process.env["BENCH_BROWSER_CLOSE_TIMEOUT_MS"] ?? "5000",
  10,
);
const maxSessionActionMs = Number.parseInt(
  process.env["BENCH_SESSION_ACTION_TIMEOUT_MS"] ?? "120000",
  10,
);
const warmupSoakSeconds = Number.parseInt(
  process.env["BENCH_WARMUP_SOAK_SECONDS"] ?? "2",
  10,
);
const warmupActiveRounds = Number.parseInt(
  process.env["BENCH_WARMUP_ACTIVE_ROUNDS"] ?? "1",
  10,
);
const postWarmupSettleMs = Number.parseInt(
  process.env["BENCH_POST_WARMUP_SETTLE_MS"] ?? "0",
  10,
);
const waitForWarmupIdle =
  process.env["BENCH_WAIT_FOR_WARMUP_IDLE"] !== "0";
const benchmarkNavigationConcurrency = Number.parseInt(
  process.env["BENCH_NAVIGATION_CONCURRENCY"] ?? "0",
  10,
);
const benchmarkNavigationConcurrencyOverride = process.env["BENCH_NAVIGATION_CONCURRENCY"];
const stagedNavigation = process.env["BENCH_STAGED_NAVIGATION"] === "1";
const stagedNavigationTimeoutMs = Number.parseInt(
  process.env["BENCH_STAGED_NAVIGATION_TIMEOUT_MS"] ?? "10000",
  10,
);
const benchmarkConnectConcurrency = Number.parseInt(
  process.env["BENCH_CONNECT_CONCURRENCY"] ?? "0",
  10,
);
const requestedProfileIdsRaw = process.env["BENCH_PROFILE_IDS"] ?? "";
const requestedProfileIds = requestedProfileIdsRaw
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const requestedProfileIdsSet = new Set(requestedProfileIds);
const isOptimizedVsVanillaCompare =
  (requestedProfileIdsSet.has("BaseLayer-Mew-firecracker-headless-shell") ||
    requestedProfileIdsSet.has("profile-c-firecracker-snapshot")) &&
  (requestedProfileIdsSet.has("BaseLayer-Ivysaur-firecracker-vanilla") ||
    requestedProfileIdsSet.has("profile-d-firecracker-vanilla"));
const useDataUrlsOnly =
  process.env["BENCH_USE_DATA_URLS"] === "1" ||
  (isOptimizedVsVanillaCompare && process.env["BENCH_SITE_FORCE_HTTP"] !== "1");

const activeBenchUrls = [
  "data:text/html,<title>BaseLayer%20bench%201</title><script>window.__baselayerBenchReady=true;</script><h1>bench1</h1>",
  "data:text/html,<title>BaseLayer%20bench%202</title><script>window.__baselayerBenchReady=true;</script><h1>bench2</h1>",
  "data:text/html,<title>BaseLayer%20bench%203</title><script>window.__baselayerBenchReady=true;</script><h1>bench3</h1>",
];

class AsyncSemaphore {
  #available: number;
  readonly #waiters: Array<(release: () => void) => void> = [];

  constructor(limit: number) {
    this.#available = Math.max(1, limit);
  }

  async acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return this.#release;
    }

    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  readonly #release = (): void => {
    const next = this.#waiters.shift();
    if (next) {
      next(this.#release);
      return;
    }

    this.#available += 1;
  };
}

function replaceHost(url: string, host: string): string {
  const parsed = new URL(url);
  parsed.hostname = host;
  return parsed.toString();
}

function firecrackerSiteVariantUrl(baseUrl: string, variant: string): string {
  const parsed = new URL(baseUrl);
  parsed.hostname = "172.22.0.1";
  parsed.pathname = "/";
  parsed.search = `?v=${encodeURIComponent(variant)}`;
  return parsed.toString();
}

async function setBenchmarkSessionActivity(
  agentUrl: string,
  sessionId: string,
  activityState: "active-navigation" | "interactive-idle" | "soak-idle",
): Promise<void> {
  await markSessionActivity(agentUrl, sessionId, activityState).catch(() => undefined);
}

async function exerciseSession(
  cdpEndpoint: string,
  initialUrl: string,
  activeUrls: string[],
  isActive: boolean,
  options: {
    soakSecondsOverride?: number;
    activeRoundsOverride?: number;
    initialDelayMs?: number;
    connectGate?: AsyncSemaphore;
    navigationGate?: AsyncSemaphore;
    onReadyToNavigate?: () => void;
    beforeFirstNavigation?: () => Promise<void>;
    onActivityState?: (
      activityState: "active-navigation" | "interactive-idle" | "soak-idle",
    ) => Promise<void>;
  } = {},
): Promise<{
  navigateMs: number;
  sessionConnectMs: number;
  connectQueueWaitMs: number;
  pageGotoMs: number;
  benchReadyWaitMs: number;
  navigationQueueWaitMs: number;
  soakActionSuccesses: number;
  soakActionFailures: number;
  firstNavigationMetrics?: NavigationMetricsSnapshot;
  browserVersion?: string;
}> {
  let releaseConnectGate: (() => void) | undefined;
  let connectQueueWaitMs = 0;
  if (options.connectGate) {
    const connectQueueStarted = performance.now();
    releaseConnectGate = await options.connectGate.acquire();
    connectQueueWaitMs = performance.now() - connectQueueStarted;
  }
  const connectStarted = performance.now();
  let browser: Awaited<ReturnType<typeof connectBrowser>>;
  let browserVersion: string | undefined;
  try {
    browser = await connectBrowser(cdpEndpoint);
    browserVersion = await browser.version();
  } finally {
    releaseConnectGate?.();
  }
  const sessionConnectMs = performance.now() - connectStarted;
  const started = performance.now();

  let soakActionSuccesses = 0;
  let soakActionFailures = 0;
  let navigateMs = 0;
  let pageGotoMs = 0;
  let benchReadyWaitMs = 0;
  let navigationQueueWaitMs = 0;
  let firstNavigationMetrics: NavigationMetricsSnapshot | undefined;
  const effectiveSoakSeconds = options.soakSecondsOverride ?? soakSeconds;
  const effectiveActiveRounds = Math.max(
    1,
    options.activeRoundsOverride ?? activeRoundsPerSession,
  );
  const sessionActionTimeoutMs = Math.max(
    maxSessionActionMs,
    effectiveSoakSeconds * 1000 + 60_000,
  );
  const waitUntil = getBrowserArenaPageGotoWaitUntil();

  try {
    await Promise.race([
      (async () => {
        const context = browser.contexts()[0] ?? (await browser.newContext());
        const page = await context.newPage();
        const soakDeadline = Date.now() + effectiveSoakSeconds * 1000;
        const gotoWithOptionalGate = async (url: string): Promise<number> => {
          let release: (() => void) | undefined;
          if (options.navigationGate) {
            const queueStarted = performance.now();
            release = await options.navigationGate.acquire();
            navigationQueueWaitMs += performance.now() - queueStarted;
          }

          try {
            const gotoStarted = performance.now();
            await page.goto(url, { waitUntil, timeout: 60_000 });
            return performance.now() - gotoStarted;
          } finally {
            release?.();
          }
        };

        options.onReadyToNavigate?.();
        await options.beforeFirstNavigation?.();

        if (options.initialDelayMs && options.initialDelayMs > 0) {
          await options.onActivityState?.("interactive-idle");
          await sleep(options.initialDelayMs);
        }
        await options.onActivityState?.("active-navigation");
        pageGotoMs = await gotoWithOptionalGate(initialUrl);
        if (pageNavigationExpectsBenchReadyMarker(initialUrl)) {
          const readyStarted = performance.now();
          await page.waitForFunction(() => (window as { __baselayerBenchReady?: boolean }).__baselayerBenchReady === true, null, {
            timeout: 15_000,
          });
          benchReadyWaitMs = performance.now() - readyStarted;
        } else {
          benchReadyWaitMs = 0;
        }
        await page.title().catch(() => undefined);
        firstNavigationMetrics = await collectNavigationMetricsFromPage(page);
        navigateMs = performance.now() - started;

        if (workloadMode === "bursty") {
          for (let burst = 0; burst < Math.max(1, burstCount) && Date.now() < soakDeadline; burst += 1) {
            await options.onActivityState?.("active-navigation");
            for (let round = 0; round < Math.max(1, burstRoundsPerBurst); round += 1) {
              const benchUrl = activeUrls[(burst + round) % activeUrls.length]!;
              try {
                await gotoWithOptionalGate(benchUrl);
                if (pageNavigationExpectsBenchReadyMarker(benchUrl)) {
                  await page.waitForFunction(() => (window as { __baselayerBenchReady?: boolean }).__baselayerBenchReady === true, null, {
                    timeout: 15_000,
                  });
                }
                await page.title().catch(() => undefined);
                soakActionSuccesses += 1;
              } catch {
                soakActionFailures += 1;
              }
            }

            if (Date.now() < soakDeadline) {
              await options.onActivityState?.("interactive-idle");
              await sleep(Math.min(burstIdleMs, Math.max(0, soakDeadline - Date.now())));
            }
          }

          if (Date.now() < soakDeadline) {
            await options.onActivityState?.("interactive-idle");
            await sleep(Math.max(0, soakDeadline - Date.now()));
          }
        } else if (isActive) {
          let round = 0;
          const minimumRounds = effectiveActiveRounds;
          while (round < minimumRounds || Date.now() < soakDeadline) {
            const benchUrl = activeUrls[round % activeUrls.length]!;
            try {
              await gotoWithOptionalGate(benchUrl);
              if (pageNavigationExpectsBenchReadyMarker(benchUrl)) {
                await page.waitForFunction(() => (window as { __baselayerBenchReady?: boolean }).__baselayerBenchReady === true, null, {
                  timeout: 15_000,
                });
              }
              await page.title().catch(() => undefined);
              soakActionSuccesses += 1;
            } catch {
              soakActionFailures += 1;
            }
            round += 1;

            if (Date.now() < soakDeadline) {
              await sleep(Math.min(activePauseMs, Math.max(0, soakDeadline - Date.now())));
            }
          }
        } else {
          await options.onActivityState?.("soak-idle");
          await sleep(Math.max(0, soakDeadline - Date.now()));
        }
      })(),
      sleep(sessionActionTimeoutMs).then(() => {
        throw new Error(`Session action exceeded ${sessionActionTimeoutMs}ms`);
      }),
    ]);
  } finally {
    await Promise.race([
      browser.close().catch(() => undefined),
      sleep(browserCloseTimeoutMs),
    ]).catch(() => undefined);
  }

  return {
    navigateMs,
    sessionConnectMs,
    connectQueueWaitMs,
    pageGotoMs,
    benchReadyWaitMs,
    navigationQueueWaitMs,
    soakActionSuccesses,
    soakActionFailures,
    firstNavigationMetrics,
    browserVersion,
  };
}

async function runDensityBenchmark(): Promise<DensityBenchmarkResult[]> {
  await cleanupContainers();
  const site = await startBenchSite();
  process.env["BENCH_SITE_PORT"] = new URL(site.localBaseUrl).port;

  try {
    const results: DensityBenchmarkResult[] = [];
    let basePort = 3500;
    for (const profile of ACTIVE_BENCHMARK_PROFILES) {
      const context = await startProfileBenchmark(profile, basePort);
      const runMetadata = await collectBenchmarkRunMetadata(profile);
      basePort += 200;
      const browserArenaNavUrl = getBrowserArenaPageUrl();
      const configuredNavigationConcurrency =
        benchmarkNavigationConcurrencyOverride === undefined
          ? Number.parseInt(
              profile.defaultAgentEnv["FIRECRACKER_MAX_CONCURRENT_ACTIVE_NAVIGATION"] ?? "0",
              10,
            )
          : benchmarkNavigationConcurrency;
      const profileNavigationConcurrency = Number.isFinite(configuredNavigationConcurrency)
        ? Math.max(0, configuredNavigationConcurrency)
        : 0;
      const navigationGate =
        profileNavigationConcurrency > 0
          ? new AsyncSemaphore(profileNavigationConcurrency)
          : undefined;
      const connectGate =
        Number.isFinite(benchmarkConnectConcurrency) && benchmarkConnectConcurrency > 0
          ? new AsyncSemaphore(benchmarkConnectConcurrency)
          : undefined;
      const siteVariantUrl = (variant: string): string => {
        if (useDataUrlsOnly) {
          return activeBenchUrls[(Number.parseInt(variant, 10) - 1 + activeBenchUrls.length) % activeBenchUrls.length]!;
        }
        if (context.profile.mode === "firecracker") {
          return firecrackerSiteVariantUrl(site.localBaseUrl, variant);
        }
        if (shouldUseLocalBenchSite()) {
          return site.urlForVariant(variant);
        }
        return browserArenaNavUrl;
      };

      try {
        for (let index = 0; index < warmupIterations; index += 1) {
          let lastError: unknown;
          let warmed = false;
          for (let attempt = 0; attempt < 3 && !warmed; attempt += 1) {
            const { session } = await createSession(context.controlPlaneUrl);
            try {
              await setBenchmarkSessionActivity(
                context.agentUrl,
                session.sessionId,
                "active-navigation",
              );
              await exerciseSession(
                session.debugHttpUrl ?? session.playwrightUrl,
                siteVariantUrl("1"),
                [siteVariantUrl("1")],
                true,
                {
                  soakSecondsOverride: warmupSoakSeconds,
                  activeRoundsOverride: warmupActiveRounds,
                },
              );
              warmed = true;
            } catch (error) {
              lastError = error;
            } finally {
              await deleteSession(context.controlPlaneUrl, session.sessionId).catch(() => undefined);
            }
          }

          if (!warmed) {
            throw lastError instanceof Error ? lastError : new Error(String(lastError));
          }
        }
        if (postWarmupSettleMs > 0) {
          await sleep(postWarmupSettleMs);
        }
        if (waitForWarmupIdle) {
          await waitForAgentReady(context.agentUrl, context.profile, {
            requireFullWarmPool: true,
          });
        }

        const levels: DensityLevelResult[] = [];
        let maxStableConcurrencyForProfile = 0;

        const concurrencyLevels =
          requestedConcurrencyValues.length > 0
            ? requestedConcurrencyValues
            : Array.from(
                {
                  length:
                    Math.floor((maxConcurrency - 1) / Math.max(1, concurrencyStep)) + 1,
                },
                (_, index) => 1 + index * Math.max(1, concurrencyStep),
              ).filter((value) => value <= maxConcurrency);

        for (const requestedConcurrency of concurrencyLevels) {
          const createOutcomes = await Promise.allSettled(
            Array.from({ length: requestedConcurrency }, () =>
              createSession(context.controlPlaneUrl),
            ),
          );

          const successfulCreates = createOutcomes
            .filter(
              (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof createSession>>> =>
                result.status === "fulfilled",
            )
            .map((result) => result.value);

          const createSuccessRate = successfulCreates.length / requestedConcurrency;
          const activeSessionCount = Math.max(
            1,
            Math.min(
              successfulCreates.length,
              Math.ceil(successfulCreates.length * activeSessionRatio),
            ),
          );
          const activeSessionIds = new Set(
            successfulCreates
              .slice(0, activeSessionCount)
              .map(({ session }) => session.sessionId),
          );
          const burstCohortCount = Math.max(1, Math.ceil(1 / Math.max(0.01, activeSessionRatio)));

          const successfulSessionIds = new Set(
            successfulCreates.map(({ session }) => session.sessionId),
          );
          const pressureSamples: Array<
            Awaited<ReturnType<typeof collectPressureSample>>
          > = [];
          let stagedReadyCount = 0;
          let releaseStagedNavigation: (() => void) | undefined;
          const stagedNavigationStarted = stagedNavigation
            ? new Promise<void>((resolve) => {
                releaseStagedNavigation = resolve;
              })
            : undefined;
          const stagedNavigationTimeout = stagedNavigationStarted
            ? sleep(stagedNavigationTimeoutMs).then(() => undefined)
            : undefined;

          const navigationPromise = Promise.allSettled(
            successfulCreates.map(async ({ session, createMs }, index) => {
              let reachedNavigationBarrier = false;
              const markReadyToNavigate = (): void => {
                if (reachedNavigationBarrier) {
                  return;
                }
                reachedNavigationBarrier = true;
                stagedReadyCount += 1;
                if (stagedReadyCount >= successfulCreates.length) {
                  releaseStagedNavigation?.();
                }
              };
              const initialVariant = String((index % activeBenchUrls.length) + 1);
              const activeUrls =
                useDataUrlsOnly || shouldUseLocalBenchSite() || context.profile.mode === "firecracker"
                  ? activeBenchUrls.map((_, activeIndex) =>
                      siteVariantUrl(String(((index + activeIndex) % activeBenchUrls.length) + 1)),
                    )
                  : [browserArenaNavUrl];
              await setBenchmarkSessionActivity(
                context.agentUrl,
                session.sessionId,
                workloadMode === "bursty"
                  ? "interactive-idle"
                  : activeSessionIds.has(session.sessionId)
                    ? "active-navigation"
                    : "soak-idle",
              );
              try {
                const soakResult = await exerciseSession(
                  session.debugHttpUrl ?? session.playwrightUrl,
                  siteVariantUrl(initialVariant),
                  activeUrls,
                  workloadMode === "bursty" || activeSessionIds.has(session.sessionId),
                  {
                    connectGate,
                    navigationGate,
                    onReadyToNavigate: stagedNavigationStarted
                      ? markReadyToNavigate
                      : undefined,
                    beforeFirstNavigation: stagedNavigationStarted
                      ? () => Promise.race([stagedNavigationStarted, stagedNavigationTimeout!])
                      : undefined,
                    initialDelayMs:
                      workloadMode === "bursty"
                        ? (index % burstCohortCount) * Math.max(0, burstStaggerMs)
                        : 0,
                    onActivityState:
                      workloadMode === "bursty"
                        ? (activityState) =>
                            setBenchmarkSessionActivity(
                              context.agentUrl,
                              session.sessionId,
                              activityState,
                            )
                        : undefined,
                  },
                );
                return {
                  sessionId: session.sessionId,
                  createMs,
                  ...soakResult,
                };
              } catch (error) {
                if (stagedNavigationStarted) {
                  markReadyToNavigate();
                }
                throw error;
              } finally {
                await setBenchmarkSessionActivity(
                  context.agentUrl,
                  session.sessionId,
                  "interactive-idle",
                );
              }
            }),
          );

          let keepSampling = true;
          const pressureSamplerPromise = (async () => {
            try {
              while (keepSampling) {
                pressureSamples.push(
                  await collectPressureSample(context.controlPlaneUrl, successfulSessionIds),
                );
                await sleep(sampleIntervalMs);
              }
            } catch {
              // Ignore sampling failures in the background loop.
            }
          })();

          const navigationOutcomes = await navigationPromise;
          keepSampling = false;
          await pressureSamplerPromise;

          const successfulNavigations = navigationOutcomes.filter(
            (
              result,
            ): result is PromiseFulfilledResult<{
              sessionId: string;
              createMs: number;
              navigateMs: number;
              sessionConnectMs: number;
              connectQueueWaitMs: number;
              pageGotoMs: number;
              benchReadyWaitMs: number;
              navigationQueueWaitMs: number;
              soakActionSuccesses: number;
              soakActionFailures: number;
              firstNavigationMetrics?: NavigationMetricsSnapshot;
              browserVersion?: string;
            }> => result.status === "fulfilled",
          );

          const hostSnapshot = await getHostSnapshot(context.controlPlaneUrl);
          const sessionSnapshots = await getSessionSnapshots(context.controlPlaneUrl);
          const relevantSessionSnapshots = sessionSnapshots.filter((session) =>
            successfulSessionIds.has(session.sessionId),
          );

          pressureSamples.push(
            await collectPressureSample(context.controlPlaneUrl, successfulSessionIds),
          );

          const deleteOutcomes = await Promise.allSettled(
            successfulCreates.map(async ({ session }) => {
              const deleteStarted = performance.now();
              await deleteSession(context.controlPlaneUrl, session.sessionId);
              return {
                sessionId: session.sessionId,
                deleteMs: performance.now() - deleteStarted,
              };
            }),
          );
          const successfulDeletes = deleteOutcomes.filter(
            (
              result,
            ): result is PromiseFulfilledResult<{ sessionId: string; deleteMs: number }> =>
              result.status === "fulfilled",
          );
          await waitForAgentReady(context.agentUrl, context.profile, {
            requireFullWarmPool: false,
          });

          const pageGotoDistribution = metricStatsFull(
            successfulNavigations.map((result) => result.value.pageGotoMs),
          );
          const sessionConnectDistribution = metricStatsFull(
            successfulNavigations.map((result) => result.value.sessionConnectMs),
          );
          const deleteDistribution = metricStatsFull(
            successfulDeletes.map((result) => result.value.deleteMs),
          );
          const fcpSamples = successfulNavigations
            .map((result) => result.value.firstNavigationMetrics?.firstContentfulPaintMs)
            .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

          const levelArtifact = {
            benchmark: "density",
            schema: "browserarena-stages-v2",
            profileId: profile.id,
            profileLabel: profile.label,
            requestedConcurrency,
            soakSeconds,
            workloadMode,
            activeSessionRatio,
            activeRoundsPerSession,
            activePauseMs,
            burstCount: workloadMode === "bursty" ? burstCount : undefined,
            burstRoundsPerBurst: workloadMode === "bursty" ? burstRoundsPerBurst : undefined,
            burstIdleMs: workloadMode === "bursty" ? burstIdleMs : undefined,
            burstStaggerMs: workloadMode === "bursty" ? burstStaggerMs : undefined,
            navigationConcurrency: profileNavigationConcurrency || undefined,
            connectConcurrency: connectGate ? benchmarkConnectConcurrency : undefined,
            stagedNavigation: stagedNavigation || undefined,
            siteBaseUrl: site.baseUrl,
            createOutcomes: createOutcomes.map((result) =>
              result.status === "fulfilled"
                ? {
                    ok: true,
                    sessionId: result.value.session.sessionId,
                    createMs: result.value.createMs,
                    launchTimings: result.value.session.launchTimings,
                  }
                : {
                    ok: false,
                    error:
                      result.reason instanceof Error
                        ? result.reason.message
                        : String(result.reason),
                  },
            ),
            navigationOutcomes: navigationOutcomes.map((result) =>
              result.status === "fulfilled"
                ? { ok: true, ...result.value }
                : {
                    ok: false,
                    error:
                      result.reason instanceof Error
                        ? result.reason.message
                        : String(result.reason),
                  },
            ),
            deleteOutcomes: deleteOutcomes.map((result) =>
              result.status === "fulfilled"
                ? { ok: true, ...result.value }
                : {
                    ok: false,
                    error:
                      result.reason instanceof Error
                        ? result.reason.message
                        : String(result.reason),
                  },
            ),
            hostSnapshot,
            sessionSnapshots: relevantSessionSnapshots,
            pressureSamples,
          };
          const reportPath = await writeBenchmarkArtifact(
            reportDir,
            `density-${profile.id}-c${requestedConcurrency}.json`,
            levelArtifact,
          );

          const level: DensityLevelResult = {
            requestedConcurrency,
            sessionCreateSuccesses: successfulCreates.length,
            navigationSuccesses: successfulNavigations.length,
            createSuccessRate,
            navigationSuccessRate:
              requestedConcurrency === 0
                ? 0
                : successfulNavigations.length / requestedConcurrency,
            avgCreateMs: average(successfulCreates.map((result) => result.createMs)),
            avgNavigateMs: average(
              successfulNavigations.map((result) => result.value.navigateMs),
            ),
            avgPageGotoMs: average(
              successfulNavigations.map((result) => result.value.pageGotoMs),
            ),
            p50PageGotoMs: pageGotoDistribution.p50,
            p95PageGotoMs: pageGotoDistribution.p95,
            p99PageGotoMs: pageGotoDistribution.p99,
            maxPageGotoMs: pageGotoDistribution.max,
            stddevPageGotoMs: pageGotoDistribution.stddev,
            avgLifecycleMs:
              average(successfulCreates.map((result) => result.createMs)) +
              average(successfulNavigations.map((result) => result.value.sessionConnectMs)) +
              average(successfulNavigations.map((result) => result.value.navigateMs)),
            avgCreateConnectGotoMs:
              average(successfulCreates.map((result) => result.createMs)) +
              average(successfulNavigations.map((result) => result.value.sessionConnectMs)) +
              average(successfulNavigations.map((result) => result.value.pageGotoMs)),
            avgNavigationQueueWaitMs: average(
              successfulNavigations.map((result) => result.value.navigationQueueWaitMs),
            ),
            p95NavigationQueueWaitMs: percentile(
              successfulNavigations.map((result) => result.value.navigationQueueWaitMs),
              95,
            ),
            avgConnectQueueWaitMs: average(
              successfulNavigations.map((result) => result.value.connectQueueWaitMs),
            ),
            p95ConnectQueueWaitMs: percentile(
              successfulNavigations.map((result) => result.value.connectQueueWaitMs),
              95,
            ),
            avgDeleteMs: average(successfulDeletes.map((result) => result.value.deleteMs)),
            p95DeleteMs: deleteDistribution.p95,
            p99DeleteMs: deleteDistribution.p99,
            maxDeleteMs: deleteDistribution.max,
            avgLifecycleWithDeleteMs:
              average(successfulCreates.map((result) => result.createMs)) +
              average(successfulNavigations.map((result) => result.value.sessionConnectMs)) +
              average(successfulNavigations.map((result) => result.value.navigateMs)) +
              average(successfulDeletes.map((result) => result.value.deleteMs)),
            avgCreateConnectGotoDeleteMs:
              average(successfulCreates.map((result) => result.createMs)) +
              average(successfulNavigations.map((result) => result.value.sessionConnectMs)) +
              average(successfulNavigations.map((result) => result.value.pageGotoMs)) +
              average(successfulDeletes.map((result) => result.value.deleteMs)),
            avgSessionConnectMs: average(
              successfulNavigations.map((result) => result.value.sessionConnectMs),
            ),
            p50SessionConnectMs: sessionConnectDistribution.p50,
            p95SessionConnectMs: sessionConnectDistribution.p95,
            p99SessionConnectMs: sessionConnectDistribution.p99,
            maxSessionConnectMs: sessionConnectDistribution.max,
            stddevSessionConnectMs: sessionConnectDistribution.stddev,
            soakSeconds,
            workloadMode,
            burstCount: workloadMode === "bursty" ? burstCount : undefined,
            burstRoundsPerBurst: workloadMode === "bursty" ? burstRoundsPerBurst : undefined,
            burstIdleMs: workloadMode === "bursty" ? burstIdleMs : undefined,
            burstStaggerMs: workloadMode === "bursty" ? burstStaggerMs : undefined,
            activeSessionCount,
            idleSessionCount: Math.max(0, successfulCreates.length - activeSessionCount),
            soakActionSuccesses: successfulNavigations.reduce(
              (sum, result) => sum + result.value.soakActionSuccesses,
              0,
            ),
            soakActionFailures: successfulNavigations.reduce(
              (sum, result) => sum + result.value.soakActionFailures,
              0,
            ),
            avgFirstContentfulPaintMs:
              fcpSamples.length > 0 ? average(fcpSamples) : undefined,
            createFailureTaxonomy: taxonomyFromSettledFailures(createOutcomes),
            navigationFailureTaxonomy: taxonomyFromSettledFailures(navigationOutcomes),
            deleteFailureTaxonomy: taxonomyFromSettledFailures(deleteOutcomes),
            hostStatus: hostSnapshot?.status ?? "unknown",
            hostActiveSessions: hostSnapshot?.metrics.activeSessions ?? 0,
            hostActiveRendererCount: hostSnapshot?.metrics.activeRendererCount ?? 0,
            hostTrackedMemoryMb: hostSnapshot?.metrics.trackedMemoryMb ?? 0,
            hostTrackedShmUsedMb: hostSnapshot?.metrics.trackedShmUsedMb ?? 0,
            crashCount5m: hostSnapshot?.metrics.crashCount5m ?? 0,
            pressureSampleCount: pressureSamples.length,
            peakTrackedMemoryMb: Math.max(
              hostSnapshot?.metrics.trackedMemoryMb ?? 0,
              ...pressureSamples.map((sample) => sample.host?.metrics.trackedMemoryMb ?? 0),
            ),
            peakMemoryPressurePct: Math.max(
              hostSnapshot?.metrics.memoryPressurePct ?? 0,
              ...pressureSamples.map((sample) => sample.host?.metrics.memoryPressurePct ?? 0),
            ),
            peakTrackedShmUsedMb: Math.max(
              hostSnapshot?.metrics.trackedShmUsedMb ?? 0,
              ...pressureSamples.map((sample) => sample.host?.metrics.trackedShmUsedMb ?? 0),
            ),
            peakCpuUtilizationPct: Math.max(
              hostSnapshot?.metrics.cpuUtilizationPct ?? 0,
              ...pressureSamples.map((sample) => sample.host?.metrics.cpuUtilizationPct ?? 0),
            ),
            peakLoadAvg1m: Math.max(
              hostSnapshot?.metrics.loadAvg1m ?? 0,
              ...pressureSamples.map((sample) => sample.host?.metrics.loadAvg1m ?? 0),
            ),
            avgLaunchTotalMs: average(
              successfulCreates
                .map((result) => result.session.launchTimings?.totalMs)
                .filter((value): value is number => typeof value === "number"),
            ),
            avgLaunchNetworkSetupMs: average(
              successfulCreates
                .map((result) => result.session.launchTimings?.networkSetupMs)
                .filter((value): value is number => typeof value === "number"),
            ),
            avgLaunchNetworkClaimMs: average(
              successfulCreates
                .map((result) => result.session.launchTimings?.networkClaimMs)
                .filter((value): value is number => typeof value === "number"),
            ),
            avgLaunchNetworkValidateMs: average(
              successfulCreates
                .map((result) => result.session.launchTimings?.networkValidateMs)
                .filter((value): value is number => typeof value === "number"),
            ),
            avgLaunchHelperCleanupMs: average(
              successfulCreates
                .map((result) => result.session.launchTimings?.helperCleanupMs)
                .filter((value): value is number => typeof value === "number"),
            ),
            avgLaunchProcessSpawnMs: average(
              successfulCreates
                .map((result) => result.session.launchTimings?.processSpawnMs)
                .filter((value): value is number => typeof value === "number"),
            ),
            avgLaunchConfigureMs: average(
              successfulCreates
                .map((result) => result.session.launchTimings?.configureMs)
                .filter((value): value is number => typeof value === "number"),
            ),
            avgLaunchCdpReadyMs: average(
              successfulCreates
                .map((result) => result.session.launchTimings?.cdpReadyMs)
                .filter((value): value is number => typeof value === "number"),
            ),
            avgLaunchCdpSocketReadyMs: average(
              successfulCreates
                .map((result) => result.session.launchTimings?.cdpSocketReadyMs)
                .filter((value): value is number => typeof value === "number"),
            ),
            avgLaunchCdpVersionReadyMs: average(
              successfulCreates
                .map((result) => result.session.launchTimings?.cdpVersionReadyMs)
                .filter((value): value is number => typeof value === "number"),
            ),
            avgLaunchCdpTargetListReadyMs: average(
              successfulCreates
                .map((result) => result.session.launchTimings?.cdpTargetListReadyMs)
                .filter((value): value is number => typeof value === "number"),
            ),
            p95LaunchTotalMs: percentile(
              successfulCreates
                .map((result) => result.session.launchTimings?.totalMs)
                .filter((value): value is number => typeof value === "number"),
              95,
            ),
            p95LaunchHelperCleanupMs: percentile(
              successfulCreates
                .map((result) => result.session.launchTimings?.helperCleanupMs)
                .filter((value): value is number => typeof value === "number"),
              95,
            ),
            p95LaunchProcessSpawnMs: percentile(
              successfulCreates
                .map((result) => result.session.launchTimings?.processSpawnMs)
                .filter((value): value is number => typeof value === "number"),
              95,
            ),
            p95LaunchConfigureMs: percentile(
              successfulCreates
                .map((result) => result.session.launchTimings?.configureMs)
                .filter((value): value is number => typeof value === "number"),
              95,
            ),
            p95LaunchCdpReadyMs: percentile(
              successfulCreates
                .map((result) => result.session.launchTimings?.cdpReadyMs)
                .filter((value): value is number => typeof value === "number"),
              95,
            ),
            reportPath,
          };
          levels.push(level);

          if (
            level.createSuccessRate >= successThreshold &&
            level.navigationSuccessRate >= successThreshold &&
            level.soakActionFailures === 0
          ) {
            maxStableConcurrencyForProfile = requestedConcurrency;
          } else {
            break;
          }
        }

        results.push({
          profileId: profile.id,
          label: profile.label,
          levels,
          maxStableConcurrency: maxStableConcurrencyForProfile,
          runMetadata,
        });
      } finally {
        await stopProfileBenchmark(context);
        await cleanupContainers();
      }
    }

    return results;
  } finally {
    await site.close();
  }
}

const results = await runDensityBenchmark();
console.log(
  JSON.stringify(
    {
      benchmark: "density",
      schema: "browserarena-stages-v2",
      maxConcurrency,
      concurrencyStep,
      concurrencyValues:
        requestedConcurrencyValues.length > 0 ? requestedConcurrencyValues : undefined,
      successThreshold,
      warmupIterations,
      waitForWarmupIdle,
      soakSeconds,
      workloadMode,
      activeSessionRatio,
      activeRoundsPerSession,
      activePauseMs,
      navigationConcurrency:
        benchmarkNavigationConcurrency > 0 ? benchmarkNavigationConcurrency : undefined,
      connectConcurrency:
        benchmarkConnectConcurrency > 0 ? benchmarkConnectConcurrency : undefined,
      stagedNavigation,
      burstCount: workloadMode === "bursty" ? burstCount : undefined,
      burstRoundsPerBurst: workloadMode === "bursty" ? burstRoundsPerBurst : undefined,
      burstIdleMs: workloadMode === "bursty" ? burstIdleMs : undefined,
      burstStaggerMs: workloadMode === "bursty" ? burstStaggerMs : undefined,
      reportDir,
      results,
    },
    null,
    2,
  ),
);
