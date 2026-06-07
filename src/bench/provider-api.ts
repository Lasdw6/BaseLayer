import fs from "node:fs";
import path from "node:path";

import { chromium } from "playwright-core";

import {
  getBrowserArenaPageGotoWaitUntil,
  getBrowserArenaPageUrl,
  pageNavigationExpectsBenchReadyMarker,
} from "./lib/browserarena.js";
import { collectBenchmarkRunMetadataFromEnv } from "./lib/bench-metadata.js";
import { collectNavigationMetricsFromPage } from "./lib/harness.js";
import { metricStatsFull } from "./lib/stats.js";
import { type BenchmarkRunMetadata, type LatencyMetricStats, type NavigationMetricsSnapshot } from "./lib/types.js";

interface ProviderSessionResponse {
  sessionId: string;
  status: string;
  hostId: string;
  connectUrl: string;
  cdpUrl: string;
  playwrightUrl: string;
  puppeteerUrl: string;
  debugHttpUrl: string;
  expiresAt: string;
  createdAt: string;
  launchTimings?: {
    totalMs: number;
    cdpReadyMs?: number;
    processSpawnMs?: number;
    configureMs?: number;
    relayReadyMs?: number;
    networkSetupMs?: number;
    networkClaimMs?: number;
    networkValidateMs?: number;
  };
  controlPlaneTimings?: {
    create?: {
      totalMs: number;
      requestValidationMs?: number;
      schedulerMs?: number;
      nodeAgentCreateMs?: number;
      persistMs?: number;
      responseBuildMs?: number;
    };
    delete?: {
      totalMs: number;
      remoteDeleteMs?: number;
      persistMs?: number;
      async: boolean;
    };
  };
}

interface ProviderCallTimingHeaders {
  createServerTiming?: string;
  deleteServerTiming?: string;
}

interface IterationResult {
  wave: number;
  slot: number;
  sessionId?: string;
  session_creation_ms: number;
  session_create_runtime_ms?: number;
  session_create_transport_overhead_ms?: number;
  session_connect_ms: number;
  page_goto_ms: number;
  session_release_ms: number;
  total_ms: number;
  control_plane_create_ms?: number;
  control_plane_request_validation_ms?: number;
  control_plane_scheduler_ms?: number;
  control_plane_node_agent_create_ms?: number;
  control_plane_persist_ms?: number;
  control_plane_response_build_ms?: number;
  provider_call_timing_headers?: ProviderCallTimingHeaders;
  ok: boolean;
  /** From Playwright after CDP connect (when ok). */
  browserVersion?: string;
  /** DOM / PerformanceNavigationTiming snapshot after `page.goto` (real URLs). */
  navigationMetrics?: NavigationMetricsSnapshot;
  error?: string;
  logs?: string[];
}

const apiUrl = (process.env["BASELAYER_API_URL"] ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const runs = Number.parseInt(process.env["BENCH_RUNS"] ?? process.env["BENCH_ITERATIONS"] ?? "5", 10);
const concurrency = Number.parseInt(process.env["BENCH_CONCURRENCY"] ?? "1", 10);
const requestedConcurrencyValues = (process.env["BENCH_CONCURRENCY_VALUES"] ?? "")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0);
const matrixDefaultRuns = Number.parseInt(
  process.env["BENCH_MATRIX_RUNS"] ?? process.env["BENCH_RUNS_DEFAULT"] ?? "1",
  10,
);
const matrixSingleRuns = Number.parseInt(
  process.env["BENCH_MATRIX_C1_RUNS"] ?? process.env["BENCH_RUNS_C1"] ?? String(runs),
  10,
);
const timeoutSec = Number.parseInt(process.env["BENCH_SESSION_TIMEOUT_SEC"] ?? "300", 10);
const idleTimeoutSec = Number.parseInt(process.env["BENCH_SESSION_IDLE_TIMEOUT_SEC"] ?? "60", 10);
const createTimeoutMs = Number.parseInt(process.env["BENCH_CREATE_TIMEOUT_MS"] ?? "120000", 10);
const browser = process.env["BASELAYER_BROWSER"] ?? "chromium";
const runtimeProfile = process.env["BASELAYER_RUNTIME_PROFILE"];
const region = process.env["BASELAYER_REGION"];
const proxyProfile = process.env["BASELAYER_PROXY_PROFILE"];
const upstreamProvider = process.env["BASELAYER_UPSTREAM_PROVIDER"] ?? "provider-bench";
const providerTenantId = process.env["BASELAYER_PROVIDER_TENANT_ID"];
const providerProjectId = process.env["BASELAYER_PROVIDER_PROJECT_ID"];
const providerWorkloadClass =
  process.env["BASELAYER_PROVIDER_WORKLOAD_CLASS"] ?? "browserarena-like";
const sessionTagsRaw = process.env["BASELAYER_SESSION_TAGS_JSON"];
const sessionTags = sessionTagsRaw ? JSON.parse(sessionTagsRaw) as Record<string, string> : undefined;
const outputPath =
  process.env["BENCH_OUT"] ??
  path.join(process.cwd(), "data", "benchmarks", `provider-api-${Date.now()}.json`);
const benchmarkName =
  requestedConcurrencyValues.length > 0 ? "provider-api-matrix" : "provider-api";

const PROVIDER_BENCH_SCHEMA = "browserarena-stages-v2";

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return 0;
  }
  const index = (sorted.length - 1) * 0.5;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower] ?? 0;
  }
  return (sorted[lower] ?? 0) + ((sorted[upper] ?? 0) - (sorted[lower] ?? 0)) * (index - lower);
}

function createTimeoutSignal(): AbortSignal | undefined {
  if (!Number.isFinite(createTimeoutMs) || createTimeoutMs <= 0) {
    return undefined;
  }
  return AbortSignal.timeout(createTimeoutMs);
}

interface BenchmarkSummary {
  benchmark: string;
  schema: string;
  apiUrl: string;
  pageUrl: string;
  pageGotoWaitUntil: string;
  runs: number;
  concurrency: number;
  browser: string;
  runtimeProfile?: string;
  region?: string;
  proxyProfile?: string;
  successCount: number;
  failureCount: number;
  successRate: number;
  api_health_rtt_ms: LatencyMetricStats;
  session_creation_ms: LatencyMetricStats;
  session_create_runtime_ms: LatencyMetricStats;
  session_create_transport_overhead_ms: LatencyMetricStats;
  control_plane_create_ms?: LatencyMetricStats;
  control_plane_request_validation_ms?: LatencyMetricStats;
  control_plane_scheduler_ms?: LatencyMetricStats;
  control_plane_node_agent_create_ms?: LatencyMetricStats;
  control_plane_persist_ms?: LatencyMetricStats;
  control_plane_response_build_ms?: LatencyMetricStats;
  session_connect_ms: LatencyMetricStats;
  page_goto_ms: LatencyMetricStats;
  session_release_ms: LatencyMetricStats;
  total_ms: LatencyMetricStats;
  /** Mean first-contentful-paint (ms) across successful iterations when the browser exposed it. */
  firstContentfulPaintMs?: LatencyMetricStats;
  runMetadata?: BenchmarkRunMetadata;
  iterations: IterationResult[];
  /**
   * Median of each lifecycle phase for quick A/B. `total_ms` is the sum of the
   * phase p50 values, matching BrowserArena-style leaderboard breakdown math;
   * the raw per-iteration total distribution remains in the top-level
   * `total_ms` metric.
   */
  phaseSummaryP50: {
    session_creation_ms: number;
    session_create_runtime_ms: number;
    session_create_transport_overhead_ms: number;
    control_plane_create_ms?: number;
    control_plane_request_validation_ms?: number;
    control_plane_scheduler_ms?: number;
    control_plane_node_agent_create_ms?: number;
    control_plane_persist_ms?: number;
    control_plane_response_build_ms?: number;
    session_connect_ms: number;
    page_goto_ms: number;
    session_release_ms: number;
    total_ms: number;
    total_iteration_ms?: number;
  };
  /** Full distribution for PerformanceNavigationTiming-derived segments (real URLs). */
  navigationBreakdown?: {
    dnsLookupMs?: LatencyMetricStats;
    tcpConnectMs?: LatencyMetricStats;
    tlsMs?: LatencyMetricStats;
    requestToResponseMs?: LatencyMetricStats;
    responseToDomContentLoadedMs?: LatencyMetricStats;
  };
  /** Median navigation segments when available (isolates DNS/TLS vs DOM for page_goto). */
  navigationBreakdownP50?: {
    dnsLookupMs?: number;
    tcpConnectMs?: number;
    tlsMs?: number;
    requestToResponseMs?: number;
    responseToDomContentLoadedMs?: number;
  };
}

async function createSession(wave: number, slot: number): Promise<{
  session: ProviderSessionResponse;
  createMs: number;
  createServerTiming?: string;
}> {
  const started = performance.now();
  const response = await fetch(`${apiUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: createTimeoutSignal(),
    body: JSON.stringify({
      browser,
      keepAlive: false,
      timeoutSec,
      idleTimeoutSec,
      ...(runtimeProfile ? { runtimeProfile } : {}),
      ...(region ? { region } : {}),
      ...(proxyProfile ? { proxyProfile } : {}),
      provider: {
        upstreamProvider,
        providerSessionId: `${upstreamProvider}-wave${wave}-slot${slot}`,
        ...(providerTenantId ? { tenantId: providerTenantId } : {}),
        ...(providerProjectId ? { projectId: providerProjectId } : {}),
        ...(providerWorkloadClass ? { workloadClass: providerWorkloadClass } : {}),
      },
      sessionTags: {
        provider: "external-bench",
        benchmark: "browserarena-like",
        wave: String(wave),
        slot: String(slot),
        ...(sessionTags ?? {}),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`session-create failed: ${response.status} ${await response.text()}`);
  }
  return {
    session: (await response.json()) as ProviderSessionResponse,
    createMs: performance.now() - started,
    createServerTiming: response.headers.get("server-timing") ?? undefined,
  };
}

async function fetchSessionLogs(sessionId: string): Promise<string[]> {
  try {
    const response = await fetch(`${apiUrl}/v1/sessions/${sessionId}/logs`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return [];
    }
    const payload = await response.json() as {
      logs?: { lines?: string[] };
    };
    return payload.logs?.lines ?? [];
  } catch {
    return [];
  }
}

async function deleteSession(sessionId: string): Promise<{
  releaseMs: number;
  deleteServerTiming?: string;
}> {
  const started = performance.now();
  const response = await fetch(`${apiUrl}/v1/sessions/${sessionId}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`session-delete failed: ${response.status} ${await response.text()}`);
  }
  return {
    releaseMs: performance.now() - started,
    deleteServerTiming: response.headers.get("server-timing") ?? undefined,
  };
}

async function runIteration(wave: number, slot: number): Promise<IterationResult> {
  let session: ProviderSessionResponse | undefined;
  let browserConnection: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  const started = performance.now();
  let session_creation_ms = 0;
  let session_connect_ms = 0;
  let page_goto_ms = 0;
  let session_release_ms = 0;

  try {
    const created = await createSession(wave, slot);
    session = created.session;
    session_creation_ms = created.createMs;
    const providerCallTimingHeaders: ProviderCallTimingHeaders = {
      createServerTiming: created.createServerTiming,
    };

    const connectStarted = performance.now();
    browserConnection = await chromium.connectOverCDP(session.playwrightUrl, {
      timeout: 30_000,
    });
    session_connect_ms = performance.now() - connectStarted;

    const browserVersion = await browserConnection.version();
    const pageUrl = getBrowserArenaPageUrl();
    const awaitBenchReady = pageNavigationExpectsBenchReadyMarker(pageUrl);
    const gotoStarted = performance.now();
    const context = browserConnection.contexts()[0] ?? (await browserConnection.newContext());
    const page = await context.newPage();
    await page.goto(pageUrl, {
      waitUntil: getBrowserArenaPageGotoWaitUntil(),
      timeout: 60_000,
    });
    if (awaitBenchReady) {
      await page.waitForFunction(
        () => (window as { __baselayerBenchReady?: boolean }).__baselayerBenchReady === true,
        null,
        { timeout: 15_000 },
      );
    }
    await page.title().catch(() => undefined);
    page_goto_ms = performance.now() - gotoStarted;
    const navigationMetrics = await collectNavigationMetricsFromPage(page);

    await browserConnection.close();
    browserConnection = undefined;

    const deleted = await deleteSession(session.sessionId);
    session_release_ms = deleted.releaseMs;
    providerCallTimingHeaders.deleteServerTiming = deleted.deleteServerTiming;
    return {
      wave,
      slot,
      sessionId: session.sessionId,
      session_creation_ms,
      session_create_runtime_ms: session.launchTimings?.totalMs,
      session_create_transport_overhead_ms:
        typeof session.launchTimings?.totalMs === "number"
          ? Math.max(0, session_creation_ms - session.launchTimings.totalMs)
          : undefined,
      session_connect_ms,
      page_goto_ms,
      session_release_ms,
      control_plane_create_ms: session.controlPlaneTimings?.create?.totalMs,
      control_plane_request_validation_ms: session.controlPlaneTimings?.create?.requestValidationMs,
      control_plane_scheduler_ms: session.controlPlaneTimings?.create?.schedulerMs,
      control_plane_node_agent_create_ms: session.controlPlaneTimings?.create?.nodeAgentCreateMs,
      control_plane_persist_ms: session.controlPlaneTimings?.create?.persistMs,
      control_plane_response_build_ms: session.controlPlaneTimings?.create?.responseBuildMs,
      provider_call_timing_headers: providerCallTimingHeaders,
      total_ms:
        session_creation_ms + session_connect_ms + page_goto_ms + session_release_ms,
      ok: true,
      browserVersion,
      navigationMetrics,
    };
  } catch (error) {
    const logs = session?.sessionId ? await fetchSessionLogs(session.sessionId) : [];
    if (session?.sessionId) {
      try {
        if (session_release_ms === 0) {
          const deleted = await deleteSession(session.sessionId);
          session_release_ms = deleted.releaseMs;
        }
      } catch {
        // ignore cleanup failure in benchmark result
      }
    }
    return {
      wave,
      slot,
      sessionId: session?.sessionId,
      session_creation_ms,
      session_create_runtime_ms: session?.launchTimings?.totalMs,
      session_create_transport_overhead_ms:
        typeof session?.launchTimings?.totalMs === "number"
          ? Math.max(0, session_creation_ms - session.launchTimings.totalMs)
          : undefined,
      session_connect_ms,
      page_goto_ms,
      session_release_ms,
      control_plane_create_ms: session?.controlPlaneTimings?.create?.totalMs,
      control_plane_request_validation_ms: session?.controlPlaneTimings?.create?.requestValidationMs,
      control_plane_scheduler_ms: session?.controlPlaneTimings?.create?.schedulerMs,
      control_plane_node_agent_create_ms: session?.controlPlaneTimings?.create?.nodeAgentCreateMs,
      control_plane_persist_ms: session?.controlPlaneTimings?.create?.persistMs,
      control_plane_response_build_ms: session?.controlPlaneTimings?.create?.responseBuildMs,
      total_ms: performance.now() - started,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      logs,
    };
  } finally {
    await browserConnection?.close().catch(() => undefined);
  }
}

function metricStatsOptional(
  successful: IterationResult[],
  pick: (item: IterationResult) => number | undefined,
): LatencyMetricStats | undefined {
  const vals = successful
    .map((item) => pick(item))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (vals.length === 0) {
    return undefined;
  }
  return metricStatsFull(vals);
}

async function collectApiHealthRtts(): Promise<number[]> {
  const apiHealthRtts: number[] = [];
  for (let sample = 0; sample < 3; sample += 1) {
    const started = performance.now();
    const response = await fetch(`${apiUrl}/v1/health`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      apiHealthRtts.push(performance.now() - started);
    }
  }
  return apiHealthRtts;
}

function summarizeIterations(
  summaryRuns: number,
  summaryConcurrency: number,
  apiHealthRtts: number[],
  iterations: IterationResult[],
  runMetadata: BenchmarkRunMetadata,
): BenchmarkSummary {
  const successful = iterations.filter((item) => item.ok);

  const fcpVals = successful
    .map((item) => item.navigationMetrics?.firstContentfulPaintMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const apiHealth = metricStatsFull(apiHealthRtts);
  const sessionCreation = metricStatsFull(successful.map((item) => item.session_creation_ms));
  const sessionCreateRuntime = metricStatsFull(
    successful
      .map((item) => item.session_create_runtime_ms)
      .filter((value): value is number => typeof value === "number"),
  );
  const sessionCreateTransport = metricStatsFull(
    successful
      .map((item) => item.session_create_transport_overhead_ms)
      .filter((value): value is number => typeof value === "number"),
  );
  const controlPlaneCreate = metricStatsOptional(successful, (item) => item.control_plane_create_ms);
  const controlPlaneRequestValidation = metricStatsOptional(
    successful,
    (item) => item.control_plane_request_validation_ms,
  );
  const controlPlaneScheduler = metricStatsOptional(successful, (item) => item.control_plane_scheduler_ms);
  const controlPlaneNodeAgentCreate = metricStatsOptional(
    successful,
    (item) => item.control_plane_node_agent_create_ms,
  );
  const controlPlanePersist = metricStatsOptional(successful, (item) => item.control_plane_persist_ms);
  const controlPlaneResponseBuild = metricStatsOptional(
    successful,
    (item) => item.control_plane_response_build_ms,
  );
  const sessionConnect = metricStatsFull(successful.map((item) => item.session_connect_ms));
  const pageGoto = metricStatsFull(successful.map((item) => item.page_goto_ms));
  const sessionRelease = metricStatsFull(successful.map((item) => item.session_release_ms));
  const totalMs = metricStatsFull(successful.map((item) => item.total_ms));
  const phaseSummarySessionCreation = median(successful.map((item) => item.session_creation_ms));
  const phaseSummarySessionConnect = median(successful.map((item) => item.session_connect_ms));
  const phaseSummaryPageGoto = median(successful.map((item) => item.page_goto_ms));
  const phaseSummarySessionRelease = median(successful.map((item) => item.session_release_ms));

  const dnsLookup = metricStatsOptional(successful, (item) => item.navigationMetrics?.dnsLookupMs);
  const tcpConnect = metricStatsOptional(successful, (item) => item.navigationMetrics?.tcpConnectMs);
  const tls = metricStatsOptional(successful, (item) => item.navigationMetrics?.tlsMs);
  const requestToResponse = metricStatsOptional(
    successful,
    (item) => item.navigationMetrics?.requestToResponseMs,
  );
  const responseToDomContentLoaded = metricStatsOptional(
    successful,
    (item) => item.navigationMetrics?.responseToDomContentLoadedMs,
  );

  const navigationBreakdown: NonNullable<BenchmarkSummary["navigationBreakdown"]> = {};
  if (dnsLookup) {
    navigationBreakdown.dnsLookupMs = dnsLookup;
  }
  if (tcpConnect) {
    navigationBreakdown.tcpConnectMs = tcpConnect;
  }
  if (tls) {
    navigationBreakdown.tlsMs = tls;
  }
  if (requestToResponse) {
    navigationBreakdown.requestToResponseMs = requestToResponse;
  }
  if (responseToDomContentLoaded) {
    navigationBreakdown.responseToDomContentLoadedMs = responseToDomContentLoaded;
  }
  const hasNavBreakdown = Object.keys(navigationBreakdown).length > 0;
  const phaseSummaryTotalMs =
    phaseSummarySessionCreation +
    phaseSummarySessionConnect +
    phaseSummaryPageGoto +
    phaseSummarySessionRelease;

  return {
    benchmark: "provider-api",
    schema: PROVIDER_BENCH_SCHEMA,
    apiUrl,
    pageUrl: getBrowserArenaPageUrl(),
    pageGotoWaitUntil: getBrowserArenaPageGotoWaitUntil(),
    runs: summaryRuns,
    concurrency: summaryConcurrency,
    browser,
    runtimeProfile,
    region,
    proxyProfile,
    successCount: successful.length,
    failureCount: iterations.length - successful.length,
    successRate: iterations.length === 0 ? 0 : successful.length / iterations.length,
    api_health_rtt_ms: apiHealth,
    session_creation_ms: sessionCreation,
    session_create_runtime_ms: sessionCreateRuntime,
    session_create_transport_overhead_ms: sessionCreateTransport,
    control_plane_create_ms: controlPlaneCreate,
    control_plane_request_validation_ms: controlPlaneRequestValidation,
    control_plane_scheduler_ms: controlPlaneScheduler,
    control_plane_node_agent_create_ms: controlPlaneNodeAgentCreate,
    control_plane_persist_ms: controlPlanePersist,
    control_plane_response_build_ms: controlPlaneResponseBuild,
    session_connect_ms: sessionConnect,
    page_goto_ms: pageGoto,
    session_release_ms: sessionRelease,
    total_ms: totalMs,
    firstContentfulPaintMs: fcpVals.length > 0 ? metricStatsFull(fcpVals) : undefined,
    runMetadata,
    iterations,
    phaseSummaryP50: {
      session_creation_ms: phaseSummarySessionCreation,
      session_create_runtime_ms: sessionCreateRuntime.p50,
      session_create_transport_overhead_ms: sessionCreateTransport.p50,
      ...(controlPlaneCreate && { control_plane_create_ms: controlPlaneCreate.p50 }),
      ...(controlPlaneRequestValidation && {
        control_plane_request_validation_ms: controlPlaneRequestValidation.p50,
      }),
      ...(controlPlaneScheduler && { control_plane_scheduler_ms: controlPlaneScheduler.p50 }),
      ...(controlPlaneNodeAgentCreate && {
        control_plane_node_agent_create_ms: controlPlaneNodeAgentCreate.p50,
      }),
      ...(controlPlanePersist && { control_plane_persist_ms: controlPlanePersist.p50 }),
      ...(controlPlaneResponseBuild && {
        control_plane_response_build_ms: controlPlaneResponseBuild.p50,
      }),
      session_connect_ms: phaseSummarySessionConnect,
      page_goto_ms: phaseSummaryPageGoto,
      session_release_ms: phaseSummarySessionRelease,
      total_ms: phaseSummaryTotalMs,
      total_iteration_ms: totalMs.p50,
    },
    ...(hasNavBreakdown
      ? {
          navigationBreakdown,
          navigationBreakdownP50: {
            ...(dnsLookup && { dnsLookupMs: dnsLookup.p50 }),
            ...(tcpConnect && { tcpConnectMs: tcpConnect.p50 }),
            ...(tls && { tlsMs: tls.p50 }),
            ...(requestToResponse && { requestToResponseMs: requestToResponse.p50 }),
            ...(responseToDomContentLoaded && {
              responseToDomContentLoadedMs: responseToDomContentLoaded.p50,
            }),
          },
        }
      : {}),
  };
}

async function runBenchmark(summaryRuns: number, summaryConcurrency: number): Promise<BenchmarkSummary> {
  const runMetadata = await collectBenchmarkRunMetadataFromEnv(
    process.env["BENCH_METADATA_PROFILE_ID"]?.trim() || undefined,
  );
  const iterations: IterationResult[] = [];
  const apiHealthRtts = await collectApiHealthRtts();

  for (let wave = 1; wave <= summaryRuns; wave += 1) {
    const results = await Promise.all(
      Array.from({ length: summaryConcurrency }, (_, index) => runIteration(wave, index + 1)),
    );
    iterations.push(...results);
  }

  return summarizeIterations(summaryRuns, summaryConcurrency, apiHealthRtts, iterations, runMetadata);
}

function printPhaseSummariesIfRequested(
  payload:
    | BenchmarkSummary
    | {
        benchmark: string;
        schema: string;
        apiUrl: string;
        pageUrl: string;
        pageGotoWaitUntil: string;
        browser: string;
        runtimeProfile?: string;
        region?: string;
        proxyProfile?: string;
        results: BenchmarkSummary[];
      },
): void {
  if (process.env["BENCH_PRINT_PHASE_SUMMARY"] !== "1") {
    return;
  }
  const printOne = (summary: BenchmarkSummary): void => {
    const p = summary.phaseSummaryP50;
    const profile = summary.runtimeProfile ?? "(default)";
    console.error(
      `[bench] phaseSummaryP50 c=${summary.concurrency} profile=${profile} ` +
        `create=${p.session_creation_ms.toFixed(0)} ` +
        `(runtime=${p.session_create_runtime_ms.toFixed(0)} transport=${p.session_create_transport_overhead_ms.toFixed(0)}) ` +
        (p.control_plane_create_ms !== undefined
          ? `(cp=${p.control_plane_create_ms.toFixed(0)} sched=${(p.control_plane_scheduler_ms ?? 0).toFixed(0)} agent=${(p.control_plane_node_agent_create_ms ?? 0).toFixed(0)}) `
          : "") +
        `connect=${p.session_connect_ms.toFixed(0)} goto=${p.page_goto_ms.toFixed(0)} ` +
        `release=${p.session_release_ms.toFixed(0)} total=${p.total_ms.toFixed(0)}`,
    );
    const n = summary.navigationBreakdownP50;
    if (n && Object.keys(n).length > 0) {
      const parts: string[] = [];
      if (n.dnsLookupMs !== undefined) {
        parts.push(`dns=${n.dnsLookupMs.toFixed(0)}`);
      }
      if (n.tcpConnectMs !== undefined) {
        parts.push(`tcp=${n.tcpConnectMs.toFixed(0)}`);
      }
      if (n.tlsMs !== undefined) {
        parts.push(`tls=${n.tlsMs.toFixed(0)}`);
      }
      if (n.requestToResponseMs !== undefined) {
        parts.push(`req_to_resp=${n.requestToResponseMs.toFixed(0)}`);
      }
      if (n.responseToDomContentLoadedMs !== undefined) {
        parts.push(`resp_to_dcl=${n.responseToDomContentLoadedMs.toFixed(0)}`);
      }
      if (parts.length > 0) {
        console.error(`[bench] navigationBreakdownP50 c=${summary.concurrency} profile=${profile} ${parts.join(" ")}`);
      }
    }
  };
  if ("results" in payload && Array.isArray(payload.results)) {
    for (const row of payload.results) {
      printOne(row);
    }
  } else {
    printOne(payload as BenchmarkSummary);
  }
}

async function main(): Promise<void> {
  let payload: BenchmarkSummary | {
    benchmark: string;
    schema: string;
    apiUrl: string;
    pageUrl: string;
    pageGotoWaitUntil: string;
    browser: string;
    runtimeProfile?: string;
    region?: string;
    proxyProfile?: string;
    results: BenchmarkSummary[];
  };

  if (requestedConcurrencyValues.length > 0) {
    const results: BenchmarkSummary[] = [];
    for (const requestedConcurrency of requestedConcurrencyValues) {
      const runCount = requestedConcurrency === 1 ? matrixSingleRuns : matrixDefaultRuns;
      results.push(await runBenchmark(runCount, requestedConcurrency));
    }

    payload = {
      benchmark: benchmarkName,
      schema: PROVIDER_BENCH_SCHEMA,
      apiUrl,
      pageUrl: getBrowserArenaPageUrl(),
      pageGotoWaitUntil: getBrowserArenaPageGotoWaitUntil(),
      browser,
      runtimeProfile,
      region,
      proxyProfile,
      results,
    };
  } else {
    payload = await runBenchmark(runs, concurrency);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  printPhaseSummariesIfRequested(payload);
  console.log(JSON.stringify({ outputPath, ...payload }, null, 2));
}

await main();
