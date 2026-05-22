import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium } from "playwright-core";

import { startBenchSite } from "./lib/site.js";

const execFileAsync = promisify(execFile);

const cdpPort = Number.parseInt(process.env["CRIU_CDP_PORT"] ?? "9222", 10);
const timeoutMs = Number.parseInt(process.env["CRIU_TIMEOUT_MS"] ?? "30000", 10);
const settleMs = Number.parseInt(process.env["CRIU_SETTLE_MS"] ?? "750", 10);
const artifactsRoot =
  process.env["CRIU_ARTIFACT_ROOT"] ?? path.join(process.cwd(), "data", "benchmarks", "criu");
const browserPathOverride = process.env["CRIU_BROWSER_PATH"];
const criuBin = process.env["CRIU_BIN"] ?? "criu";
const sudoBin = process.env["CRIU_SUDO_BIN"] ?? "sudo";
const ghostLimit = process.env["CRIU_GHOST_LIMIT"] ?? "128M";
const extraLaunchArgs = (process.env["CRIU_EXTRA_ARGS"] ?? "")
  .split(/\s+/)
  .map((value) => value.trim())
  .filter(Boolean);

interface CriuCheckResult {
  ok: boolean;
  exitCode: number;
  stdoutPath: string;
  stderrPath: string;
}

interface BrowserIdentity {
  browserPid: number;
  processTreePids: number[];
}

interface BrowserVersionInfo {
  Browser?: string;
  ProtocolVersion?: string;
  webSocketDebuggerUrl?: string;
}

interface DevtoolsPageTarget {
  id?: string;
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface Timings {
  coldStartMs: number;
  dumpMs: number;
  restoreMs: number;
}

interface VerificationResult {
  cdpReady: boolean;
  reconnectSucceeded: boolean;
  restoredPageFound: boolean;
  restoredPageUrl?: string;
  restoredPageTitle?: string;
  restoredPageMatchesOriginal: boolean;
  freshPageNavigateSucceeded: boolean;
  freshPageTitle?: string;
  freshPageUrl?: string;
}

interface Report {
  benchmark: "criu-proof";
  success: boolean;
  timestamp: string;
  artifactDir: string;
  environment: {
    hostname: string;
    platform: NodeJS.Platform;
    release: string;
    cdpPort: number;
    ghostLimit: string;
    settleMs: number;
    timeoutMs: number;
  };
  browser: {
    executablePath: string;
    launchArgs: string[];
    userDataDir: string;
    initialPageTitle: string;
    initialPageUrl: string;
    browserPid: number;
    processTreePids: number[];
  };
  criu: {
    bin: string;
    dumpDir: string;
    dumpLogPath: string;
    restoreLogPath: string;
    check: CriuCheckResult;
  };
  timings: Timings;
  verification: VerificationResult;
  failureMessage?: string;
}

class ProofError extends Error {
  constructor(
    message: string,
    readonly partialReport: Report,
  ) {
    super(message);
  }
}

function assertLinux(): void {
  if (process.platform !== "linux") {
    throw new Error("CRIU proof only runs on Linux.");
  }
}

async function waitForHttpJson<T>(url: string, timeout: number): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return (await response.json()) as T;
      }
      lastError = new Error(`HTTP ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Timed out waiting for ${url}: ${detail}`);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return (await response.json()) as T;
}

async function runLoggedCommand(
  command: string,
  args: string[],
  stdoutPath: string,
  stderrPath: string,
): Promise<{ exitCode: number }> {
  fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });
  const stdoutHandle = fs.openSync(stdoutPath, "w");
  const stderrHandle = fs.openSync(stderrPath, "w");

  try {
    const child = spawn(command, args, {
      stdio: ["ignore", stdoutHandle, stderrHandle],
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 0));
    });

    return { exitCode };
  } finally {
    fs.closeSync(stdoutHandle);
    fs.closeSync(stderrHandle);
  }
}

async function runCriuCommand(
  args: string[],
  stdoutPath: string,
  stderrPath: string,
): Promise<{ exitCode: number }> {
  return runLoggedCommand(sudoBin, ["-n", criuBin, ...args], stdoutPath, stderrPath);
}

function browserLaunchArgs(userDataDir: string): string[] {
  return [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-component-extensions-with-background-pages",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-features=AcceptCHFrame,MediaRouter,OptimizationHints,PaintHolding,Translate",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-zygote",
    "--password-store=basic",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--remote-allow-origins=*",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    ...extraLaunchArgs,
    "about:blank",
  ];
}

function resolveBrowserPath(): string {
  const executablePath = browserPathOverride || chromium.executablePath();
  if (!fs.existsSync(executablePath)) {
    throw new Error(
      `Chromium executable not found at ${executablePath}. Install it first with 'npx playwright-core install chromium'.`,
    );
  }
  return executablePath;
}

function collectProcessTree(rootPid: number): number[] {
  const { stdout } = spawnSyncPs();
  const entries = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pidRaw, ppidRaw] = line.split(/\s+/);
      return {
        pid: Number.parseInt(pidRaw ?? "0", 10),
        ppid: Number.parseInt(ppidRaw ?? "0", 10),
      };
    })
    .filter((entry) => Number.isFinite(entry.pid) && Number.isFinite(entry.ppid));

  const childrenByParent = new Map<number, number[]>();
  for (const entry of entries) {
    const siblings = childrenByParent.get(entry.ppid) ?? [];
    siblings.push(entry.pid);
    childrenByParent.set(entry.ppid, siblings);
  }

  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const child of childrenByParent.get(current) ?? []) {
      queue.push(child);
    }
  }

  return [...seen].sort((left, right) => left - right);
}

function spawnSyncPs(): { stdout: string } {
  const output = spawnSync("ps", ["-eo", "pid=,ppid="], {
    encoding: "utf8",
  }) as { stdout?: string; error?: Error; status?: number };
  if (output.error) {
    throw output.error;
  }
  if ((output.status ?? 0) !== 0) {
    throw new Error("Failed to inspect process tree with ps.");
  }
  return { stdout: output.stdout ?? "" };
}

async function killProcessGroup(rootPid: number): Promise<void> {
  try {
    process.kill(-rootPid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(rootPid, 0);
    } catch {
      return;
    }
    await sleep(100);
  }

  try {
    process.kill(-rootPid, "SIGKILL");
  } catch {
    // Ignore if it already exited.
  }
}

async function waitForCdpReady(timeout: number): Promise<void> {
  await waitForHttpJson(`http://127.0.0.1:${cdpPort}/json/version`, timeout);
}

async function waitForBrowserVersion(timeout: number): Promise<BrowserVersionInfo> {
  return waitForHttpJson<BrowserVersionInfo>(`http://127.0.0.1:${cdpPort}/json/version`, timeout);
}

async function createDevtoolsPage(url: string): Promise<DevtoolsPageTarget> {
  const endpoint = `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`;
  let lastError: unknown;

  for (const method of ["PUT", "GET"]) {
    try {
      return await fetchJson<DevtoolsPageTarget>(endpoint, { method });
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Failed to create DevTools page target: ${detail}`);
}

async function closeDevtoolsPage(targetId: string): Promise<void> {
  const endpoint = `http://127.0.0.1:${cdpPort}/json/close/${encodeURIComponent(targetId)}`;
  let lastError: unknown;

  for (const method of ["GET", "PUT"]) {
    try {
      const response = await fetch(endpoint, { method });
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status} from ${endpoint}`);
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Failed to close DevTools page target ${targetId}: ${detail}`);
}

class CdpClient {
  private readonly socket: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          id?: number;
          error?: { message?: string };
          result?: unknown;
        };
        if (typeof payload.id !== "number") {
          return;
        }
        const pending = this.pending.get(payload.id);
        if (!pending) {
          return;
        }
        this.pending.delete(payload.id);
        if (payload.error) {
          pending.reject(new Error(payload.error.message ?? "CDP command failed."));
          return;
        }
        pending.resolve(payload.result);
      } catch (error) {
        for (const [id, pending] of this.pending) {
          this.pending.delete(id);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    this.socket.addEventListener("close", () => {
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        pending.reject(new Error("CDP socket closed."));
      }
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error(`Failed to connect to CDP WebSocket ${url}`)),
        { once: true },
      );
    });
    return new CdpClient(socket);
  }

  async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = ++this.nextId;
    const message = JSON.stringify({
      id,
      method,
      params,
    });

    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });

    this.socket.send(message);
    return result;
  }

  close(): void {
    this.socket.close();
  }
}

async function warmBrowserViaRawCdp(url: string): Promise<{ title: string; url: string; targetId: string }> {
  const target = await createDevtoolsPage(url);
  if (!target.id || !target.webSocketDebuggerUrl) {
    throw new Error("DevTools did not return a page WebSocket debugger URL.");
  }

  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.send("Runtime.enable");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const evaluation = await client.send<{
        result?: {
          value?: {
            ready?: boolean;
            title?: string;
            url?: string;
          };
        };
      }>("Runtime.evaluate", {
        expression:
          "({ ready: window.__baselayerBenchReady === true, title: document.title, url: location.href })",
        returnByValue: true,
      });

      const value = evaluation.result?.value;
      if (value?.ready === true) {
        return {
          targetId: target.id,
          title: value.title ?? "",
          url: value.url ?? "",
        };
      }

      await sleep(100);
    }
  } finally {
    client.close();
  }

  throw new Error("Timed out waiting for the benchmark page to settle over raw CDP.");
}

async function runProof(): Promise<Report> {
  assertLinux();

  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const artifactDir = path.join(artifactsRoot, timestamp);
  const dumpDir = path.join(artifactDir, "dump");
  const dumpStdoutPath = path.join(artifactDir, "criu-dump.stdout.log");
  const dumpStderrPath = path.join(artifactDir, "criu-dump.stderr.log");
  const restoreStdoutPath = path.join(artifactDir, "criu-restore.stdout.log");
  const restoreStderrPath = path.join(artifactDir, "criu-restore.stderr.log");
  const checkStdoutPath = path.join(artifactDir, "criu-check.stdout.log");
  const checkStderrPath = path.join(artifactDir, "criu-check.stderr.log");
  const browserStdoutPath = path.join(artifactDir, "browser.stdout.log");
  const browserStderrPath = path.join(artifactDir, "browser.stderr.log");
  fs.mkdirSync(dumpDir, { recursive: true });

  const site = await startBenchSite();
  const localUrlForVariant = (variant: string) =>
    `${site.localBaseUrl}/?v=${encodeURIComponent(variant)}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "baselayer-criu-"));
  const executablePath = resolveBrowserPath();
  const launchArgs = browserLaunchArgs(userDataDir);

  let browserProcess: ChildProcess | undefined;
  const report: Report = {
    benchmark: "criu-proof",
    success: false,
    timestamp: new Date().toISOString(),
    artifactDir,
    environment: {
      hostname: os.hostname(),
      platform: process.platform,
      release: os.release(),
      cdpPort,
      ghostLimit,
      settleMs,
      timeoutMs,
    },
    browser: {
      executablePath,
      launchArgs,
      userDataDir,
      initialPageTitle: "",
      initialPageUrl: "",
      browserPid: 0,
      processTreePids: [],
    },
    criu: {
      bin: criuBin,
      dumpDir,
      dumpLogPath: dumpStderrPath,
      restoreLogPath: restoreStderrPath,
      check: {
        ok: false,
        exitCode: 1,
        stdoutPath: checkStdoutPath,
        stderrPath: checkStderrPath,
      },
    },
    timings: {
      coldStartMs: 0,
      dumpMs: 0,
      restoreMs: 0,
    },
    verification: {
      cdpReady: false,
      reconnectSucceeded: false,
      restoredPageFound: false,
      restoredPageMatchesOriginal: false,
      freshPageNavigateSucceeded: false,
    },
  };

  try {
    const criuCheck = await runCriuCommand(["check"], checkStdoutPath, checkStderrPath);
    report.criu.check = {
      ok: criuCheck.exitCode === 0,
      exitCode: criuCheck.exitCode,
      stdoutPath: checkStdoutPath,
      stderrPath: checkStderrPath,
    };
    if (!report.criu.check.ok) {
      throw new ProofError("CRIU check failed. See criu-check logs.", report);
    }

    const stdoutHandle = fs.openSync(browserStdoutPath, "w");
    const stderrHandle = fs.openSync(browserStderrPath, "w");
    browserProcess = spawn(executablePath, launchArgs, {
      detached: true,
      stdio: ["ignore", stdoutHandle, stderrHandle],
    });
    browserProcess.unref();
    fs.closeSync(stdoutHandle);
    fs.closeSync(stderrHandle);

    if (!browserProcess.pid) {
      throw new ProofError("Chromium did not provide a PID.", report);
    }
    report.browser.browserPid = browserProcess.pid;

    const coldStarted = performance.now();
    await waitForCdpReady(timeoutMs);
    report.verification.cdpReady = true;

    const warmed = await warmBrowserViaRawCdp(localUrlForVariant("1"));
    report.browser.initialPageTitle = warmed.title;
    report.browser.initialPageUrl = warmed.url;
    report.timings.coldStartMs = performance.now() - coldStarted;
    await closeDevtoolsPage(warmed.targetId);

    await sleep(settleMs);

    const identity: BrowserIdentity = {
      browserPid: browserProcess.pid,
      processTreePids: collectProcessTree(browserProcess.pid),
    };
    report.browser.processTreePids = identity.processTreePids;

    const dumpStarted = performance.now();
    const dumpResult = await runCriuCommand(
      [
        "dump",
        "-t",
        String(identity.browserPid),
        "-D",
        dumpDir,
        "-o",
        dumpStderrPath,
        "-v4",
        "--ghost-limit",
        ghostLimit,
        "--leave-running",
        "--shell-job",
        "--tcp-established",
        "--ext-unix-sk",
        "--file-locks",
        "--link-remap",
      ],
      dumpStdoutPath,
      dumpStderrPath,
    );
    report.timings.dumpMs = performance.now() - dumpStarted;
    if (dumpResult.exitCode !== 0) {
      throw new ProofError("CRIU dump failed. See dump logs.", report);
    }

    await killProcessGroup(identity.browserPid);

    const restoreStarted = performance.now();
    const restoreResult = await runCriuCommand(
      [
        "restore",
        "-D",
        dumpDir,
        "-o",
        restoreStderrPath,
        "-v4",
        "--shell-job",
        "--tcp-established",
        "--ext-unix-sk",
        "--file-locks",
        "--link-remap",
      ],
      restoreStdoutPath,
      restoreStderrPath,
    );
    if (restoreResult.exitCode !== 0) {
      throw new ProofError("CRIU restore failed. See restore logs.", report);
    }

    await waitForBrowserVersion(timeoutMs);
    report.timings.restoreMs = performance.now() - restoreStarted;

    const restoredBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    report.verification.reconnectSucceeded = true;

    const restoredContext = restoredBrowser.contexts()[0];
    const restoredPage = restoredContext?.pages()[0];
    if (restoredPage) {
      report.verification.restoredPageFound = true;
      report.verification.restoredPageUrl = restoredPage.url();
      report.verification.restoredPageTitle = await restoredPage.title().catch(() => "");
      report.verification.restoredPageMatchesOriginal =
        report.verification.restoredPageTitle === report.browser.initialPageTitle;
    }

    const freshContext = restoredContext ?? (await restoredBrowser.newContext());
    const freshPage = await freshContext.newPage();
    await freshPage.goto(localUrlForVariant("2"), { waitUntil: "domcontentloaded" });
    await freshPage.waitForFunction(
      () => (window as { __baselayerBenchReady?: boolean }).__baselayerBenchReady === true,
      null,
      { timeout: 15_000 },
    );
    report.verification.freshPageTitle = await freshPage.title();
    report.verification.freshPageUrl = freshPage.url();
    report.verification.freshPageNavigateSucceeded = true;
    report.success = true;

    await restoredBrowser.close();
    return report;
  } catch (error) {
    if (error instanceof ProofError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ProofError(message, report);
  } finally {
    if (browserProcess?.pid) {
      await killProcessGroup(browserProcess.pid).catch(() => undefined);
    }
    await site.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

let report: Report | undefined;

try {
  report = await runProof();
  fs.mkdirSync(report.artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(report.artifactDir, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProofError) {
    report = error.partialReport;
  }
  if (report) {
    report.failureMessage = message;
    fs.mkdirSync(report.artifactDir, { recursive: true });
    fs.writeFileSync(
      path.join(report.artifactDir, "report.json"),
      JSON.stringify(report, null, 2),
    );
  } else {
    const fallbackDir = path.join(
      artifactsRoot,
      new Date().toISOString().replaceAll(":", "-"),
    );
    fs.mkdirSync(fallbackDir, { recursive: true });
    fs.writeFileSync(
      path.join(fallbackDir, "report.json"),
      JSON.stringify(
        {
          benchmark: "criu-proof",
          success: false,
          timestamp: new Date().toISOString(),
          artifactDir: fallbackDir,
          failureMessage: message,
        },
        null,
        2,
      ),
    );
  }
  console.error(message);
  process.exitCode = 1;
}
