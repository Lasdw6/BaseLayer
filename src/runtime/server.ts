import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import Fastify from "fastify";
import httpProxy from "http-proxy";
import { chromium } from "playwright-core";

import { runtimeConfig } from "../shared/config.js";
import { log, logError } from "../shared/logging.js";

const browserOrigin = `http://127.0.0.1:${runtimeConfig.cdpPort}`;
const browserWsOrigin = `ws://127.0.0.1:${runtimeConfig.cdpPort}`;
const relayApp = Fastify({ logger: false });
const healthApp = Fastify({ logger: false });
const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  ws: true,
});

let browserProcess: ChildProcess | undefined;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "baselayer-runtime-"));

proxy.on("error", (error, _req, resOrSocket) => {
  logError("runtime", "proxy-failed", error);

  if ("writeHead" in resOrSocket) {
    if (!resOrSocket.headersSent) {
      resOrSocket.writeHead(502, { "content-type": "application/json" });
    }
    resOrSocket.end(JSON.stringify({ error: "browser-backend-unavailable" }));
    return;
  }

  resOrSocket.destroy();
});

healthApp.get("/health", async () => ({
  ok: true,
  cdpPort: runtimeConfig.cdpPort,
  browserPid: browserProcess?.pid ?? null,
  uptimeSec: Math.round(process.uptime()),
}));

relayApp.get("/health", async () => ({
  ok: true,
  browserPid: browserProcess?.pid ?? null,
  uptimeSec: Math.round(process.uptime()),
}));

relayApp.get("/metadata", async (request) => ({
  cdpVersionUrl: `${request.protocol}://${request.headers.host}/json/version`,
}));

relayApp.get("/json/version", async (request, reply) => {
  const response = await fetch(`${browserOrigin}/json/version`);
  const payload = (await response.json()) as {
    webSocketDebuggerUrl?: string;
    [key: string]: unknown;
  };

  const host = request.headers.host ?? `127.0.0.1:${runtimeConfig.port}`;
  if (typeof payload.webSocketDebuggerUrl === "string") {
    const parsed = new URL(payload.webSocketDebuggerUrl);
    payload.webSocketDebuggerUrl = `ws://${host}${parsed.pathname}${parsed.search}`;
  }

  return reply.code(response.status).send(payload);
});

relayApp.get("/json/list", async (_request, reply) => {
  const response = await fetch(`${browserOrigin}/json/list`);
  const payload = await response.text();
  return reply
    .code(response.status)
    .type(response.headers.get("content-type") ?? "application/json")
    .send(payload);
});

relayApp.all("/json/*", async (request, reply) => {
  const suffix = request.url.startsWith("/json/") ? request.url.slice("/json/".length) : "";
  const response = await fetch(`${browserOrigin}/json/${suffix}`);
  const payload = await response.text();
  return reply
    .code(response.status)
    .type(response.headers.get("content-type") ?? "application/json")
    .send(payload);
});

async function main(): Promise<void> {
  try {
    const executablePath = chromium.executablePath();
    browserProcess = spawn(
      executablePath,
      [
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
        "--disable-dev-shm-usage",
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
        `--remote-debugging-port=${runtimeConfig.cdpPort}`,
        `--user-data-dir=${userDataDir}`,
        "about:blank",
      ],
      {
        stdio: "inherit",
      },
    );

    browserProcess.once("exit", (code, signal) => {
      log("runtime", "browser-exit", { code, signal });
      process.exit(code ?? 0);
    });

    const relayAddress = await relayApp.listen({
      port: runtimeConfig.port,
      host: "0.0.0.0",
    });
    relayApp.server.on("upgrade", (request, socket, head) => {
      if (!request.url?.startsWith("/devtools/")) {
        socket.destroy();
        return;
      }

      proxy.ws(request, socket, head, { target: browserWsOrigin });
    });

    await healthApp.listen({
      port: runtimeConfig.healthPort,
      host: "0.0.0.0",
    });

    log("runtime", "browser-process-started", {
      executablePath,
      relayAddress,
      cdpPort: runtimeConfig.cdpPort,
      relayPort: runtimeConfig.port,
      healthPort: runtimeConfig.healthPort,
      browserPid: browserProcess.pid,
    });
  } catch (error) {
    logError("runtime", "startup-failed", error);
    process.exitCode = 1;
  }
}

async function shutdown(signal: string): Promise<void> {
  log("runtime", "shutdown", { signal });
  browserProcess?.kill("SIGTERM");
  await relayApp.close().catch(() => undefined);
  await healthApp.close().catch(() => undefined);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

void main();
