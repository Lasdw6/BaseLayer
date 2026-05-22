import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

import { FirecrackerOrchestrator, firecrackerCapabilitySummary } from "../node-agent/firecracker.js";
import { startBenchSite } from "./lib/site.js";

const reportRoot =
  process.env["FIRECRACKER_PROOF_REPORT_DIR"] ??
  path.join(process.cwd(), "data", "benchmarks", "firecracker-proof");
const restoreIterations = Number.parseInt(process.env["FIRECRACKER_PROOF_ITERATIONS"] ?? "3", 10);

function replaceHost(url: string, host: string): string {
  const parsed = new URL(url);
  parsed.hostname = host;
  return parsed.toString();
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((pct / 100) * (sorted.length - 1))));
  return sorted[index] ?? 0;
}

const orchestrator = new FirecrackerOrchestrator();
const snapshotInfo = orchestrator.getSnapshotInfo();

const site = await startBenchSite(Number.parseInt(process.env["BENCH_SITE_PORT"] ?? "0", 10));
const artifactDir = path.join(reportRoot, new Date().toISOString().replaceAll(":", "-"));
fs.mkdirSync(artifactDir, { recursive: true });

const report = {
  benchmark: "firecracker-proof",
  success: false,
  timestamp: new Date().toISOString(),
  artifactDir,
  environment: {
    ...firecrackerCapabilitySummary(),
    hostname: os.hostname(),
    platform: process.platform,
    release: os.release(),
  },
  snapshot: {
    name: snapshotInfo.name,
    snapshotPath: snapshotInfo.snapshotPath,
    memFilePath: snapshotInfo.memFilePath,
    metadataPath: snapshotInfo.metadataPath,
  },
  phase1: {
    snapshotCreated: false,
    coldBootMs: 0,
    baseVerifyTitle: "",
    baseVerifyUrl: "",
  },
  restore: {
    iterations: restoreIterations,
    runs: [] as Array<{
      ok: boolean;
      restoreMs: number;
      connectMs: number;
      navigateMs: number;
      title?: string;
      url?: string;
      error?: string;
    }>,
    avgRestoreMs: 0,
    p50RestoreMs: 0,
    p95RestoreMs: 0,
  },
};

try {
  const snapshotStarted = performance.now();
  await orchestrator.createBaseSnapshot({
    instanceId: `base-${Date.now()}`,
    verify: async (machine) => {
      const browser = await chromium.connectOverCDP(machine.debugHttpUrl());
      try {
        const context = browser.contexts()[0] ?? (await browser.newContext());
        const page = await context.newPage();
        const targetUrl = replaceHost(site.localBaseUrl, machine.hostIp);
        await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
          () => (window as { __baselayerBenchReady?: boolean }).__baselayerBenchReady === true,
          null,
          { timeout: 15_000 },
        );
        report.phase1.baseVerifyTitle = await page.title();
        report.phase1.baseVerifyUrl = page.url();
      } finally {
        await browser.close();
      }
    },
  });
  report.phase1.snapshotCreated = true;
  report.phase1.coldBootMs = performance.now() - snapshotStarted;

  for (let index = 0; index < restoreIterations; index += 1) {
    const sessionId = `proof-${index}-${Date.now()}`;
    const restoreStarted = performance.now();
    try {
      const runtime = await orchestrator.restoreSession(sessionId);
      const restoreMs = performance.now() - restoreStarted;
      const connectStarted = performance.now();
      const browser = await chromium.connectOverCDP(runtime.debugHttpUrl);
      const connectMs = performance.now() - connectStarted;
      const hostIp = orchestrator.sessionHostIp(sessionId) ?? "127.0.0.1";

      try {
        const context = browser.contexts()[0] ?? (await browser.newContext());
        const page = await context.newPage();
        const targetUrl = replaceHost(site.localBaseUrl, hostIp);
        const navigateStarted = performance.now();
        await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
          () => (window as { __baselayerBenchReady?: boolean }).__baselayerBenchReady === true,
          null,
          { timeout: 15_000 },
        );
        const title = await page.title();
        const url = page.url();
        const navigateMs = performance.now() - navigateStarted;

        report.restore.runs.push({
          ok: true,
          restoreMs,
          connectMs,
          navigateMs,
          title,
          url,
        });
      } finally {
        await browser.close().catch(() => undefined);
      }
    } catch (error) {
      report.restore.runs.push({
        ok: false,
        restoreMs: performance.now() - restoreStarted,
        connectMs: 0,
        navigateMs: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await orchestrator.terminateSession(sessionId).catch(() => undefined);
    }
  }

  const successfulRestoreMs = report.restore.runs.filter((run) => run.ok).map((run) => run.restoreMs);
  report.restore.avgRestoreMs =
    successfulRestoreMs.length === 0
      ? 0
      : successfulRestoreMs.reduce((sum, value) => sum + value, 0) / successfulRestoreMs.length;
  report.restore.p50RestoreMs = percentile(successfulRestoreMs, 50);
  report.restore.p95RestoreMs = percentile(successfulRestoreMs, 95);
  report.success =
    report.phase1.snapshotCreated &&
    report.restore.runs.length > 0 &&
    report.restore.runs.every((run) => run.ok) &&
    report.restore.p50RestoreMs > 0 &&
    report.restore.p50RestoreMs < 500;
} catch (error) {
  report.restore.runs.push({
    ok: false,
    restoreMs: 0,
    connectMs: 0,
    navigateMs: 0,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  await site.close().catch(() => undefined);
}

fs.writeFileSync(path.join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
