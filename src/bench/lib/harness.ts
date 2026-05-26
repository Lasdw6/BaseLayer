import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium, type Browser, type Page } from "playwright-core";

import {
  getBrowserArenaPageGotoWaitUntil,
  pageNavigationExpectsBenchReadyMarker,
} from "./browserarena.js";
import {
  assertCustomChromiumHostPrerequisitesIfNeeded,
  shouldEnforceCustomChromiumPreflight,
} from "./custom-chromium-preflight.js";
import {
  type AgentHealth,
  type HostSnapshot,
  type PressureSample,
  type SessionSnapshot,
  type SessionResponse,
  type ManagedChild,
  type NavigationMetricsSnapshot,
  type SupportedProfileConfig,
} from "./types.js";
import type { SessionActivityState } from "../../shared/types.js";
import { cleanupFirecrackerHostResources } from "../../node-agent/firecracker.js";

const root = process.cwd();
const runtimeImage = process.env["RUNTIME_IMAGE"] ?? "baselayer-runtime:local";
const hostEligibleTimeoutMs = Number.parseInt(
  process.env["BENCH_HOST_ELIGIBLE_TIMEOUT_MS"] ?? "30000",
  10,
);
const benchUrl =
  process.env["BENCH_URL"] ??
  "data:text/html,<title>BaseLayer%20bench</title><script>window.__baselayerBenchReady=true;</script><h1>bench</h1>";

export interface BenchmarkRunContext {
  controlPlaneUrl: string;
  agentUrl: string;
  profile: SupportedProfileConfig;
  controlPlane: ManagedChild;
  agent: ManagedChild;
}

function childFromSpawn(
  child: ReturnType<typeof spawn>,
  logPath?: string,
): ManagedChild {
  const output: string[] = [];
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "", "utf8");
  }
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
  child.stdout?.on("data", (chunk) => {
    if (logPath) {
      fs.appendFileSync(logPath, String(chunk));
    }
  });
  child.stderr?.on("data", (chunk) => {
    if (logPath) {
      fs.appendFileSync(logPath, String(chunk));
    }
  });

  return {
    pid: child.pid ?? -1,
    output,
    logPath,
    kill: (signal?: NodeJS.Signals | number) => child.kill(signal),
    onceExit: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      }),
    killed: () => child.killed,
  };
}

export async function waitForJson<T>(url: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return (await response.json()) as T;
      }
    } catch {
      // Retry.
    }

    await sleep(500);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function startNodeProcess(
  scriptPath: string,
  env: Record<string, string>,
  label: string,
): ManagedChild {
  const logPath = path.join(root, ".tmp-logs", `${label}.log`);
  const child = spawn(process.execPath, [scriptPath], {
    cwd: root,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return childFromSpawn(child, logPath);
}

export async function stopProcess(child: ManagedChild | undefined): Promise<void> {
  if (!child || child.killed()) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([child.onceExit(), sleep(5_000)]);

  if (!child.killed()) {
    child.kill("SIGKILL");
  }
}

export async function cleanupContainers(): Promise<void> {
  const response = await fetch("http://127.0.0.1:9").catch(() => undefined);
  void response;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "-aq", "--filter", "label=baselayer.managed=true"],
      { windowsHide: true },
    );
    const ids = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const id of ids) {
      await execFileAsync("docker", ["rm", "-f", id], { windowsHide: true });
    }
  } catch {
    // Ignore cleanup failures during setup.
  }
}

function assertFirecrackerBenchAssets(profile: SupportedProfileConfig): void {
  if (profile.mode !== "firecracker") {
    return;
  }

  const merged: Record<string, string | undefined> = {
    ...process.env,
    ...profile.defaultAgentEnv,
  };
  const kernel = merged["FIRECRACKER_KERNEL_PATH"];
  const rootfs = merged["FIRECRACKER_ROOTFS_PATH"];
  if (!kernel || !fs.existsSync(kernel)) {
    throw new Error(
      `Firecracker kernel missing for ${profile.id}: ${kernel ?? "(unset)"}. ` +
        `Set FIRECRACKER_KERNEL_PATH or place artifacts/firecracker/vmlinux.`,
    );
  }
  if (!rootfs || !fs.existsSync(rootfs)) {
    throw new Error(
      `Firecracker rootfs missing for ${profile.id}: ${rootfs ?? "(unset)"}. ` +
        `Build the matching .ext4 for this profile (see build-firecracker-rootfs-variants.sh / custom-headless-shell-build.md).`,
    );
  }
}

export async function startProfileBenchmark(
  profile: SupportedProfileConfig,
  basePort: number,
): Promise<BenchmarkRunContext> {
  assertFirecrackerBenchAssets(profile);
  if (shouldEnforceCustomChromiumPreflight(profile.id)) {
    assertCustomChromiumHostPrerequisitesIfNeeded([profile.id]);
  }
  const controlPlanePort = basePort;
  const agentPort = basePort + 1000;
  const controlPlaneUrl = `http://127.0.0.1:${controlPlanePort}`;
  const agentUrl = `http://127.0.0.1:${agentPort}`;
  const apiScript = path.join(root, "dist", "api", "server.js");
  const agentScript = path.join(root, "dist", "node-agent", "server.js");
  const statePath = path.join(root, "data", `bench-${profile.id}.json`);
  const hostConfigPath = path.join(root, "data", `bench-${profile.id}.provider-hosts.json`);
  const labelPrefix = `${profile.id}-${Date.now()}`;

  fs.rmSync(statePath, { force: true });
  fs.rmSync(hostConfigPath, { force: true });

  const controlPlane = startNodeProcess(apiScript, {
    CONTROL_PLANE_PORT: String(controlPlanePort),
    CONTROL_PLANE_STATE_PATH: statePath,
    CONTROL_PLANE_PROVIDER_HOST_CONFIG_PATH: hostConfigPath,
    CONTROL_PLANE_ENFORCE_HOST_ALLOWLIST: "0",
    CONTROL_PLANE_ENFORCE_PROVIDER_API_KEY_AUTH: "0",
  }, `${labelPrefix}-control-plane`);

  try {
    await waitForJson(`${controlPlaneUrl}/health`, 30_000);

    const agent = startNodeProcess(agentScript, {
      CONTROL_PLANE_URL: controlPlaneUrl,
      NODE_AGENT_PORT: String(agentPort),
      NODE_AGENT_PUBLIC_HOST: "127.0.0.1",
      NODE_AGENT_MODE: profile.mode,
      RUNTIME_IMAGE: runtimeImage,
      ...profile.defaultAgentEnv,
    }, `${labelPrefix}-agent`);

    try {
      const deadline = Date.now() + hostEligibleTimeoutMs;
      while (Date.now() < deadline) {
        const hosts = await waitForJson<{ hosts: Array<{ status: string }> }>(
          `${controlPlaneUrl}/hosts`,
          5_000,
        );
        const first = hosts.hosts[0];
        if (first && first.status !== "no-admit") {
          await waitForAgentReady(agentUrl, profile);
          return {
            controlPlaneUrl,
            agentUrl,
            profile,
            controlPlane,
            agent,
          };
        }

        await sleep(500);
      }

      throw new Error(`Host for ${profile.label} never became eligible for admission.`);
    } catch (error) {
      await stopProcess(agent);
      throw enrichError(error, controlPlane, undefined);
    }
  } catch (error) {
    await stopProcess(controlPlane);
    throw enrichError(error, controlPlane, undefined);
  }
}

export async function stopProfileBenchmark(context: BenchmarkRunContext): Promise<void> {
  await stopProcess(context.agent);
  await stopProcess(context.controlPlane);
  if (context.profile.mode === "firecracker") {
    await cleanupFirecrackerHostResources({
      apiDir: context.profile.defaultAgentEnv["FIRECRACKER_API_DIR"],
      stateDir: context.profile.defaultAgentEnv["FIRECRACKER_STATE_DIR"],
      tapPrefix: context.profile.defaultAgentEnv["FIRECRACKER_TAP_PREFIX"],
    }).catch(() => undefined);
  }
}

export async function waitForAgentReady(
  agentUrl: string,
  profile: SupportedProfileConfig,
  options: {
    requireFullWarmPool?: boolean;
  } = {},
): Promise<void> {
  const warmPoolTarget = Number.parseInt(profile.defaultAgentEnv["WARM_POOL_SIZE"] ?? "0", 10);
  const health = await waitForJson<AgentHealth>(`${agentUrl}/health`, 30_000);
  if (profile.mode === "firecracker") {
    const deadline = Date.now() + 60_000;
    let lastHealth = health;
    const targetNetworkSlots = Math.max(
      0,
      Number.parseInt(
        profile.defaultAgentEnv["FIRECRACKER_NETWORK_POOL_SIZE"] ??
          profile.defaultAgentEnv["FIRECRACKER_MAX_MICROVM_COUNT"] ??
          profile.defaultAgentEnv["MAX_SESSIONS"] ??
          "0",
        10,
      ),
    );
    while (Date.now() < deadline) {
      lastHealth = await waitForJson<AgentHealth>(`${agentUrl}/health`, 5_000);
      const networkSlotsReady =
        targetNetworkSlots === 0 ||
        ((lastHealth.freeNetworkSlotCount ?? 0) >= targetNetworkSlots &&
          lastHealth.preparingNetworkPool !== true);
      if (
        lastHealth.activeSessions === 0 &&
        lastHealth.launchReservations === 0 &&
        (lastHealth.activeMicrovmCount ?? 0) === 0 &&
        networkSlotsReady
      ) {
        return;
      }

      await sleep(250);
    }

    throw new Error(
        `Firecracker agent did not return to an idle state. ` +
        `activeSessions=${lastHealth.activeSessions} activeMicrovmCount=${lastHealth.activeMicrovmCount ?? 0} ` +
        `launchReservations=${lastHealth.launchReservations} ` +
        `freeNetworkSlotCount=${lastHealth.freeNetworkSlotCount ?? "unknown"} ` +
        `targetNetworkSlots=${targetNetworkSlots}`,
    );
  }

  if (profile.mode !== "managed" || warmPoolTarget <= 0) {
    return;
  }

  const requireFullWarmPool = options.requireFullWarmPool ?? true;
  const deadline = Date.now() + 60_000;
  let lastHealth = health;
  while (Date.now() < deadline) {
    lastHealth = await waitForJson<AgentHealth>(`${agentUrl}/health`, 5_000);
    const idleAndNoLaunches =
      lastHealth.activeSessions === 0 &&
      lastHealth.preparingRuntimeCount === 0 &&
      lastHealth.launchReservations === 0;
    const warmPoolReady = lastHealth.warmPoolDepth >= warmPoolTarget;
    if (idleAndNoLaunches && (!requireFullWarmPool || warmPoolReady)) {
      return;
    }

    await sleep(250);
  }

  throw new Error(
    requireFullWarmPool
      ? `Agent warm pool did not reach readiness. depth=${lastHealth.warmPoolDepth} target=${warmPoolTarget}`
      : `Agent did not return to an idle post-level state. depth=${lastHealth.warmPoolDepth} target=${warmPoolTarget}`,
  );
}

export async function createSession(controlPlaneUrl: string): Promise<{
  session: SessionResponse;
  createMs: number;
}> {
  const timeoutSec = Number.parseInt(process.env["BENCH_SESSION_TIMEOUT_SEC"] ?? "300", 10);
  const idleTimeoutSec = Number.parseInt(process.env["BENCH_SESSION_IDLE_TIMEOUT_SEC"] ?? "60", 10);
  const proxyProfile = process.env["BENCH_PROXY_PROFILE"];
  const started = performance.now();
  const response = await fetch(`${controlPlaneUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      browser: "chromium",
      keepAlive: false,
      timeoutSec,
      idleTimeoutSec,
      ...(proxyProfile ? { proxyProfile } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return {
    session: (await response.json()) as SessionResponse,
    createMs: performance.now() - started,
  };
}

export async function connectBrowser(wsEndpoint: string): Promise<Browser> {
  return chromium.connectOverCDP(wsEndpoint, {
    timeout: 30_000,
  });
}

/** DOM navigation + paint timings after the last committed navigation (best on real URLs). */
export async function collectNavigationMetricsFromPage(
  page: Page,
): Promise<NavigationMetricsSnapshot> {
  try {
    return await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as unknown as
        | {
            fetchStart: number;
            domainLookupStart: number;
            domainLookupEnd: number;
            connectStart: number;
            connectEnd: number;
            secureConnectionStart: number;
            requestStart: number;
            responseStart: number;
            domContentLoadedEventEnd: number;
            loadEventEnd: number;
            transferSize?: number;
            decodedBodySize?: number;
          }
        | undefined;
      if (!nav) {
        return {};
      }
      const paints = performance.getEntriesByType("paint") as Array<{
        name: string;
        startTime: number;
      }>;
      const fp = paints.find((p) => p.name === "first-paint");
      const fcp = paints.find((p) => p.name === "first-contentful-paint");
      const dnsLookupMs =
        nav.domainLookupEnd > 0 && nav.domainLookupStart > 0
          ? nav.domainLookupEnd - nav.domainLookupStart
          : undefined;
      const tcpConnectMs =
        nav.connectEnd > 0 && nav.connectStart > 0 ? nav.connectEnd - nav.connectStart : undefined;
      const tlsMs =
        nav.secureConnectionStart > 0 && nav.connectEnd > nav.secureConnectionStart
          ? nav.connectEnd - nav.secureConnectionStart
          : undefined;
      const requestToResponseMs =
        nav.requestStart > 0 && nav.responseStart > nav.requestStart
          ? nav.responseStart - nav.requestStart
          : undefined;
      const responseToDomContentLoadedMs =
        nav.responseStart > 0 && nav.domContentLoadedEventEnd > nav.responseStart
          ? nav.domContentLoadedEventEnd - nav.responseStart
          : undefined;
      return {
        responseStartMs: nav.responseStart,
        domContentLoadedEventEndMs: nav.domContentLoadedEventEnd,
        loadEventEndMs: nav.loadEventEnd,
        firstPaintMs: fp?.startTime,
        firstContentfulPaintMs: fcp?.startTime,
        transferSizeBytes: nav.transferSize,
        decodedBodySizeBytes: nav.decodedBodySize,
        dnsLookupMs,
        tcpConnectMs,
        tlsMs,
        requestToResponseMs,
        responseToDomContentLoadedMs,
      };
    });
  } catch {
    return {};
  }
}

export async function connectAndNavigate(wsEndpoint: string): Promise<number> {
  return connectAndNavigateTo(wsEndpoint, benchUrl);
}

export async function connectAndNavigateTo(
  wsEndpoint: string,
  pageUrl: string,
): Promise<number> {
  const started = performance.now();
  const browser = await connectBrowser(wsEndpoint);
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    const waitUntil = getBrowserArenaPageGotoWaitUntil();
    await page.goto(pageUrl, { waitUntil, timeout: 60_000 });
    await page.waitForFunction(() => (window as { __baselayerBenchReady?: boolean }).__baselayerBenchReady === true, null, {
      timeout: 15_000,
    });
    await page.title();
    return performance.now() - started;
  } finally {
    await browser.close();
  }
}

/**
 * Stages aligned with BrowserArena `hello-browser`: CDP connect → `page.goto` (`BENCH_PAGE_GOTO_WAIT_UNTIL`, default `domcontentloaded`) →
 * optional local-bench readiness → release (DELETE after host teardown completes).
 */
export async function measureBrowserArenaStages(
  controlPlaneUrl: string,
  session: SessionResponse,
  pageUrl: string,
): Promise<{
  session_connect_ms: number;
  page_goto_ms: number;
  session_release_ms: number;
  browserVersion?: string;
  navigationMetrics?: NavigationMetricsSnapshot;
}> {
  const waitUntil = getBrowserArenaPageGotoWaitUntil();
  const awaitBenchReady = pageNavigationExpectsBenchReadyMarker(pageUrl);
  const connectStart = performance.now();
  const browser = await connectBrowser(session.playwrightUrl);
  const session_connect_ms = performance.now() - connectStart;
  let browserVersion: string | undefined;
  try {
    browserVersion = await browser.version();
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    const gotoStart = performance.now();
    await page.goto(pageUrl, { waitUntil, timeout: 60_000 });
    const page_goto_ms = performance.now() - gotoStart;

    if (awaitBenchReady) {
      await page.waitForFunction(() => (window as { __baselayerBenchReady?: boolean }).__baselayerBenchReady === true, null, {
        timeout: 15_000,
      });
    }
    await page.title().catch(() => undefined);
    const navigationMetrics = await collectNavigationMetricsFromPage(page);

    await browser.close();

    const releaseStart = performance.now();
    await deleteSession(controlPlaneUrl, session.sessionId);
    const session_release_ms = performance.now() - releaseStart;
    return {
      session_connect_ms,
      page_goto_ms,
      session_release_ms,
      browserVersion,
      navigationMetrics,
    };
  } finally {
    await browser.close();
  }
}

export async function deleteSession(
  controlPlaneUrl: string,
  sessionId: string,
): Promise<void> {
  const response = await fetch(`${controlPlaneUrl}/sessions/${sessionId}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete session ${sessionId}: ${response.status} ${await response.text()}`);
  }
}

export async function getHostSnapshot(controlPlaneUrl: string): Promise<HostSnapshot | undefined> {
  const payload = await waitForJson<{ hosts: HostSnapshot[] }>(`${controlPlaneUrl}/hosts`, 10_000);
  return payload.hosts[0];
}

export async function getSessionSnapshots(controlPlaneUrl: string): Promise<SessionSnapshot[]> {
  const payload = await waitForJson<{ sessions: SessionSnapshot[] }>(
    `${controlPlaneUrl}/sessions`,
    10_000,
  );
  return payload.sessions;
}

export async function collectPressureSample(
  controlPlaneUrl: string,
  sessionIds?: Set<string>,
): Promise<PressureSample> {
  const [host, sessions] = await Promise.all([
    getHostSnapshot(controlPlaneUrl),
    getSessionSnapshots(controlPlaneUrl),
  ]);
  const relevantSessions = sessionIds
    ? sessions.filter((session) => sessionIds.has(session.sessionId))
    : sessions;

  let trackedSessionMemoryMb = 0;
  let trackedSessionShmUsedMb = 0;
  let trackedSessionRendererCount = 0;
  let trackedSessionCpuPct = 0;
  let maxSessionMemoryMb = 0;
  let maxSessionRendererCount = 0;
  let maxSessionCpuPct = 0;

  for (const session of relevantSessions) {
    const memoryMb = session.lastKnownMetrics?.memoryMb ?? 0;
    const cpuPct = session.lastKnownMetrics?.cpuPct ?? 0;
    const shmUsedMb = session.lastKnownMetrics?.shmUsedMb ?? 0;
    const rendererCount = session.lastKnownMetrics?.rendererCount ?? 0;
    trackedSessionMemoryMb += memoryMb;
    trackedSessionCpuPct += cpuPct;
    trackedSessionShmUsedMb += shmUsedMb;
    trackedSessionRendererCount += rendererCount;
    maxSessionMemoryMb = Math.max(maxSessionMemoryMb, memoryMb);
    maxSessionRendererCount = Math.max(maxSessionRendererCount, rendererCount);
    maxSessionCpuPct = Math.max(maxSessionCpuPct, cpuPct);
  }

  return {
    collectedAt: new Date().toISOString(),
    host,
    sessions: relevantSessions,
    summary: {
      sessionCount: relevantSessions.length,
      trackedSessionMemoryMb,
      trackedSessionCpuPct,
      trackedSessionShmUsedMb,
      trackedSessionRendererCount,
      maxSessionMemoryMb,
      maxSessionRendererCount,
      maxSessionCpuPct,
    },
  };
}

export async function markSessionActivity(
  agentUrl: string,
  sessionId: string,
  activityState: SessionActivityState,
): Promise<void> {
  const response = await fetch(`${agentUrl}/internal/sessions/${sessionId}/activity`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ activityState }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to mark session activity: ${response.status} ${await response.text()}`,
    );
  }
}

export async function writeBenchmarkArtifact(
  reportDir: string,
  fileName: string,
  payload: unknown,
): Promise<string> {
  fs.mkdirSync(reportDir, { recursive: true });
  const targetPath = path.join(reportDir, fileName);
  fs.writeFileSync(targetPath, JSON.stringify(payload, null, 2));
  return targetPath;
}

function enrichError(
  error: unknown,
  controlPlane?: ManagedChild,
  agent?: ManagedChild,
): Error {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown benchmark error";
  return new Error(
    `${message}\ncontrol-plane-log:${controlPlane?.logPath ?? ""}\ncontrol-plane:\n${controlPlane?.output.join("") ?? ""}\nagent-log:${agent?.logPath ?? ""}\nagent:\n${agent?.output.join("") ?? ""}`,
  );
}
