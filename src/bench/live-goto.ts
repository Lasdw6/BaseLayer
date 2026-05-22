import { performance } from "node:perf_hooks";

import {
  connectBrowser,
  createSession,
  deleteSession,
  markSessionActivity,
} from "./lib/harness.js";
import { getBrowserArenaPageGotoWaitUntil, getBrowserArenaPageUrl } from "./lib/browserarena.js";

type Sample = {
  sessionId: string;
  createMs: number;
  connectMs: number;
  gotoMs: number;
  releaseMs: number;
  totalMs: number;
  ok: boolean;
  error?: string;
};

const controlPlaneUrl = process.env["CONTROL_PLANE_URL"] ?? "http://127.0.0.1:3000";
const agentUrl = process.env["AGENT_URL"] ?? "http://127.0.0.1:4000";
const targetUrl = process.env["LIVE_GOTO_URL"] ?? getBrowserArenaPageUrl();
const concurrency = Number.parseInt(process.env["LIVE_GOTO_CONCURRENCY"] ?? "24", 10);
const connectTimeoutMs = Number.parseInt(process.env["LIVE_GOTO_CONNECT_TIMEOUT_MS"] ?? "30000", 10);
const gotoTimeoutMs = Number.parseInt(process.env["LIVE_GOTO_TIMEOUT_MS"] ?? "60000", 10);
const waitUntil = getBrowserArenaPageGotoWaitUntil();

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function runSession(): Promise<Sample> {
  const totalStarted = performance.now();
  const { session, createMs } = await createSession(controlPlaneUrl);
  let browser;

  try {
    await markSessionActivity(agentUrl, session.sessionId, "active-navigation").catch(() => undefined);

    const connectStarted = performance.now();
    browser = await connectBrowser(session.playwrightUrl);
    const connectMs = performance.now() - connectStarted;

    const gotoStarted = performance.now();
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(targetUrl, {
      waitUntil,
      timeout: gotoTimeoutMs,
    });
    await page.title().catch(() => undefined);
    const gotoMs = performance.now() - gotoStarted;

    await markSessionActivity(agentUrl, session.sessionId, "interactive-idle").catch(() => undefined);
    await browser.close().catch(() => undefined);
    browser = undefined;

    const releaseStarted = performance.now();
    await deleteSession(controlPlaneUrl, session.sessionId);
    const releaseMs = performance.now() - releaseStarted;

    return {
      sessionId: session.sessionId,
      createMs,
      connectMs,
      gotoMs,
      releaseMs,
      totalMs: performance.now() - totalStarted,
      ok: true,
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await deleteSession(controlPlaneUrl, session.sessionId).catch(() => undefined);
    return {
      sessionId: session.sessionId,
      createMs,
      connectMs: 0,
      gotoMs: 0,
      releaseMs: 0,
      totalMs: performance.now() - totalStarted,
      ok: false,
      error: String(error instanceof Error ? error.message : error),
    };
  }
}

const results = await Promise.all(
  Array.from({ length: concurrency }, (_, index) =>
    runSession().catch((error) => ({
      sessionId: `create-failed-${index}`,
      createMs: 0,
      connectMs: 0,
      gotoMs: 0,
      releaseMs: 0,
      totalMs: 0,
      ok: false,
      error: String(error instanceof Error ? error.message : error),
    })),
  ),
);

const ok = results.filter((result) => result.ok);

const metric = (selector: (sample: Sample) => number) => {
  const values = ok.map(selector);
  return {
    avg: average(values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
  };
};

console.log(
  JSON.stringify(
    {
      benchmark: "live-goto",
      controlPlaneUrl,
      agentUrl,
      targetUrl,
      waitUntil,
      concurrency,
      connectTimeoutMs,
      gotoTimeoutMs,
      successCount: ok.length,
      failureCount: results.length - ok.length,
      createMs: metric((sample) => sample.createMs),
      connectMs: metric((sample) => sample.connectMs),
      gotoMs: metric((sample) => sample.gotoMs),
      releaseMs: metric((sample) => sample.releaseMs),
      totalMs: metric((sample) => sample.totalMs),
      failures: results.filter((result) => !result.ok).map((result) => ({
        sessionId: result.sessionId,
        error: result.error,
      })),
    },
    null,
    2,
  ),
);
