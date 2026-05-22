import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { log } from "../shared/logging.js";

const execFileAsync = promisify(execFile);

export interface DockerPortMap {
  privatePort: number;
  publicPort: number;
}

export interface DockerRunOptions {
  image: string;
  name: string;
  sessionId: string;
  autoRemove?: boolean;
  memoryMb?: number;
  memoryReservationMb?: number;
  shmSizeMb?: number;
  network?: string;
  addHostGateway?: boolean;
  env?: Record<string, string>;
}

function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { windowsHide: true });
  return stdout.trim();
}

export async function dockerRun(options: DockerRunOptions): Promise<string> {
  const args = [
    "run",
    "-d",
    "--name",
    options.name,
    "--label",
    `baselayer.session-id=${options.sessionId}`,
    "--label",
    "baselayer.managed=true",
    "-P",
  ];

  if (options.autoRemove !== false) {
    args.splice(2, 0, "--rm");
  }

  if ((options.memoryMb ?? 0) > 0) {
    args.push("--memory", `${options.memoryMb}m`);
    args.push("--memory-swap", `${options.memoryMb}m`);
  }

  if ((options.memoryReservationMb ?? 0) > 0) {
    args.push("--memory-reservation", `${options.memoryReservationMb}m`);
  }

  if ((options.shmSizeMb ?? 0) > 0) {
    args.push("--shm-size", `${options.shmSizeMb}m`);
  }

  if (options.network) {
    args.push("--network", options.network);
  }

  if (options.addHostGateway !== false) {
    args.push("--add-host", "host.docker.internal:host-gateway");
  }

  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(options.image);
  return docker(args);
}

export async function dockerRemove(containerId: string): Promise<void> {
  await docker(["rm", "-f", containerId]);
}

export async function dockerInspectPorts(containerId: string): Promise<DockerPortMap[]> {
  const output = await docker([
    "inspect",
    containerId,
    "--format",
    "{{json .NetworkSettings.Ports}}",
  ]);

  const parsed = JSON.parse(output) as Record<
    string,
    Array<{ HostPort: string }> | null
  >;

  const results: DockerPortMap[] = [];
  for (const [key, mappings] of Object.entries(parsed)) {
    const privatePort = Number.parseInt(key.split("/")[0] ?? "0", 10);
    const publicPort = Number.parseInt(mappings?.[0]?.HostPort ?? "0", 10);
    if (privatePort > 0 && publicPort > 0) {
      results.push({ privatePort, publicPort });
    }
  }

  return results;
}

export async function dockerInspectRunning(containerId: string): Promise<boolean> {
  const output = await docker([
    "inspect",
    containerId,
    "--format",
    "{{.State.Running}}",
  ]);
  return output === "true";
}

export async function dockerInspectState(containerId: string): Promise<{
  running: boolean;
  exitCode: number;
  oomKilled: boolean;
}> {
  const output = await docker([
    "inspect",
    containerId,
    "--format",
    "{{json .State}}",
  ]);

  const parsed = JSON.parse(output) as {
    Running?: boolean;
    ExitCode?: number;
    OOMKilled?: boolean;
  };

  return {
    running: parsed.Running === true,
    exitCode: Number.isFinite(parsed.ExitCode) ? Number(parsed.ExitCode) : 0,
    oomKilled: parsed.OOMKilled === true,
  };
}

export async function dockerStats(containerId: string): Promise<{ memoryMb: number; cpuPct: number }> {
  const output = await docker([
    "stats",
    "--no-stream",
    "--format",
    "{{json .}}",
    containerId,
  ]);

  const parsed = JSON.parse(output) as {
    CPUPerc: string;
    MemUsage: string;
  };

  return {
    cpuPct: parsePercent(parsed.CPUPerc),
    memoryMb: parseMemoryMb(parsed.MemUsage),
  };
}

export async function dockerRendererCount(containerId: string): Promise<number> {
  try {
    const output = await docker([
      "exec",
      containerId,
      "bash",
      "-lc",
      "ps -eo comm=,args= | awk '$1 == \"chrome\" && $0 ~ /--type=renderer/ { count++ } END { print count + 0 }'",
    ]);
    return Number.parseInt(output || "0", 10) || 0;
  } catch {
    return 0;
  }
}

export async function dockerShmUsage(
  containerId: string,
): Promise<{ usedMb: number; capacityMb: number }> {
  try {
    const output = await docker([
      "exec",
      containerId,
      "bash",
      "-lc",
      "df -k /dev/shm | tail -1 | awk '{print $2\" \"$3}'",
    ]);
    const [capacityKbRaw, usedKbRaw] = output.split(/\s+/);
    const capacityKb = Number.parseInt(capacityKbRaw ?? "0", 10) || 0;
    const usedKb = Number.parseInt(usedKbRaw ?? "0", 10) || 0;
    return {
      capacityMb: Math.round(capacityKb / 1024),
      usedMb: Math.round(usedKb / 1024),
    };
  } catch {
    return { capacityMb: 0, usedMb: 0 };
  }
}

export async function dockerLogs(containerId: string): Promise<string[]> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["logs", "--tail", "50", containerId],
      { windowsHide: true },
    );
    return splitLines(`${stdout}\n${stderr}`);
  } catch {
    return [];
  }
}

export async function waitForLogMatch(
  containerId: string,
  pattern: RegExp,
  timeoutMs: number,
): Promise<RegExpMatchArray> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = await dockerLogs(containerId);
    for (const line of lines) {
      const match = line.match(pattern);
      if (match) {
        return match;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  log("node-agent", "log-wait-timeout", { containerId, timeoutMs, pattern: pattern.source });
  throw new Error(`Timed out waiting for ${pattern.source} in container logs`);
}

function parsePercent(raw: string): number {
  return Number.parseFloat(raw.replace("%", "").trim()) || 0;
}

function parseMemoryMb(raw: string): number {
  const left = raw.split("/")[0]?.trim() ?? "0B";
  const match = left.match(/^([\d.]+)\s*([KMG]i?B)$/i);
  if (!match) {
    return 0;
  }

  const value = Number.parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit.startsWith("G")) {
    return Math.round(value * 1024);
  }
  if (unit.startsWith("M")) {
    return Math.round(value);
  }
  if (unit.startsWith("K")) {
    return Math.round(value / 1024);
  }
  return 0;
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  log("node-agent", "http-wait-timeout", { url, timeoutMs });
  throw new Error(`Timed out waiting for ${url}`);
}

export async function waitForJson<T>(url: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return (await response.json()) as T;
      }
    } catch {
      // Retry.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  log("node-agent", "json-wait-timeout", { url, timeoutMs });
  throw new Error(`Timed out waiting for JSON from ${url}`);
}
