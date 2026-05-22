import { performance } from "node:perf_hooks";

import { chromium } from "playwright-core";

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

function percentile(values: number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * pct));
  return sorted[index]!;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectOverCdpWithRetry(
  endpointURL: string,
): Promise<Awaited<ReturnType<typeof chromium.connectOverCDP>>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      // Lightpanda's current Playwright docs use an options object with
      // endpointURL; Playwright's TypeScript types still primarily document the
      // string overload, so keep this cast isolated to the compatibility path.
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

async function main(): Promise<void> {
  const endpoint = process.env["LIGHTPANDA_WS_ENDPOINT"];
  const host = process.env["LIGHTPANDA_HOST"] ?? "127.0.0.1";
  const port = Number.parseInt(process.env["LIGHTPANDA_PORT"] ?? "9222", 10);
  const targetUrl = process.env["LIGHTPANDA_TARGET_URL"] ?? "https://en.wikipedia.org/wiki/Web_browser";
  const iterations = Number.parseInt(process.env["LIGHTPANDA_ITERATIONS"] ?? "1", 10);
  const waitUntil =
    process.env["LIGHTPANDA_GOTO_WAIT_UNTIL"] === "load" ? "load" : "domcontentloaded";
  const useDefaultContext = process.env["LIGHTPANDA_USE_DEFAULT_CONTEXT"] === "1";
  const closeBrowser = (() => {
    const raw = process.env["LIGHTPANDA_CLOSE_BROWSER"];
    if (raw === undefined) {
      return !endpoint;
    }
    return !["0", "false", "no"].includes(raw.trim().toLowerCase());
  })();

  let module: LightpandaModule | undefined;
  const results: Array<{
    ok: boolean;
    targetUrl: string;
    serveMs: number;
    connectMs: number;
    gotoMs: number;
    releaseMs: number;
    totalMs: number;
    title?: string;
    error?: string;
  }> = [];

  if (!endpoint) {
    try {
      module = (await Function('return import("@lightpanda/browser")')()) as typeof module;
    } catch (error) {
      throw new Error(
        "LIGHTPANDA_WS_ENDPOINT is not set and @lightpanda/browser is not installed. " +
          "Install it with `npm install @lightpanda/browser` or point LIGHTPANDA_WS_ENDPOINT at a running Lightpanda CDP endpoint.",
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  for (let index = 0; index < iterations; index += 1) {
    let proc: LightpandaProcess | undefined;
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    const totalStartedAt = performance.now();
    let serveMs = 0;
    let connectMs = 0;
    let gotoMs = 0;
    let releaseMs = 0;

    try {
      const serveStartedAt = performance.now();
      const iterationPort = endpoint ? port : port + index;
      const endpointURL = endpoint ?? `ws://${host}:${iterationPort}`;
      if (!endpoint) {
        proc = await module!.lightpanda.serve({ host, port: iterationPort });
      }
      serveMs = performance.now() - serveStartedAt;

      const connectStartedAt = performance.now();
      browser = await connectOverCdpWithRetry(endpointURL);
      connectMs = performance.now() - connectStartedAt;

      const context =
        useDefaultContext && browser.contexts()[0]
          ? browser.contexts()[0]!
          : await browser.newContext({});
      const page =
        useDefaultContext && context.pages()[0]
          ? context.pages()[0]!
          : await context.newPage();

      const gotoStartedAt = performance.now();
      await page.goto(targetUrl, {
        waitUntil,
        timeout: 30_000,
      });
      gotoMs = performance.now() - gotoStartedAt;

      const title = await page.title();
      const releaseStartedAt = performance.now();
      await page.close().catch(() => undefined);
      if (!useDefaultContext) {
        await context.close().catch(() => undefined);
      }
      if (closeBrowser) {
        await browser.close().catch(() => undefined);
        browser = undefined;
      }
      proc?.stdout?.destroy?.();
      proc?.stderr?.destroy?.();
      proc?.kill();
      proc = undefined;
      releaseMs = performance.now() - releaseStartedAt;

      const result = {
          ok: true,
          launchMode: endpoint ? "attach" : "serve",
          closeBrowser,
          endpointURL,
          targetUrl,
          title,
          serveMs: Math.round(serveMs),
          connectMs: Math.round(connectMs),
          gotoMs: Math.round(gotoMs),
          releaseMs: Math.round(releaseMs),
          totalMs: Math.round(performance.now() - totalStartedAt),
        };
      results.push(result);
      console.log(JSON.stringify(result));
    } catch (error) {
      const releaseStartedAt = performance.now();
      await browser?.close().catch(() => undefined);
      proc?.stdout?.destroy?.();
      proc?.stderr?.destroy?.();
      proc?.kill();
      releaseMs = performance.now() - releaseStartedAt;
      const result = {
        ok: false,
        targetUrl,
        serveMs: Math.round(serveMs),
        connectMs: Math.round(connectMs),
        gotoMs: Math.round(gotoMs),
        releaseMs: Math.round(releaseMs),
        totalMs: Math.round(performance.now() - totalStartedAt),
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      };
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }

  const successful = results.filter((result) => result.ok);
  const stage = (name: "serveMs" | "connectMs" | "gotoMs" | "releaseMs" | "totalMs"): number =>
    percentile(successful.map((result) => result[name]), 0.5);
  console.log(
    JSON.stringify(
      {
        summary: true,
        targetUrl,
        success: successful.length,
        total: results.length,
        p50: {
          serveMs: stage("serveMs"),
          connectMs: stage("connectMs"),
          gotoMs: stage("gotoMs"),
          releaseMs: stage("releaseMs"),
          totalMs: stage("totalMs"),
        },
      },
      null,
      2,
    ),
  );

  if (successful.length !== results.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
