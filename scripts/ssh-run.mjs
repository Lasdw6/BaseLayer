#!/usr/bin/env node
/**
 * Bounded runner for remote CLIs (ssh, scp, rsync, …): always exits; optional log + JSON.
 * The first argument after `--` is the program to spawn (e.g. `ssh`, `scp.exe`, `rsync`).
 *
 * Usage:
 *   npx ssh-run [options] -- <command...>         (from repo root; package.json "bin")
 *   npx scp-run [options] -- <command...>          (same script; alias for discoverability)
 *   npm run ssh-run -- [options] -- <command...>
 *   npm run scp:run -- [options] -- <command...>
 *   node scripts/ssh-run.mjs [options] -- <command...>
 *   node scripts/ssh-run.mjs <command...>          (no options; default timeout)
 *
 * Options (only before `--`):
 *   --timeout-sec=N   Wall-clock max (default 30s). Prefer 15 or 30 for most runs.
 *                     Override default with env SSH_RUN_TIMEOUT_SEC (seconds).
 *   --log=PATH        Append combined stdout/stderr (UTF-8). Default: env SSH_RUN_LOG.
 *   --json-result=PATH  Write exit metadata JSON when the run finishes. Default: env SSH_RUN_JSON_RESULT.
 *   --label=NAME      Stored in JSON as "label" (for correlating steps in agents).
 *   --kill-grace-ms=N Delay between timeout and hard-kill (default 500ms on Windows, 10000ms elsewhere).
 *   --help            Show help.
 *
 * Env defaults (when flag omitted): SSH_RUN_TIMEOUT_SEC, SSH_RUN_LOG, SSH_RUN_JSON_RESULT.
 *
 * Prefer 15s or 30s timeouts for most calls; use remote `tee` + a second ssh-run that
 * only `tail`s that file (exit 124 means “still running or check log”, not “hang forever”).
 *
 * Stdin is not forwarded (like ssh -n); use remote bash -lc '...' for commands.
 *
 * Examples:
 *   node scripts/ssh-run.mjs --json-result=.tmp/r.json -- \\
 *     ssh -n -T user@host "bash -lc 'cd /repo && long-job 2>&1 | tee /tmp/step.log'"
 *   node scripts/ssh-run.mjs --timeout-sec=30 --log=.tmp/scp.log --json-result=.tmp/scp.json -- \\
 *     scp.exe -q -i key.pem -o BatchMode=yes local.ts user@host:/remote/path/
 */

import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default when SSH_RUN_TIMEOUT_SEC is unset — keep low so agents re-poll logs instead of waiting. */
const DEFAULT_TIMEOUT_SEC = 30;

function defaultTimeoutFromEnv() {
  const raw = process.env["SSH_RUN_TIMEOUT_SEC"];
  if (raw === undefined || raw === "") {
    return DEFAULT_TIMEOUT_SEC;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_SEC;
}

function printHelp() {
  console.log(`Usage:
  npx ssh-run [options] -- <command...>    (bin: ssh-run, scp-run — same engine)
  npm run ssh-run|scp:run|remote:run -- [options] -- <command...>
  node scripts/ssh-run.mjs [options] -- <command...>
  node scripts/ssh-run.mjs <command...>   (defaults only; use "--" to pass options first)

First token after "--" is any program: ssh, scp.exe, rsync, etc.

Options (before "--" only):
  --timeout-sec=N     Wall-clock max (default ${DEFAULT_TIMEOUT_SEC}, or SSH_RUN_TIMEOUT_SEC). Prefer 15 or 30 for most runs. Exit 124 on timeout.
  --log=PATH          Append combined stdout/stderr (default: SSH_RUN_LOG).
  --json-result=PATH  Write JSON metadata (default: SSH_RUN_JSON_RESULT).
  --label=NAME        Optional tag stored in JSON as "label".
  --kill-grace-ms=N   Delay between timeout and hard-kill. Use low values for Windows ssh.exe.

Exit codes: 0 success, 124 timeout, 125 spawn failure, else the child process exit code.

Examples:
  npx ssh-run -- -- ssh -n -T user@host "bash -lc 'echo ok'"
  npm run scp:run -- --timeout-sec=30 --log=.tmp/scp.log --json-result=.tmp/scp.json -- \\
    scp.exe -q -i key.pem -o BatchMode=yes src/providers/foo.ts user@host:/path/

Env: SSH_RUN_TIMEOUT_SEC, SSH_RUN_LOG, SSH_RUN_JSON_RESULT

The timeout is a maximum: if the child exits sooner, timers are cleared immediately.

Stdin is closed (not forwarded). For ssh prefer: ssh -n -T ... "bash -lc '...'"`);
}

function parseArgs(argv) {
  const sep = argv.indexOf("--");
  const optTokens = sep >= 0 ? argv.slice(0, sep) : [];
  const sshPart = sep >= 0 ? argv.slice(sep + 1) : argv;

  let timeoutSec = defaultTimeoutFromEnv();
  let logPath = "";
  let jsonResultPath = "";
  let label = "";
  let killGraceMs = process.platform === "win32" ? 500 : 10_000;

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
    } else if (raw.startsWith("--kill-grace-ms=")) {
      const n = parseInt(raw.slice("--kill-grace-ms=".length), 10);
      killGraceMs = Number.isFinite(n) && n >= 0 ? n : killGraceMs;
    } else {
      console.error(`ssh-run: unknown option: ${raw}`);
      process.exit(2);
    }
  }

  if (!logPath) {
    const fromEnv = process.env["SSH_RUN_LOG"];
    if (fromEnv !== undefined && String(fromEnv).trim() !== "") {
      logPath = String(fromEnv).trim();
    }
  }
  if (!jsonResultPath) {
    const fromEnv = process.env["SSH_RUN_JSON_RESULT"];
    if (fromEnv !== undefined && String(fromEnv).trim() !== "") {
      jsonResultPath = String(fromEnv).trim();
    }
  }

  return { timeoutSec, logPath, jsonResultPath, label, killGraceMs, sshArgs: sshPart };
}

const argv = process.argv.slice(2);
if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
  printHelp();
  process.exit(0);
}

const { timeoutSec, logPath, jsonResultPath, label, killGraceMs, sshArgs } = parseArgs(argv);

if (sshArgs.length === 0) {
  printHelp();
  process.exit(2);
}

const sshBin = sshArgs[0];
const sshRest = sshArgs.slice(1);
const started = Date.now();
let timedOut = false;
let finished = false;
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

const child = spawn(sshBin, sshRest, {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let killTimer = null;

function hardKill() {
  if (process.platform === "win32" && child.pid) {
    try {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      /* fall back to node signals */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
}

const timeoutTimer = setTimeout(() => {
  timedOut = true;
  try {
    child.kill(process.platform === "win32" ? undefined : "SIGTERM");
  } catch {
    /* ignore */
  }
  killTimer = setTimeout(() => {
    hardKill();
    finish(null, "SIGKILL");
  }, killGraceMs);
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
  if (finished) {
    return;
  }
  finished = true;
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
    command: sshArgs,
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
  console.error(`ssh-run: failed to spawn ${sshBin}: ${err.message}`);
  writeJson({
    exitCode: 125,
    timedOut: false,
    error: err.message,
    timeoutLimitSec: timeoutSec,
    label: label || null,
    command: sshArgs,
  });
  process.exit(125);
});

child.once("close", (code, signal) => {
  const exitCode = code ?? (signal ? 1 : 0);
  finish(exitCode, signal);
});
