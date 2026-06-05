#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, "run-browserarena-selfhosted.ps1");

const optionMap = new Map([
  ["mode", "Mode"],
  ["aws-profile", "AwsProfile"],
  ["region", "Region"],
  ["metal-instance-type", "MetalInstanceType"],
  ["runner-instance-type", "RunnerInstanceType"],
  ["baselayer-repo", "BaseLayerRepo"],
  ["baselayer-ref", "BaseLayerRef"],
  ["browserarena-repo", "BrowserArenaRepo"],
  ["browserarena-ref", "BrowserArenaRef"],
  ["browserarena-path", "BrowserArenaPath"],
  ["target", "Target"],
  ["concurrency", "Concurrency"],
  ["runs", "Runs"],
  ["repeats", "Repeats"],
  ["runtime-profile", "RuntimeProfile"],
  ["runner-metadata-path", "RunnerMetadataPath"],
  ["metal-public-ip", "MetalPublicIp"],
  ["metal-ssh-key-path", "MetalSshKeyPath"],
  ["metal-ssh-user", "MetalSshUser"],
  ["metal-remote-cwd", "MetalRemoteCwd"],
  ["metal-instance-id", "MetalInstanceId"],
  ["ssh-timeout-sec", "SshTimeoutSec"],
  ["setup-timeout-sec", "SetupTimeoutSec"],
  ["bench-timeout-sec", "BenchTimeoutSec"],
  ["out-dir", "OutDir"],
]);

const switchMap = new Map([
  ["reuse-runner", "ReuseRunner"],
  ["keep-metal", "KeepMetal"],
  ["keep-runner", "KeepRunner"],
  ["skip-metal-bootstrap", "SkipMetalBootstrap"],
  ["no-open-ssh-to-world", "NoOpenSshToWorld"],
  ["use-running-baselayer", "UseRunningBaseLayer"],
]);

function usage() {
  console.log(`Usage:
  npm run bench:browserarena:selfhosted -- -- --mode runner --repeats 3 --target https://example.com
  npm run bench:browserarena:selfhosted -- -- --mode local --browserarena-path ../browserarena --repeats 1

Direct Node usage also works without the extra separator:
  node scripts/bench/run-browserarena-selfhosted.mjs --mode runner --repeats 3

Common options:
  --mode runner|local
  --region us-east-1
  --baselayer-repo https://github.com/Lasdw6/BaseLayer.git
  --baselayer-ref main
  --browserarena-repo <repo-with-baselayer-provider>
  --browserarena-ref <branch>
  --browserarena-path <local-checkout>      required for --mode local
  --target https://example.com
  --concurrency 1,10
  --runs 100
  --repeats 1
  --reuse-runner --runner-metadata-path .tmp/runner.json
  --metal-public-ip <ip> --metal-ssh-key-path <key.pem>
  --use-running-baselayer                 use an already-running BaseLayer API on the supplied metal host
  --keep-metal
  --keep-runner
  --skip-metal-bootstrap

The script provisions fresh metal unless --metal-public-ip is supplied, sets up
BaseLayer from the requested repo/ref unless --use-running-baselayer is supplied,
waits for health + warm pool readiness, runs BrowserArena, pulls artifacts, writes
summary.json, and tears down resources unless keep flags are provided.`);
}

const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script];
const raw = process.argv.slice(2);

for (let i = 0; i < raw.length; i += 1) {
  const arg = raw[i];
  if (arg === "--") {
    continue;
  }
  if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  }
  if (!arg.startsWith("--")) {
    console.error(`Unexpected positional argument: ${arg}`);
    usage();
    process.exit(2);
  }

  const withoutPrefix = arg.slice(2);
  const eq = withoutPrefix.indexOf("=");
  const key = eq >= 0 ? withoutPrefix.slice(0, eq) : withoutPrefix;
  const inlineValue = eq >= 0 ? withoutPrefix.slice(eq + 1) : null;

  if (switchMap.has(key)) {
    psArgs.push(`-${switchMap.get(key)}`);
    continue;
  }

  if (!optionMap.has(key)) {
    console.error(`Unknown option: --${key}`);
    usage();
    process.exit(2);
  }

  const value = inlineValue ?? raw[++i];
  if (value === undefined || value.startsWith("--")) {
    console.error(`Missing value for --${key}`);
    process.exit(2);
  }
  psArgs.push(`-${optionMap.get(key)}`, value);
}

const child = spawn("powershell", psArgs, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
