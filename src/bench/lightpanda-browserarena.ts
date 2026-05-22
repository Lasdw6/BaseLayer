import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { chromium, type Browser } from "playwright-core";

import { getBrowserArenaPageGotoWaitUntil } from "./lib/browserarena.js";

type LightpandaProcess = {
  kill(): void;
  stdout?: { destroy?: () => void };
  stderr?: { destroy?: () => void };
};

type LightpandaModule = {
  lightpanda: {
    serve(options: { host: string; port: number }): Promise<LightpandaProcess>;
  };
};

type LightpandaRecord = {
  created_at: string;
  id: string;
  session_creation_ms: number | null;
  session_connect_ms: number | null;
  page_goto_ms: number | null;
  session_release_ms: number | null;
  provider: "LIGHTPANDA";
  concurrency: number;
  success: boolean;
  error_stage: string | null;
  error_message: string | null;
  title: string | null;
};

const targetUrl = process.env["LIGHTPANDA_TARGET_URL"] ?? "https://google.com/";
const runs = Number.parseInt(process.env["LIGHTPANDA_RUNS"] ?? "5", 10);
const concurrency = Number.parseInt(process.env["LIGHTPANDA_CONCURRENCY"] ?? "1", 10);
const warmupRuns = Number.parseInt(process.env["LIGHTPANDA_WARMUP_RUNS"] ?? "10", 10);
const basePort = Number.parseInt(process.env["LIGHTPANDA_BASE_PORT"] ?? "9222", 10);
const outputPath =
  process.env["LIGHTPANDA_OUT_PATH"] ??
  path.join(process.cwd(), "data", "benchmarks", "lightpanda-browserarena.jsonl");

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

async function connectOverCdpWithRetry(endpointURL: string): Promise<Browser> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await chromium.connectOverCDP({
        endpointURL,
        timeout: 30_000,
      } as Parameters<typeof chromium.connectOverCDP>[0] & { endpointURL: string });
    } catch (error) {
      lastError = error;
      await sleep(100 + attempt * 100);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function loadLightpanda(): Promise<LightpandaModule> {
  try {
    return (await Function('return import("@lightpanda/browser")')()) as LightpandaModule;
  } catch (error) {
    throw new Error(
      "Install @lightpanda/browser first: npm install --no-save @lightpanda/browser",
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

async function runSingleSession(
  module: LightpandaModule,
  index: number,
  measured: boolean,
): Promise<LightpandaRecord> {
  const port = basePort + index;
  const endpointURL = `ws://127.0.0.1:${port}`;
  const id = `lightpanda-${Date.now()}-${index}`;
  const record: LightpandaRecord = {
    created_at: new Date().toISOString(),
    id,
    session_creation_ms: null,
    session_connect_ms: null,
    page_goto_ms: null,
    session_release_ms: null,
    provider: "LIGHTPANDA",
    concurrency,
    success: false,
    error_stage: null,
    error_message: null,
    title: null,
  };

  let proc: LightpandaProcess | undefined;
  let browser: Browser | undefined;
  let stage = "session_create";

  try {
    const createStartedAt = performance.now();
    proc = await module.lightpanda.serve({ host: "127.0.0.1", port });
    record.session_creation_ms = elapsedMs(createStartedAt);
    if (measured) {
      console.error(`[Session created] provider=LIGHTPANDA id=${id} ${record.session_creation_ms}ms`);
    }

    stage = "connect_over_cdp";
    const connectStartedAt = performance.now();
    browser = await connectOverCdpWithRetry(endpointURL);
    record.session_connect_ms = elapsedMs(connectStartedAt);
    if (measured) {
      console.error(`[Browser connected] ${record.session_connect_ms}ms`);
    }

    stage = "page_goto";
    const context = await browser.newContext();
    const page = await context.newPage();
    const gotoStartedAt = performance.now();
    await page.goto(targetUrl, {
      waitUntil: getBrowserArenaPageGotoWaitUntil(),
      timeout: 30_000,
    });
    record.page_goto_ms = elapsedMs(gotoStartedAt);
    record.title = await page.title().catch(() => null);
    record.success = true;
    if (measured) {
      console.error(`[Page loaded] ${record.page_goto_ms}ms`);
    }
  } catch (error) {
    record.error_stage = stage;
    record.error_message = error instanceof Error ? error.stack ?? error.message : String(error);
    if (measured) {
      console.error(`[ERROR] stage=${stage} id=${id} ${record.error_message}`);
    }
  } finally {
    stage = "session_release";
    const releaseStartedAt = performance.now();
    await browser?.close().catch(() => undefined);
    proc?.stdout?.destroy?.();
    proc?.stderr?.destroy?.();
    proc?.kill();
    record.session_release_ms = elapsedMs(releaseStartedAt);
    if (measured) {
      console.error(`[Session released] ${record.session_release_ms}ms`);
    }
  }

  return record;
}

async function main(): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.rmSync(outputPath, { force: true });

  const module = await loadLightpanda();
  console.error(`\n[CONFIG] provider=LIGHTPANDA concurrency=${concurrency} runs=${runs} url=${targetUrl}`);

  for (let index = 1; index <= warmupRuns; index += 1) {
    console.error(`[WARMUP] ${index}/${warmupRuns}`);
    await runSingleSession(module, index - 1, false);
  }

  let success = 0;
  let failure = 0;
  for (let run = 1; run <= runs; run += 1) {
    console.error(`[RUN] ${run}/${runs} (c=${concurrency})`);
    const records = await Promise.all(
      Array.from({ length: concurrency }, (_, index) =>
        runSingleSession(module, (run - 1) * concurrency + index, true),
      ),
    );
    for (const record of records) {
      fs.appendFileSync(outputPath, `${JSON.stringify(record)}\n`, "utf8");
      if (record.success) {
        success += 1;
      } else {
        failure += 1;
      }
    }
  }

  console.error(`[DONE] c=${concurrency} success=${success} failure=${failure}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
