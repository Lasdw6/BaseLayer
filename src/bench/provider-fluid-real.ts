import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium } from "playwright-core";

type ActivityState = "active-navigation" | "interactive-idle" | "soak-idle";

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
    totalMs?: number;
    cdpReadyMs?: number;
    processSpawnMs?: number;
    configureMs?: number;
    relayReadyMs?: number;
    networkSetupMs?: number;
    networkClaimMs?: number;
    networkValidateMs?: number;
  };
}

interface SessionRunResult {
  slot: number;
  role: "active" | "idle";
  sessionId?: string;
  providerSessionId: string;
  ok: boolean;
  session_create_ms: number;
  session_connect_ms: number;
  total_navigation_ms: number;
  navigations_completed: number;
  error?: string;
  launchTimings?: ProviderSessionResponse["launchTimings"];
  sessionMetrics?: unknown;
  titles?: string[];
}

const apiUrl = (process.env["BASELAYER_API_URL"] ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const totalSessions = Number.parseInt(process.env["BENCH_TOTAL_SESSIONS"] ?? "8", 10);
const activeSessionRatio = Number.parseFloat(process.env["BENCH_ACTIVE_SESSION_RATIO"] ?? "0.5");
const soakSeconds = Number.parseInt(process.env["BENCH_SOAK_SECONDS"] ?? "120", 10);
const activeRoundsPerSession = Number.parseInt(
  process.env["BENCH_ACTIVE_ROUNDS_PER_SESSION"] ?? "4",
  10,
);
const activePauseMs = Number.parseInt(process.env["BENCH_ACTIVE_PAUSE_MS"] ?? "1500", 10);
const browser = process.env["BASELAYER_BROWSER"] ?? "chromium";
const runtimeProfile = process.env["BASELAYER_RUNTIME_PROFILE"];
const region = process.env["BASELAYER_REGION"];
const proxyProfile = process.env["BASELAYER_PROXY_PROFILE"];
const upstreamProvider = process.env["BASELAYER_UPSTREAM_PROVIDER"] ?? "provider-fluid-real";
const tenantId = process.env["BASELAYER_PROVIDER_TENANT_ID"] ?? "provider-test";
const projectId = process.env["BASELAYER_PROVIDER_PROJECT_ID"] ?? "fluid-eval";
const workloadClass = process.env["BASELAYER_PROVIDER_WORKLOAD_CLASS"] ?? "agent-soak";
const timeoutSec = Number.parseInt(process.env["BENCH_SESSION_TIMEOUT_SEC"] ?? "600", 10);
const idleTimeoutSec = Number.parseInt(process.env["BENCH_SESSION_IDLE_TIMEOUT_SEC"] ?? "180", 10);
const outputPath =
  process.env["BENCH_OUT"] ??
  path.join(process.cwd(), "data", "benchmarks", `provider-fluid-real-${Date.now()}.json`);
const realUrls = (process.env["BENCH_REAL_URLS"] ??
  "https://news.ycombinator.com/,https://en.wikipedia.org/wiki/Main_Page,https://www.wikipedia.org/")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function activeCountFromRatio(total: number, ratio: number): number {
  return Math.max(1, Math.min(total, Math.ceil(total * ratio)));
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function createSession(slot: number): Promise<{
  session: ProviderSessionResponse;
  createMs: number;
  providerSessionId: string;
}> {
  const providerSessionId = `${upstreamProvider}-slot-${slot}`;
  const started = performance.now();
  const response = await postJson(
    `${apiUrl}/v1/sessions`,
    {
      browser,
      keepAlive: false,
      timeoutSec,
      idleTimeoutSec,
      ...(runtimeProfile ? { runtimeProfile } : {}),
      ...(region ? { region } : {}),
      ...(proxyProfile ? { proxyProfile } : {}),
      provider: {
        upstreamProvider,
        providerSessionId,
        tenantId,
        projectId,
        workloadClass,
      },
      sessionTags: {
        provider: upstreamProvider,
        benchmark: "provider-fluid-real",
        slot: String(slot),
        roleHint: "provider-agent",
      },
    },
    60_000,
  );
  if (!response.ok) {
    throw new Error(`session-create failed: ${response.status} ${await response.text()}`);
  }

  return {
    session: (await response.json()) as ProviderSessionResponse,
    createMs: performance.now() - started,
    providerSessionId,
  };
}

async function markActivity(sessionId: string, activityState: ActivityState): Promise<void> {
  const response = await postJson(
    `${apiUrl}/v1/sessions/${sessionId}/activity`,
    { activityState },
    15_000,
  );
  if (!response.ok) {
    throw new Error(`activity-update failed: ${response.status} ${await response.text()}`);
  }
}

async function getSessionMetrics(sessionId: string): Promise<unknown> {
  const response = await fetch(`${apiUrl}/v1/sessions/${sessionId}/metrics`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`session-metrics failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function getFleetSnapshot(): Promise<{ stats: unknown; hosts: unknown }> {
  const [statsResponse, hostsResponse] = await Promise.all([
    fetch(`${apiUrl}/v1/stats`, { signal: AbortSignal.timeout(15_000) }),
    fetch(`${apiUrl}/v1/hosts`, { signal: AbortSignal.timeout(15_000) }),
  ]);
  if (!statsResponse.ok) {
    throw new Error(`stats failed: ${statsResponse.status} ${await statsResponse.text()}`);
  }
  if (!hostsResponse.ok) {
    throw new Error(`hosts failed: ${hostsResponse.status} ${await hostsResponse.text()}`);
  }

  return {
    stats: await statsResponse.json(),
    hosts: await hostsResponse.json(),
  };
}

async function deleteSession(sessionId: string): Promise<void> {
  const response = await fetch(`${apiUrl}/v1/sessions/${sessionId}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`session-delete failed: ${response.status} ${await response.text()}`);
  }
}

async function runSession(slot: number, role: "active" | "idle"): Promise<SessionRunResult> {
  let session: ProviderSessionResponse | undefined;
  let providerSessionId = `${upstreamProvider}-slot-${slot}`;
  let browserConnection: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let sessionCreateMs = 0;
  let sessionConnectMs = 0;
  let totalNavigationMs = 0;
  let navigationsCompleted = 0;
  const titles: string[] = [];

  try {
    const created = await createSession(slot);
    session = created.session;
    providerSessionId = created.providerSessionId;
    sessionCreateMs = created.createMs;

    const connectStarted = performance.now();
    browserConnection = await chromium.connectOverCDP(session.playwrightUrl, {
      timeout: 30_000,
    });
    sessionConnectMs = performance.now() - connectStarted;

    const context = browserConnection.contexts()[0] ?? (await browserConnection.newContext());
    const page = await context.newPage();

    if (role === "idle") {
      await markActivity(session.sessionId, "soak-idle");
      await sleep(soakSeconds * 1000);
    } else {
      const deadline = Date.now() + soakSeconds * 1000;
      for (let round = 0; round < activeRoundsPerSession || Date.now() < deadline; round += 1) {
        const url = realUrls[round % realUrls.length];
        if (!url) {
          break;
        }

        await markActivity(session.sessionId, "active-navigation");
        const gotoStarted = performance.now();
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        totalNavigationMs += performance.now() - gotoStarted;
        navigationsCompleted += 1;

        const title = await page.title().catch(() => "");
        if (title) {
          titles.push(title);
        }
        await page.evaluate(() => document.body?.innerText?.slice(0, 256)).catch(() => undefined);

        if (Date.now() < deadline) {
          await markActivity(session.sessionId, "interactive-idle");
          await sleep(Math.min(activePauseMs, Math.max(0, deadline - Date.now())));
        }
      }

      await markActivity(session.sessionId, "soak-idle");
      await sleep(250);
    }

    const sessionMetrics = await getSessionMetrics(session.sessionId).catch(() => undefined);
    await deleteSession(session.sessionId);

    return {
      slot,
      role,
      sessionId: session.sessionId,
      providerSessionId,
      ok: true,
      session_create_ms: sessionCreateMs,
      session_connect_ms: sessionConnectMs,
      total_navigation_ms: totalNavigationMs,
      navigations_completed: navigationsCompleted,
      launchTimings: session.launchTimings,
      sessionMetrics,
      titles,
    };
  } catch (error) {
    if (session?.sessionId) {
      await deleteSession(session.sessionId).catch(() => undefined);
    }

    return {
      slot,
      role,
      sessionId: session?.sessionId,
      providerSessionId,
      ok: false,
      session_create_ms: sessionCreateMs,
      session_connect_ms: sessionConnectMs,
      total_navigation_ms: totalNavigationMs,
      navigations_completed: navigationsCompleted,
      launchTimings: session?.launchTimings,
      titles,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await browserConnection?.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const activeCount = activeCountFromRatio(totalSessions, activeSessionRatio);
  const roles = Array.from({ length: totalSessions }, (_, index) =>
    index < activeCount ? "active" : "idle",
  );
  const startedAt = new Date().toISOString();
  const sessions = await Promise.all(roles.map((role, index) => runSession(index + 1, role)));
  const finishedAt = new Date().toISOString();
  const fleetSnapshot = await getFleetSnapshot().catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }));

  const payload = {
    benchmark: "provider-fluid-real",
    schema: "provider-fluid-real-v1",
    apiUrl,
    browser,
    runtimeProfile,
    region,
    proxyProfile,
    upstreamProvider,
    tenantId,
    projectId,
    workloadClass,
    totalSessions,
    activeSessionRatio,
    activeSessionCount: activeCount,
    idleSessionCount: Math.max(0, totalSessions - activeCount),
    soakSeconds,
    activeRoundsPerSession,
    activePauseMs,
    realUrls,
    startedAt,
    finishedAt,
    sessions,
    fleetSnapshot,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ outputPath, ...payload }, null, 2));
}

await main();
