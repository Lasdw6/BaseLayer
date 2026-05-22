import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { average, percentile } from "./lib/stats.js";

const execFileAsync = promisify(execFile);
const iterations = Number.parseInt(process.env["BENCH_ITERATIONS"] ?? "3", 10);
const distro = process.env["FIRECRACKER_WSL_DISTRO"] ?? "Ubuntu";
const scriptPath = toWslPath(path.join(process.cwd(), "scripts", "bench", "firecracker-boot.sh"));

function toWslPath(windowsPath: string): string {
  const normalized = windowsPath.replace(/\\/g, "/");
  return normalized.replace(/^([A-Za-z]):/, (_, drive: string) => `/mnt/${drive.toLowerCase()}`);
}

async function runBootIteration(): Promise<number> {
  const { stdout } = await execFileAsync(
    "wsl",
    ["-d", distro, "-u", "root", "bash", scriptPath],
    {
      cwd: process.cwd(),
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
    },
  );

  const parsed = JSON.parse(stdout.trim()) as { bootMs: number };
  return parsed.bootMs;
}

const bootValues: number[] = [];
for (let index = 0; index < iterations; index += 1) {
  bootValues.push(await runBootIteration());
}

console.log(
  JSON.stringify(
    {
      benchmark: "firecracker-wsl",
      distro,
      iterations,
      bootMs: bootValues,
      avgBootMs: average(bootValues),
      p50BootMs: percentile(bootValues, 50),
      p95BootMs: percentile(bootValues, 95),
    },
    null,
    2,
  ),
);
