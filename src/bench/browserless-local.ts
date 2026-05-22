import { setTimeout as sleep } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { chromium } from "playwright-core";

import { startBenchSite } from "./lib/site.js";
import { average, percentile } from "./lib/stats.js";

const execFileAsync = promisify(execFile);
const iterations = Number.parseInt(process.env["BENCH_ITERATIONS"] ?? "5", 10);
const warmupIterations = Number.parseInt(process.env["BENCH_WARMUP_ITERATIONS"] ?? "1", 10);
const maxConcurrency = Number.parseInt(process.env["BENCH_MAX_CONCURRENCY"] ?? "4", 10);
const soakSeconds = Number.parseInt(process.env["BENCH_SOAK_SECONDS"] ?? "10", 10);
const activeSessionRatio = Number.parseFloat(process.env["BENCH_ACTIVE_SESSION_RATIO"] ?? "0.5");
const activeRoundsPerSession = Number.parseInt(
  process.env["BENCH_ACTIVE_ROUNDS_PER_SESSION"] ?? "3",
  10,
);
const activePauseMs = Number.parseInt(process.env["BENCH_ACTIVE_PAUSE_MS"] ?? "500", 10);
const containerName = process.env["BROWSERLESS_CONTAINER_NAME"] ?? "browserless-bench";
const image = process.env["BROWSERLESS_IMAGE"] ?? "ghcr.io/browserless/chromium";
const port = Number.parseInt(process.env["BROWSERLESS_PORT"] ?? "3900", 10);
const configuredConcurrency = process.env["BROWSERLESS_CONCURRENT"] ?? "4";

const activeVariants = ["1", "2", "3"] as const;
async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    windowsHide: true,
  });
  return stdout.trim();
}

async function cleanup(): Promise<void> {
  try {
    const ids = await docker(["ps", "-aq", "--filter", `name=${containerName}`]);
    for (const id of ids.split(/\r?\n/).filter(Boolean)) {
      await docker(["rm", "-f", id]);
    }
  } catch {
    // ignore cleanup failures
  }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(500);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function startBrowserless(): Promise<void> {
  await cleanup();
  await docker([
    "run",
    "-d",
    "--rm",
    "--name",
    containerName,
    "-p",
    `${port}:3000`,
    "--add-host",
    "host.docker.internal:host-gateway",
    "-e",
    `CONCURRENT=${configuredConcurrency}`,
    image,
  ]);
  await waitForHttp(`http://127.0.0.1:${port}/docs`, 60_000);
}

async function stopBrowserless(): Promise<void> {
  await cleanup();
}

async function exerciseSession(
  pageUrl: string,
  activeUrls: string[],
  isActive: boolean,
): Promise<{ connectMs: number; navigateMs: number; soakActionSuccesses: number; soakActionFailures: number }> {
  const connectStarted = performance.now();
  const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}`);
  const connectMs = performance.now() - connectStarted;

  let soakActionSuccesses = 0;
  let soakActionFailures = 0;
  let navigateMs = 0;

  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    const navigateStarted = performance.now();
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => (window as { __baselayerBenchReady?: boolean }).__baselayerBenchReady === true,
      null,
      { timeout: 15_000 },
    );
    await page.title();
    navigateMs = performance.now() - navigateStarted;

    if (isActive) {
      for (let round = 0; round < activeRoundsPerSession; round += 1) {
        const nextUrl = activeUrls[round % activeUrls.length]!;
        try {
          await page.goto(nextUrl, { waitUntil: "domcontentloaded" });
          await page.waitForFunction(
            () => (window as { __baselayerBenchReady?: boolean }).__baselayerBenchReady === true,
            null,
            { timeout: 15_000 },
          );
          await page.title();
          soakActionSuccesses += 1;
        } catch {
          soakActionFailures += 1;
        }

        if (round + 1 < activeRoundsPerSession) {
          await sleep(activePauseMs);
        }
      }
    } else {
      await sleep(soakSeconds * 1000);
    }

    return { connectMs, navigateMs, soakActionSuccesses, soakActionFailures };
  } finally {
    await browser.close();
  }
}

async function runSingleSession(pageUrl: string): Promise<{ connectMs: number; navigateMs: number }> {
  const connectStarted = performance.now();
  const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}`);
  const connectMs = performance.now() - connectStarted;

  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    const navigateStarted = performance.now();
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (window as { __baselayerBenchReady?: boolean }).__baselayerBenchReady === true, null, {
      timeout: 15_000,
    });
    await page.title();
    const navigateMs = performance.now() - navigateStarted;
    return { connectMs, navigateMs };
  } finally {
    await browser.close();
  }
}

async function runLatency(baseUrl: string): Promise<Record<string, unknown>> {
  for (let index = 0; index < warmupIterations; index += 1) {
    await runSingleSession(`${baseUrl}/?v=1`);
  }

  const iterationsResult = [];
  for (let index = 0; index < iterations; index += 1) {
    const result = await runSingleSession(`${baseUrl}/?v=${(index % 3) + 1}`);
    iterationsResult.push(result);
  }

  const connectValues = iterationsResult.map((result) => result.connectMs);
  const navigateValues = iterationsResult.map((result) => result.navigateMs);
  return {
    iterations: iterationsResult,
    avgConnectMs: average(connectValues),
    p50ConnectMs: percentile(connectValues, 50),
    p95ConnectMs: percentile(connectValues, 95),
    avgNavigateMs: average(navigateValues),
    p50NavigateMs: percentile(navigateValues, 50),
    p95NavigateMs: percentile(navigateValues, 95),
  };
}

async function runDensity(baseUrl: string): Promise<Record<string, unknown>> {
  const levels = [];
  let maxStableConcurrency = 0;
  for (let requestedConcurrency = 1; requestedConcurrency <= maxConcurrency; requestedConcurrency += 1) {
    const activeSessionCount = Math.max(
      1,
      Math.min(requestedConcurrency, Math.ceil(requestedConcurrency * activeSessionRatio)),
    );
    const results = await Promise.allSettled(
      Array.from({ length: requestedConcurrency }, (_, index) => {
        const initialVariant = activeVariants[index % activeVariants.length]!;
        const activeUrls = activeVariants.map(
          (_, activeIndex) => `${baseUrl}/?v=${activeVariants[(index + activeIndex) % activeVariants.length]}`,
        );
        return exerciseSession(
          `${baseUrl}/?v=${initialVariant}`,
          activeUrls,
          index < activeSessionCount,
        );
      }),
    );

    const successes = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<{
        connectMs: number;
        navigateMs: number;
        soakActionSuccesses: number;
        soakActionFailures: number;
      }> => result.status === "fulfilled",
    );

    const successRate = successes.length / requestedConcurrency;
    const level = {
      requestedConcurrency,
      successes: successes.length,
      successRate,
      avgConnectMs: average(successes.map((result) => result.value.connectMs)),
      avgNavigateMs: average(successes.map((result) => result.value.navigateMs)),
      soakSeconds,
      activeSessionCount,
      idleSessionCount: Math.max(0, requestedConcurrency - activeSessionCount),
      soakActionSuccesses: successes.reduce(
        (sum, result) => sum + result.value.soakActionSuccesses,
        0,
      ),
      soakActionFailures: successes.reduce(
        (sum, result) => sum + result.value.soakActionFailures,
        0,
      ),
    };
    levels.push(level);
    if (successRate === 1 && level.soakActionFailures === 0) {
      maxStableConcurrency = requestedConcurrency;
    } else {
      break;
    }
  }

  return {
    levels,
    maxStableConcurrency,
  };
}

try {
  const site = await startBenchSite();
  await startBrowserless();
  const latency = await runLatency(site.baseUrl);
  const density = await runDensity(site.baseUrl);
  console.log(
    JSON.stringify(
      {
        benchmark: "browserless-local",
        image,
        port,
        siteBaseUrl: site.baseUrl,
        configuredConcurrency: Number.parseInt(configuredConcurrency, 10),
        warmupIterations,
        soakSeconds,
        activeSessionRatio,
        activeRoundsPerSession,
        activePauseMs,
        latency,
        density,
      },
      null,
      2,
    ),
  );
  await site.close();
} finally {
  await stopBrowserless();
}
