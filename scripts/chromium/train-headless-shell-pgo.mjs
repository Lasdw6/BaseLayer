#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitList(raw, fallback) {
  return (raw ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function findFiles(dir, suffix) {
  const found = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(suffix)) {
        found.push(full);
      }
    }
  }
  await walk(dir);
  return found;
}

async function waitForDevtools(stderrLines, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const line of stderrLines) {
      const match = line.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for DevTools endpoint after ${timeoutMs}ms`);
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function main() {
  const binary = process.env.BASELAYER_PGO_HEADLESS_SHELL;
  if (!binary || !existsSync(binary)) {
    throw new Error("Set BASELAYER_PGO_HEADLESS_SHELL to an existing instrumented headless_shell binary.");
  }

  const rawDir = path.resolve(process.env.BASELAYER_PGO_RAW_DIR ?? "out/baselayer-pgo-raw");
  const profdata = path.resolve(process.env.BASELAYER_PGO_PROFDATA ?? "out/baselayer-pgo/profile.profdata");
  const llvmProfdata = process.env.LLVM_PROFDATA ?? "llvm-profdata";
  const urls = splitList(
    process.env.BASELAYER_PGO_URLS,
    "https://www.google.com/search?q=baselayer+browser,https://www.wikipedia.org/,https://news.ycombinator.com/",
  );
  const iterations = envNumber("BASELAYER_PGO_ITERATIONS", 5);
  const navTimeoutMs = envNumber("BASELAYER_PGO_NAV_TIMEOUT_MS", 30000);
  const waitUntil = process.env.BASELAYER_PGO_WAIT_UNTIL ?? "domcontentloaded";

  const { chromium } = await import("playwright-core");

  await rm(rawDir, { recursive: true, force: true });
  await mkdir(rawDir, { recursive: true });
  await mkdir(path.dirname(profdata), { recursive: true });

  const runSummaries = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "baselayer-pgo-profile-"));
    const stderrLines = [];
    const child = spawn(
      binary,
      [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank",
      ],
      {
        env: {
          ...process.env,
          LLVM_PROFILE_FILE: path.join(rawDir, `default-${iteration}-%p-%m.profraw`),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line) stderrLines.push(line);
      }
    });

    let browser;
    const summary = { iteration, urls: [], errors: [] };
    try {
      const wsEndpoint = await waitForDevtools(stderrLines, 15000);
      browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 10000 });
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());

      for (const url of urls) {
        const started = Date.now();
        try {
          await page.goto(url, { waitUntil, timeout: navTimeoutMs });
          summary.urls.push({ url, ok: true, ms: Date.now() - started });
        } catch (error) {
          summary.urls.push({
            url,
            ok: false,
            ms: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      summary.errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      if (browser) await browser.close().catch(() => {});
      if (!(await waitForExit(child, 10000))) {
        await terminate(child);
      }
      // Chromium child processes can flush profile data just after the browser
      // exits. Keep this delay short, but do not merge while files are still
      // being finalized.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      runSummaries.push(summary);
    }
  }

  const profrawFiles = (await findFiles(rawDir, ".profraw")).filter((file) => {
    const basename = path.basename(file);
    if (process.env.BASELAYER_PGO_INCLUDE_CHILD_POOL_PROFILES === "1") {
      return true;
    }
    return basename.startsWith("default-");
  });
  if (profrawFiles.length === 0) {
    throw new Error(`No .profraw files were produced in ${rawDir}`);
  }

  await new Promise((resolve, reject) => {
    const child = spawn(llvmProfdata, ["merge", "-output", profdata, ...profrawFiles], {
      stdio: "inherit",
    });
    child.once("error", (error) => {
      reject(
        new Error(
          `Failed to start llvm-profdata at '${llvmProfdata}'. Set LLVM_PROFDATA to the Chromium checkout's llvm-profdata binary. ${error.message}`,
        ),
      );
    });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${llvmProfdata} merge exited with ${code}`));
    });
  });

  const payload = {
    kind: "baselayer-headless-shell-pgo-training-v1",
    generatedAt: new Date().toISOString(),
    binary,
    rawDir,
    profdata,
    llvmProfdata,
    iterations,
    urls,
    waitUntil,
    navTimeoutMs,
    profrawCount: profrawFiles.length,
    runSummaries,
  };
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
