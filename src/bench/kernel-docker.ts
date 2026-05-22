import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { chromium } from "playwright-core";

import { getBrowserArenaPageGotoWaitUntil, getBrowserArenaPageUrl } from "./lib/browserarena.js";
import { average, percentile } from "./lib/stats.js";

const execFileAsync = promisify(execFile);

interface IterationResult {
  wave: number;
  slot: number;
  containerName: string;
  debugHttpUrl: string;
  session_creation_ms: number;
  session_connect_ms: number;
  page_goto_ms: number;
  session_release_ms: number;
  total_ms: number;
  ok: boolean;
  error?: string;
}

interface BenchmarkSummary {
  benchmark: string;
  schema: string;
  image: string;
  pageUrl: string;
  pageGotoWaitUntil: string;
  runs: number;
  concurrency: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  session_creation_ms: { avg: number; p50: number; p95: number };
  session_connect_ms: { avg: number; p50: number; p95: number };
  page_goto_ms: { avg: number; p50: number; p95: number };
  session_release_ms: { avg: number; p50: number; p95: number };
  total_ms: { avg: number; p50: number; p95: number };
  iterations: IterationResult[];
}

const image = process.env["KERNEL_IMAGE"] ?? "kernel-chromium-headless";
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
const outputPath =
  process.env["BENCH_OUT"] ??
  path.join(process.cwd(), "data", "benchmarks", `kernel-docker-${Date.now()}.json`);
const benchmarkName =
  requestedConcurrencyValues.length > 0 ? "kernel-docker-matrix" : "kernel-docker";
const baseCdpPort = Number.parseInt(process.env["KERNEL_BASE_CDP_PORT"] ?? "9222", 10);
const baseRelayPort = Number.parseInt(process.env["KERNEL_BASE_RELAY_PORT"] ?? "19222", 10);
const baseApiPort = Number.parseInt(process.env["KERNEL_BASE_API_PORT"] ?? "10001", 10);
const pageTimeoutMs = Number.parseInt(process.env["BENCH_PAGE_TIMEOUT_MS"] ?? "60000", 10);
const createTimeoutMs = Number.parseInt(process.env["BENCH_CREATE_TIMEOUT_MS"] ?? "120000", 10);
const connectTimeoutMs = Number.parseInt(process.env["BENCH_CONNECT_TIMEOUT_MS"] ?? "30000", 10);
const releaseTimeoutMs = Number.parseInt(process.env["BENCH_RELEASE_TIMEOUT_MS"] ?? "30000", 10);
const dockerTmpfsShm = process.env["KERNEL_DOCKER_TMPFS_SHM"] ?? "2g";

function stats(values: number[]): { avg: number; p50: number; p95: number } {
  return {
    avg: average(values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
  };
}

async function docker(args: string[], timeoutMs = createTimeoutMs): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    windowsHide: true,
    timeout: timeoutMs,
  });
  return stdout.trim();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJsonVersion(debugHttpUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${debugHttpUrl}/json/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const payload = await response.json() as { webSocketDebuggerUrl?: string };
        if (payload.webSocketDebuggerUrl) {
          return;
        }
      }
    } catch {
      // retry
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for Kernel CDP at ${debugHttpUrl}/json/version`);
}

async function removeContainer(containerName: string): Promise<void> {
  try {
    await docker(["rm", "-f", containerName], releaseTimeoutMs);
  } catch {
    // ignore if already gone
  }
}

async function startContainer(containerName: string, cdpPort: number, apiPort: number): Promise<string> {
  const relayPort = baseRelayPort + (cdpPort - baseCdpPort);
  await removeContainer(containerName);
  await docker(
    [
      "run",
      "-d",
      "--name",
      containerName,
      "--privileged",
      "--tmpfs",
      `/dev/shm:size=${dockerTmpfsShm}`,
      "-p",
      `${cdpPort}:9222`,
      "-p",
      `${relayPort}:9224`,
      "-p",
      `${apiPort}:10001`,
      image,
    ],
    createTimeoutMs,
  );
  return `http://127.0.0.1:${cdpPort}`;
}

async function runIteration(wave: number, slot: number): Promise<IterationResult> {
  const containerName = `kernel-bench-${Date.now()}-${wave}-${slot}`;
  const cdpPort = baseCdpPort + (wave - 1) * 100 + slot - 1;
  const apiPort = baseApiPort + (wave - 1) * 100 + slot - 1;
  const debugHttpUrl = `http://127.0.0.1:${cdpPort}`;
  const started = performance.now();
  let session_creation_ms = 0;
  let session_connect_ms = 0;
  let page_goto_ms = 0;
  let session_release_ms = 0;
  let browserConnection: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;

  try {
    const createStarted = performance.now();
    await startContainer(containerName, cdpPort, apiPort);
    await waitForJsonVersion(debugHttpUrl, createTimeoutMs);
    session_creation_ms = performance.now() - createStarted;

    const connectStarted = performance.now();
    browserConnection = await chromium.connectOverCDP(debugHttpUrl, {
      timeout: connectTimeoutMs,
    });
    session_connect_ms = performance.now() - connectStarted;

    const context = browserConnection.contexts()[0] ?? (await browserConnection.newContext());
    const page = await context.newPage();
    const gotoStarted = performance.now();
    await page.goto(getBrowserArenaPageUrl(), {
      waitUntil: getBrowserArenaPageGotoWaitUntil(),
      timeout: pageTimeoutMs,
    });
    await page.title().catch(() => undefined);
    page_goto_ms = performance.now() - gotoStarted;

    const releaseStarted = performance.now();
    await browserConnection.close().catch(() => undefined);
    browserConnection = undefined;
    await removeContainer(containerName);
    session_release_ms = performance.now() - releaseStarted;

    return {
      wave,
      slot,
      containerName,
      debugHttpUrl,
      session_creation_ms,
      session_connect_ms,
      page_goto_ms,
      session_release_ms,
      total_ms: session_creation_ms + session_connect_ms + page_goto_ms + session_release_ms,
      ok: true,
    };
  } catch (error) {
    try {
      await browserConnection?.close().catch(() => undefined);
      const releaseStarted = performance.now();
      await removeContainer(containerName);
      session_release_ms = performance.now() - releaseStarted;
    } catch {
      // ignore
    }

    return {
      wave,
      slot,
      containerName,
      debugHttpUrl,
      session_creation_ms,
      session_connect_ms,
      page_goto_ms,
      session_release_ms,
      total_ms: performance.now() - started,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeIterations(summaryRuns: number, summaryConcurrency: number, iterations: IterationResult[]): BenchmarkSummary {
  const successful = iterations.filter((item) => item.ok);
  return {
    benchmark: "kernel-docker",
    schema: "browserarena-stages-v1",
    image,
    pageUrl: getBrowserArenaPageUrl(),
    pageGotoWaitUntil: getBrowserArenaPageGotoWaitUntil(),
    runs: summaryRuns,
    concurrency: summaryConcurrency,
    successCount: successful.length,
    failureCount: iterations.length - successful.length,
    successRate: iterations.length === 0 ? 0 : successful.length / iterations.length,
    session_creation_ms: stats(successful.map((item) => item.session_creation_ms)),
    session_connect_ms: stats(successful.map((item) => item.session_connect_ms)),
    page_goto_ms: stats(successful.map((item) => item.page_goto_ms)),
    session_release_ms: stats(successful.map((item) => item.session_release_ms)),
    total_ms: stats(successful.map((item) => item.total_ms)),
    iterations,
  };
}

async function runBenchmark(summaryRuns: number, summaryConcurrency: number): Promise<BenchmarkSummary> {
  const iterations: IterationResult[] = [];
  for (let wave = 1; wave <= summaryRuns; wave += 1) {
    const results = await Promise.all(
      Array.from({ length: summaryConcurrency }, (_, index) => runIteration(wave, index + 1)),
    );
    iterations.push(...results);
  }
  return summarizeIterations(summaryRuns, summaryConcurrency, iterations);
}

async function main(): Promise<void> {
  let payload: BenchmarkSummary | {
    benchmark: string;
    schema: string;
    image: string;
    pageUrl: string;
    pageGotoWaitUntil: string;
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
      schema: "browserarena-stages-v1",
      image,
      pageUrl: getBrowserArenaPageUrl(),
      pageGotoWaitUntil: getBrowserArenaPageGotoWaitUntil(),
      results,
    };
  } else {
    payload = await runBenchmark(runs, concurrency);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ outputPath, ...payload }, null, 2));
}

await main();
