#!/usr/bin/env node
/**
 * Bounded runner for cloud and remote CLIs (aws, gcloud, ssh, scp, rsync, …).
 * The first argument after `--` is the program to spawn.
 *
 * Usage:
 *   npx cloud-run [options] -- <command...>
 *   npm run cloud:run -- [options] -- <command...>
 *   node scripts/cloud-run.mjs [options] -- <command...>
 *   node scripts/cloud-run.mjs <command...>
 *
 * Options (before `--`):
 *   --timeout-sec=N      Wall-clock max (default 30s). Exit 124 on timeout.
 *   --log=PATH           Append combined stdout/stderr (UTF-8).
 *   --json-result=PATH   Write exit metadata JSON when the run finishes.
 *   --label=NAME         Stored in JSON as "label".
 *   --help               Show help.
 *
 * Env defaults:
 *   CLOUD_RUN_TIMEOUT_SEC, CLOUD_RUN_LOG, CLOUD_RUN_JSON_RESULT
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT_SEC = 30;

function defaultTimeoutFromEnv() {
  const raw = process.env["CLOUD_RUN_TIMEOUT_SEC"];
  if (raw === undefined || raw === "") {
    return DEFAULT_TIMEOUT_SEC;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_SEC;
}

function printHelp() {
  console.log(`Usage:
  npx cloud-run [options] -- <command...>
  npm run cloud:run -- [options] -- <command...>
  node scripts/cloud-run.mjs [options] -- <command...>
  node scripts/cloud-run.mjs <command...>

First token after "--" is any program: aws, gcloud, ssh, scp, rsync, etc.

Options (before "--" only):
  --timeout-sec=N      Wall-clock max (default ${DEFAULT_TIMEOUT_SEC}, or CLOUD_RUN_TIMEOUT_SEC). Prefer 15 or 30 for most runs. Exit 124 on timeout.
  --log=PATH           Append combined stdout/stderr (default: CLOUD_RUN_LOG).
  --json-result=PATH   Write JSON metadata (default: CLOUD_RUN_JSON_RESULT).
  --label=NAME         Optional tag stored in JSON as "label".

Exit codes: 0 success, 124 timeout, 125 spawn failure, else the child process exit code.

Examples:
  npm run cloud:run -- --timeout-sec=30 --label=aws-status -- aws ec2 describe-instances --profile baselayer --region us-east-2
  npm run cloud:run -- --timeout-sec=15 --label=gcp-status -- gcloud compute instances list
  npm run cloud:run -- --timeout-sec=20 --label=ssh-tail -- ssh -n -T user@host "tail -n 50 /tmp/job.log"

Env: CLOUD_RUN_TIMEOUT_SEC, CLOUD_RUN_LOG, CLOUD_RUN_JSON_RESULT`);
}

function parseArgs(argv) {
  const sep = argv.indexOf("--");
  const optTokens = sep >= 0 ? argv.slice(0, sep) : [];
  const commandPart = sep >= 0 ? argv.slice(sep + 1) : argv;

  let timeoutSec = defaultTimeoutFromEnv();
  let logPath = "";
  let jsonResultPath = "";
  let label = "";

  for (const raw of optTokens) {
    if (raw === "--help" || raw === "-h") {
      printHelp();
      process.exit(0);
    }
    if (raw.startsWith("--timeout-sec=")) {
      const n = parseInt(raw.slice("--timeout-sec=".length), 10);
      timeoutSec = Number.isFinite(n) && n > 0 ? n : defaultTimeoutFromEnv();
    } else if (raw.startsWith("--log=")) {
      logPath = raw.slice("--log=".length);
    } else if (raw.startsWith("--json-result=")) {
      jsonResultPath = raw.slice("--json-result=".length);
    } else if (raw.startsWith("--label=")) {
      label = raw.slice("--label=".length);
    } else {
      console.error(`cloud-run: unknown option: ${raw}`);
      process.exit(2);
    }
  }

  if (!logPath) {
    const fromEnv = process.env["CLOUD_RUN_LOG"];
    if (fromEnv !== undefined && String(fromEnv).trim() !== "") {
      logPath = String(fromEnv).trim();
    }
  }
  if (!jsonResultPath) {
    const fromEnv = process.env["CLOUD_RUN_JSON_RESULT"];
    if (fromEnv !== undefined && String(fromEnv).trim() !== "") {
      jsonResultPath = String(fromEnv).trim();
    }
  }

  return { timeoutSec, logPath, jsonResultPath, label, commandArgs: commandPart };
}

const argv = process.argv.slice(2);
if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
  printHelp();
  process.exit(0);
}

const { timeoutSec, logPath, jsonResultPath, label, commandArgs } = parseArgs(argv);

if (commandArgs.length === 0) {
  printHelp();
  process.exit(2);
}

const commandBin = commandArgs[0];
const commandRest = commandArgs.slice(1);
const started = Date.now();
let timedOut = false;
let logStream = null;

if (logPath) {
  fs.mkdirSync(path.dirname(path.resolve(logPath)), { recursive: true });
  logStream = fs.createWriteStream(logPath, { flags: "a" });
}

function appendLog(chunk) {
  if (logStream) {
    logStream.write(chunk);
  }
}

const child = spawn(commandBin, commandRest, {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

const killAfterMs = 10_000;
let killTimer = null;

function hardKill() {
  try {
    child.kill("SIGKILL");
  } catch {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
}

const timeoutTimer = setTimeout(() => {
  timedOut = true;
  try {
    child.kill("SIGTERM");
  } catch {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
  killTimer = setTimeout(hardKill, killAfterMs);
}, timeoutSec * 1000);

function cleanupTimers() {
  clearTimeout(timeoutTimer);
  if (killTimer) {
    clearTimeout(killTimer);
  }
}

function writeJson(payload) {
  if (!jsonResultPath) {
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(jsonResultPath)), { recursive: true });
  fs.writeFileSync(jsonResultPath, JSON.stringify(payload, null, 2), "utf8");
}

function finish(exitCode, signal) {
  cleanupTimers();
  if (logStream) {
    logStream.end();
  }

  const durationMs = Date.now() - started;
  const finalCode = timedOut ? 124 : exitCode;

  writeJson({
    exitCode: finalCode,
    remoteExitCode: timedOut ? null : exitCode,
    timedOut,
    signal: signal ?? null,
    durationMs,
    timeoutLimitSec: timeoutSec,
    logPath: logPath || null,
    label: label || null,
    command: commandArgs,
  });

  process.exit(finalCode);
}

child.stdout.on("data", (chunk) => {
  appendLog(chunk);
  process.stdout.write(chunk);
});

child.stderr.on("data", (chunk) => {
  appendLog(chunk);
  process.stderr.write(chunk);
});

child.once("error", (err) => {
  cleanupTimers();
  if (logStream) {
    logStream.end();
  }
  console.error(`cloud-run: failed to spawn ${commandBin}: ${err.message}`);
  writeJson({
    exitCode: 125,
    timedOut: false,
    error: err.message,
    timeoutLimitSec: timeoutSec,
    label: label || null,
    command: commandArgs,
  });
  process.exit(125);
});

child.once("close", (code, signal) => {
  const exitCode = code ?? (signal ? 1 : 0);
  finish(exitCode, signal);
});
