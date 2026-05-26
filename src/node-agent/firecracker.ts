import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium } from "playwright-core";

import { agentConfig } from "../shared/config.js";
import { log, logError } from "../shared/logging.js";
import {
  type LaunchTiming,
  type RuntimeLaunchResult,
  type SessionLogSnapshot,
  type SessionActivityState,
} from "../shared/types.js";

const execFileAsync = promisify(execFile);
const PROCESS_CLOCK_TICKS_PER_SECOND = 100;
const DEFAULT_SYSTEM_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const SYSTEM_COMMAND_OVERRIDES: Record<string, string> = {
  sudo: "/usr/bin/sudo",
  ip: "/bin/ip",
  iptables: "/usr/sbin/iptables",
  mkdir: "/usr/bin/mkdir",
  rmdir: "/usr/bin/rmdir",
  cat: "/usr/bin/cat",
  sh: "/usr/bin/sh",
  socat: "/usr/bin/socat",
  taskset: "/usr/bin/taskset",
};

/** Linux `struct sockaddr_un.sun_path` is 108 bytes including the terminating NUL. */
const MAX_AF_UNIX_SOCKET_PATH_BYTES = 107;

function assertFirecrackerApiSocketPathLength(apiSocketPath: string): void {
  const len = Buffer.byteLength(apiSocketPath, "utf8");
  if (len > MAX_AF_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(
      `Firecracker API socket path exceeds Linux AF_UNIX limit (${len} > ${MAX_AF_UNIX_SOCKET_PATH_BYTES} bytes): ${apiSocketPath}. ` +
        `Set FIRECRACKER_API_DIR to a short directory (for example /run/fc/api).`,
    );
  }
}

interface TcpRelay {
  port: number;
  close(): Promise<void>;
}

type FirecrackerNetworkSlotState = "free" | "reserved" | "unhealthy" | "rebuilding";

export function canReleaseFirecrackerNetworkSlot(
  state: FirecrackerNetworkSlotState | undefined,
): boolean {
  return state === "reserved";
}

export function shouldRetryFirecrackerRestoreError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("/json/version") ||
    message.includes("/json/list") ||
    message.includes("websocket upgrade") ||
    (message.includes("timed out") && message.includes("127.0.0.1")) ||
    (message.includes("fetch failed") && message.includes("127.0.0.1"))
  );
}

function remainingDeadlineTimeoutMs(deadlineMs: number, nowMs = Date.now()): number {
  return Math.max(1, deadlineMs - nowMs);
}

interface PrivilegedProcess {
  child: ChildProcess;
  kill(signal?: NodeJS.Signals | number): void;
}

interface FirecrackerNetworkSlot {
  slotId: string;
  slotIndex: number;
  tapName: string;
  netnsName: string;
  rootVethName: string;
  nsVethName: string;
  rootVethIp: string;
  nsVethIp: string;
  hostIp: string;
  guestIp: string;
  guestMac: string;
  state: FirecrackerNetworkSlotState;
  lastValidationAt?: string;
  lastSessionId?: string;
  requiresClaimValidation?: boolean;
}

export interface FirecrackerMachineHandle {
  instanceId: string;
  apiSocketPath: string;
  stateDir: string;
  cgroupPath?: string;
  tapName: string;
  netnsName: string;
  rootVethName: string;
  nsVethName: string;
  rootVethIp: string;
  nsVethIp: string;
  hostIp: string;
  guestIp: string;
  guestMac: string;
  relay: TcpRelay;
  process: PrivilegedProcess;
  proxyProcess: PrivilegedProcess;
  egressProxyProcess?: PrivilegedProcess;
  benchProxyProcess?: PrivilegedProcess;
  firecrackerPid?: number;
  networkSlotId: string;
  startedAt: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  debugHttpUrl(): string;
  localDebugHttpUrl(): string;
}

export interface FirecrackerSnapshotInfo {
  name: string;
  snapshotPath: string;
  memFilePath: string;
  metadataPath: string;
}

interface FirecrackerSnapshotMetadata {
  createdAt: string;
  kernelPath: string;
  rootfsPath: string;
  guestIp: string;
  hostIp: string;
  guestMac: string;
  guestMemoryMb: number;
  guestVcpuCount: number;
  guestCdpPort: number;
  browserWsPath?: string;
}

interface FirecrackerSessionProxyConfig {
  proxyProfile?: string;
  upstreamProxyUrl?: string;
  requiresLocalProxy?: boolean;
}

interface FirecrackerSnapshotTarget {
  snapshotName: string;
  rootfsPath: string;
  requiresLocalProxy: boolean;
}

interface FirecrackerCpuSample {
  cpuTimeMs: number;
  sampledAtMs: number;
}

interface FirecrackerSchedulerState {
  activityState: SessionActivityState;
  schedulerWeight: number;
  lastActivityAtMs: number;
  lastCpuPct: number;
  lastCpuSample?: FirecrackerCpuSample;
}

interface FirecrackerCpuPolicy {
  schedulerWeight: number;
  cpuWeight: number;
  cpuMax: string;
  cpuAffinity?: string;
}

interface CreateSnapshotOptions {
  instanceId: string;
  snapshotName?: string;
  rootfsPath?: string;
  requiresLocalProxy?: boolean;
  verify?: (machine: FirecrackerMachineHandle) => Promise<void>;
}

interface EnsureSnapshotOptions {
  verify?: (machine: FirecrackerMachineHandle) => Promise<void>;
}

interface SpawnMachineResult {
  machine: FirecrackerMachineHandle;
  launchTimings: Pick<
    LaunchTiming,
    | "networkSetupMs"
    | "networkClaimMs"
    | "networkValidateMs"
    | "networkPrepareMissMs"
    | "helperCleanupMs"
    | "processSpawnMs"
    | "configureMs"
    | "relayReadyMs"
  >;
}

interface FirecrackerCleanupOptions {
  apiDir?: string;
  stateDir?: string;
  tapPrefix?: string;
}

function isLinux(): boolean {
  return process.platform === "linux";
}

function requireLinux(feature: string): void {
  if (!isLinux()) {
    throw new Error(`${feature} requires a Linux host with KVM support.`);
  }
}

function bytesToMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function parseCidrBase(cidr: string): number {
  const [ip, prefixRaw] = cidr.split("/");
  const prefix = Number.parseInt(prefixRaw ?? "0", 10);
  if (!ip || prefix !== 16) {
    throw new Error(`Unsupported FIRECRACKER_GUEST_BASE_CIDR: ${cidr}. Expected a /16 base network.`);
  }

  const octets = ip.split(".").map((value) => Number.parseInt(value, 10));
  if (octets.length !== 4 || octets.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) {
    throw new Error(`Invalid FIRECRACKER_GUEST_BASE_CIDR: ${cidr}`);
  }

  return ((octets[0] ?? 0) << 24) | ((octets[1] ?? 0) << 16) | ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
}

function ipFromNumber(value: number): string {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join(".");
}

function fixedGuestNetwork(): {
  hostIp: string;
  guestIp: string;
  guestMac: string;
} {
  const base = parseCidrBase(agentConfig.firecrackerGuestBaseCidr);
  return {
    hostIp: ipFromNumber(base + 1),
    guestIp: ipFromNumber(base + 2),
    guestMac: "06:fc:00:00:00:00",
  };
}

function namespaceLinkNetworkForIndex(index: number): {
  rootVethIp: string;
  nsVethIp: string;
} {
  const base = parseCidrBase(agentConfig.firecrackerNetnsBaseCidr);
  const networkBase = base + index * 4;
  return {
    rootVethIp: ipFromNumber(networkBase + 1),
    nsVethIp: ipFromNumber(networkBase + 2),
  };
}

function maskForTap(): string {
  return "255.255.255.252";
}

function egressProbeTargets(): Array<{ host: string; port: number }> {
  return agentConfig.firecrackerNetworkSlotEgressProbeTargets
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const [host, portRaw] = value.split(":");
      const port = Number.parseInt(portRaw ?? "53", 10);
      return { host: host ?? "", port };
    })
    .filter((target) => target.host && Number.isFinite(target.port) && target.port > 0);
}

async function waitForPath(targetPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 10;
  while (Date.now() < deadline) {
    if (fs.existsSync(targetPath)) {
      return;
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 100);
  }

  throw new Error(`Timed out waiting for ${targetPath}`);
}

function resolveSystemCommand(command: string): string {
  return SYSTEM_COMMAND_OVERRIDES[command] ?? command;
}

async function execPrivileged(command: string, args: string[]): Promise<void> {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const resolvedCommand = resolveSystemCommand(command);
  const resolvedSudo = resolveSystemCommand("sudo");
  const env = {
    ...process.env,
    PATH: process.env["PATH"]
      ? `${DEFAULT_SYSTEM_PATH}:${process.env["PATH"]}`
      : DEFAULT_SYSTEM_PATH,
  };
  if (isRoot) {
    await execFileAsync(resolvedCommand, args, { windowsHide: true, env });
    return;
  }

  await execFileAsync(resolvedSudo, ["-n", resolvedCommand, ...args], {
    windowsHide: true,
    env,
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function writePrivilegedFile(filePath: string, value: string): Promise<void> {
  const command = `printf '%s' ${shellQuote(value)} > ${shellQuote(filePath)}`;
  await execPrivileged("sh", ["-lc", command]);
}

async function mkdirPrivileged(targetPath: string): Promise<void> {
  await execPrivileged("mkdir", ["-p", targetPath]);
}

async function rmdirPrivileged(targetPath: string): Promise<void> {
  await execPrivileged("rmdir", [targetPath]);
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    const resolvedCat = resolveSystemCommand("cat");
    const resolvedSudo = resolveSystemCommand("sudo");
    const invocation = isRoot
      ? { command: resolvedCat, args: [filePath] }
      : { command: resolvedSudo, args: ["-n", resolvedCat, filePath] };
    const { stdout } = await execFileAsync(invocation.command, invocation.args, {
      windowsHide: true,
    });
    return stdout;
  }
}

function spawnPrivileged(
  command: string,
  args: string[],
  options: {
    cwd: string;
    stdio: ["ignore", "pipe", "pipe"];
    env?: NodeJS.ProcessEnv;
  },
): PrivilegedProcess {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const resolvedCommand = resolveSystemCommand(command);
  const resolvedSudo = resolveSystemCommand("sudo");
  const shellCommand = ["exec", shellQuote(resolvedCommand), ...args.map((arg) => shellQuote(arg))]
    .join(" ");
  const env = {
    ...process.env,
    ...options.env,
    PATH: options.env?.["PATH"]
      ? `${DEFAULT_SYSTEM_PATH}:${options.env["PATH"]}`
      : process.env["PATH"]
        ? `${DEFAULT_SYSTEM_PATH}:${process.env["PATH"]}`
        : DEFAULT_SYSTEM_PATH,
  };
  const child = (isRoot
    ? spawn(resolveSystemCommand("sh"), ["-lc", shellCommand], { ...options, env })
    : spawn(resolvedSudo, ["-n", resolveSystemCommand("sh"), "-lc", shellCommand], {
        ...options,
        env,
      })) as ChildProcess;

  return {
    child,
    kill(signal) {
      child.kill(signal);
    },
  };
}

async function stopPrivilegedProcess(
  process: PrivilegedProcess | undefined,
  graceMs: number,
): Promise<void> {
  if (!process) {
    return;
  }

  process.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => process.child.once("exit", () => resolve())),
    sleep(graceMs),
  ]);

  if (process.child.exitCode === null && process.child.signalCode === null) {
    process.kill("SIGKILL");
    await Promise.race([
      new Promise<void>((resolve) => process.child.once("exit", () => resolve())),
      sleep(100),
    ]);
  }
}

async function removeTapDevice(tapName: string): Promise<void> {
  try {
    await execPrivileged("ip", ["link", "del", tapName]);
  } catch {
    // Ignore if already removed.
  }
}

async function setupTapDevice(tapName: string, hostIp: string): Promise<void> {
  await removeTapDevice(tapName);
  await execPrivileged("ip", ["tuntap", "add", "dev", tapName, "mode", "tap"]);
  await execPrivileged("ip", ["addr", "add", `${hostIp}/30`, "dev", tapName]);
  await execPrivileged("ip", ["link", "set", "dev", tapName, "up"]);
}

async function execInNetns(netnsName: string, command: string, args: string[]): Promise<void> {
  await execPrivileged("ip", ["netns", "exec", netnsName, command, ...args]);
}

async function execInNetnsOutput(
  netnsName: string,
  command: string,
  args: string[],
): Promise<string> {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const resolvedIp = resolveSystemCommand("ip");
  const resolvedCommand = resolveSystemCommand(command);
  const resolvedSudo = resolveSystemCommand("sudo");
  const invocation = isRoot
    ? { command: resolvedIp, args: ["netns", "exec", netnsName, resolvedCommand, ...args] }
    : {
        command: resolvedSudo,
        args: ["-n", resolvedIp, "netns", "exec", netnsName, resolvedCommand, ...args],
      };
  const { stdout } = await execFileAsync(invocation.command, invocation.args, {
    windowsHide: true,
  });
  return stdout;
}

async function removeNetns(netnsName: string): Promise<void> {
  try {
    await execPrivileged("ip", ["netns", "del", netnsName]);
  } catch {
    // Ignore if already removed.
  }
}

async function detectHostEgressInterface(): Promise<string> {
  if (agentConfig.firecrackerEgressInterface) {
    return agentConfig.firecrackerEgressInterface;
  }

  const { stdout } = await execFileAsync("ip", ["route", "show", "default"], {
    windowsHide: true,
  });
  for (const line of stdout.split(/\r?\n/)) {
    const match = /\bdev\s+(\S+)/.exec(line);
    if (match?.[1]) {
      return match[1];
    }
  }

  throw new Error("Could not detect host default egress interface.");
}

async function ensureSysctlValue(
  name: string,
  value: string,
  netnsName?: string,
): Promise<void> {
  const args = ["-w", `${name}=${value}`];
  if (netnsName) {
    await execInNetns(netnsName, "sysctl", args);
    return;
  }
  await execPrivileged("sysctl", args);
}

async function ensureIptablesRule(
  table: "filter" | "nat",
  chain: string,
  ruleArgs: string[],
  netnsName?: string,
): Promise<void> {
  const checkArgs = ["-t", table, "-C", chain, ...ruleArgs];
  const addArgs = ["-t", table, "-A", chain, ...ruleArgs];
  try {
    if (netnsName) {
      await execInNetns(netnsName, "iptables", checkArgs);
    } else {
      await execPrivileged("iptables", checkArgs);
    }
    return;
  } catch {
    if (netnsName) {
      await execInNetns(netnsName, "iptables", addArgs);
    } else {
      await execPrivileged("iptables", addArgs);
    }
  }
}

async function ensureHostInternetEgress(tapPrefix: string): Promise<void> {
  if (!agentConfig.firecrackerEnableInternetEgress) {
    return;
  }

  const egressInterface = await detectHostEgressInterface();
  await ensureSysctlValue("net.ipv4.ip_forward", "1");
  await ensureIptablesRule("filter", "FORWARD", ["-i", `${tapPrefix}+`, "-o", egressInterface, "-j", "ACCEPT"]);
  await ensureIptablesRule("filter", "FORWARD", [
    "-i",
    egressInterface,
    "-o",
    `${tapPrefix}+`,
    "-m",
    "conntrack",
    "--ctstate",
    "ESTABLISHED,RELATED",
    "-j",
    "ACCEPT",
  ]);
  await ensureIptablesRule("nat", "POSTROUTING", [
    "-s",
    agentConfig.firecrackerNetnsBaseCidr,
    "-o",
    egressInterface,
    "-j",
    "MASQUERADE",
  ]);
}

async function setupNamespacedNetwork(
  netnsName: string,
  tapName: string,
  rootVethName: string,
  nsVethName: string,
  rootVethIp: string,
  nsVethIp: string,
  tapHostIp: string,
): Promise<void> {
  await removeNetns(netnsName);
  try {
    await execPrivileged("ip", ["link", "del", rootVethName]);
  } catch {
    // Ignore if already removed.
  }

  await Promise.all([
    execPrivileged("ip", ["netns", "add", netnsName]),
    execPrivileged("ip", ["link", "add", rootVethName, "type", "veth", "peer", "name", nsVethName]),
  ]);

  await Promise.all([
    execPrivileged("ip", ["link", "set", nsVethName, "netns", netnsName]),
    execPrivileged("ip", ["addr", "add", `${rootVethIp}/30`, "dev", rootVethName]),
    execPrivileged("ip", ["link", "set", "dev", rootVethName, "up"]),
  ]);

  await Promise.all([
    execInNetns(netnsName, "ip", ["link", "set", "dev", "lo", "up"]),
    execInNetns(netnsName, "ip", ["addr", "add", `${nsVethIp}/30`, "dev", nsVethName]),
    execInNetns(netnsName, "ip", ["link", "set", "dev", nsVethName, "up"]),
  ]);

  // TAP setup is intentionally sequential. `ip tuntap add`, `ip addr add`, and
  // `ip link set up` race when run in parallel and intermittently fail during
  // large pool rebuilds with "Cannot find device".
  await execInNetns(netnsName, "ip", ["tuntap", "add", "dev", tapName, "mode", "tap"]);
  await execInNetns(netnsName, "ip", ["addr", "add", `${tapHostIp}/30`, "dev", tapName]);
  await execInNetns(netnsName, "ip", ["link", "set", "dev", tapName, "up"]);

  if (agentConfig.firecrackerEnableInternetEgress) {
    await Promise.all([
      execInNetns(netnsName, "ip", ["route", "replace", "default", "via", rootVethIp, "dev", nsVethName]),
      ensureSysctlValue("net.ipv4.ip_forward", "1", netnsName),
      ensureIptablesRule("filter", "FORWARD", ["-i", tapName, "-o", nsVethName, "-j", "ACCEPT"], netnsName),
      ensureIptablesRule("filter", "FORWARD", [
        "-i",
        nsVethName,
        "-o",
        tapName,
        "-m",
        "conntrack",
        "--ctstate",
        "ESTABLISHED,RELATED",
        "-j",
        "ACCEPT",
      ], netnsName),
      ensureIptablesRule("nat", "POSTROUTING", [
        "-s",
        `${fixedGuestNetwork().guestIp}/32`,
        "-o",
        nsVethName,
        "-j",
        "MASQUERADE",
      ], netnsName),
    ]);
  }
}

async function commandSucceeds(command: string, args: string[]): Promise<boolean> {
  try {
    await execPrivileged(command, args);
    return true;
  } catch {
    return false;
  }
}

async function validateSlotNetwork(slot: FirecrackerNetworkSlot): Promise<boolean> {
  const [rootVethExists, rootAddressPresent, tapExists, tapAddressPresent] = await Promise.all([
    commandSucceeds("ip", ["link", "show", "dev", slot.rootVethName]),
    commandSucceeds("ip", [
      "addr",
      "show",
      "dev",
      slot.rootVethName,
      "to",
      `${slot.rootVethIp}/30`,
    ]),
    commandSucceeds("ip", [
      "netns",
      "exec",
      slot.netnsName,
      "ip",
      "link",
      "show",
      "dev",
      slot.tapName,
    ]),
    commandSucceeds("ip", [
      "netns",
      "exec",
      slot.netnsName,
      "ip",
      "addr",
      "show",
      "dev",
      slot.tapName,
      "to",
      `${slot.hostIp}/30`,
    ]),
  ]);

  if (!rootVethExists || !rootAddressPresent || !tapExists || !tapAddressPresent) {
    return false;
  }

  const namespaces = await listNetNamespaces();
  if (!namespaces.includes(slot.netnsName)) {
    return false;
  }

  const nsVethExists = await commandSucceeds("ip", [
    "netns",
    "exec",
    slot.netnsName,
    "ip",
    "link",
    "show",
    "dev",
    slot.nsVethName,
  ]);
  return nsVethExists;
}

async function validateSlotNetworkFast(slot: FirecrackerNetworkSlot): Promise<boolean> {
  const [namespaces, rootVethExists, tapExists] = await Promise.all([
    listNetNamespaces(),
    commandSucceeds("ip", ["link", "show", "dev", slot.rootVethName]),
    commandSucceeds("ip", [
      "netns",
      "exec",
      slot.netnsName,
      "ip",
      "link",
      "show",
      "dev",
      slot.tapName,
    ]),
  ]);
  if (!namespaces.includes(slot.netnsName)) {
    return false;
  }
  if (!rootVethExists) {
    return false;
  }
  return tapExists;
}

async function commandSucceedsInNetnsWithTimeout(
  netnsName: string,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<boolean> {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const resolvedCommand = resolveSystemCommand(command);
  const resolvedIp = resolveSystemCommand("ip");
  const resolvedSudo = resolveSystemCommand("sudo");
  const env = {
    ...process.env,
    PATH: process.env["PATH"]
      ? `${DEFAULT_SYSTEM_PATH}:${process.env["PATH"]}`
      : DEFAULT_SYSTEM_PATH,
  };

  try {
    if (isRoot) {
      await execFileAsync(resolvedIp, ["netns", "exec", netnsName, resolvedCommand, ...args], {
        windowsHide: true,
        env,
        timeout: timeoutMs,
      });
    } else {
      await execFileAsync(
        resolvedSudo,
        ["-n", resolvedIp, "netns", "exec", netnsName, resolvedCommand, ...args],
        {
          windowsHide: true,
          env,
          timeout: timeoutMs,
        },
      );
    }
    return true;
  } catch {
    return false;
  }
}

async function validateSlotEgressFast(slot: FirecrackerNetworkSlot): Promise<boolean> {
  if (!agentConfig.firecrackerEnableInternetEgress) {
    return true;
  }

  const targets = egressProbeTargets();
  if (targets.length === 0) {
    return true;
  }

  for (const target of targets) {
    const shellCommand = `exec 3<>/dev/tcp/${target.host}/${target.port}; exec 3<&-; exec 3>&-`;
    const ok = await commandSucceedsInNetnsWithTimeout(
      slot.netnsName,
      "bash",
      ["-lc", shellCommand],
      agentConfig.firecrackerNetworkSlotEgressProbeTimeoutMs,
    );
    if (ok) {
      return true;
    }
  }

  return false;
}

async function createTcpRelay(host: string, guestIp: string, guestPort: number): Promise<TcpRelay> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((incoming) => {
    const outgoing = net.createConnection({
      host: guestIp,
      port: guestPort,
    });
    sockets.add(incoming);
    sockets.add(outgoing);
    const cleanup = () => {
      sockets.delete(incoming);
      sockets.delete(outgoing);
    };
    incoming.pipe(outgoing);
    outgoing.pipe(incoming);
    outgoing.on("error", () => incoming.destroy());
    incoming.on("error", () => outgoing.destroy());
    outgoing.on("close", cleanup);
    incoming.on("close", cleanup);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate relay port for Firecracker guest.");
  }

  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function firecrackerRequest(
  socketPath: string,
  method: string,
  targetPath: string,
  body?: Record<string, unknown>,
): Promise<string> {
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return new Promise<string>((resolve, reject) => {
    const request = http.request(
      {
        method,
        path: targetPath,
        socketPath,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`Firecracker ${method} ${targetPath} failed: ${response.statusCode} ${text}`));
            return;
          }
          resolve(text);
        });
      },
    );

    request.once("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

async function waitForJson<T>(url: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let delay = 10;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithDeadline(url, undefined, deadline);
      if (response.ok) {
        return (await response.json()) as T;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(delay);
    delay = Math.min(delay * 1.5, 100);
  }

  throw new Error(
    `Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function fetchWithDeadline(
  url: string,
  init: RequestInit | undefined,
  deadline: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.min(5_000, Math.max(1, deadline - Date.now())),
  );
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function devtoolsPutJson<T>(url: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let delay = 10;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithDeadline(url, {
        method: "PUT",
      }, deadline);
      if (!response.ok) {
        throw new Error(`DevTools PUT ${url} failed with ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      await sleep(delay);
      delay = Math.min(delay * 1.5, 100);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for DevTools PUT ${url}`);
}

async function maybePrecreateTarget(debugHttpUrl: string): Promise<void> {
  const targetUrl = agentConfig.firecrackerPrecreateTargetUrl;
  if (!targetUrl) {
    return;
  }

  const createUrl = debugHttpUrl.replace(
    /\/json\/version$/,
    `/json/new?${encodeURIComponent(targetUrl)}`,
  );
  await devtoolsPutJson<{ id?: string }>(createUrl, agentConfig.firecrackerBootTimeoutMs);
}

async function waitForDevtoolsTargetList(debugHttpUrl: string, timeoutMs: number): Promise<void> {
  const listUrl = debugHttpUrl.replace(/\/json\/version$/, "/json/list");
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let delay = 10;

  while (Date.now() < deadline) {
    try {
      const targets = await waitForJson<Array<{ id?: string; type?: string }>>(
        listUrl,
        remainingDeadlineTimeoutMs(deadline),
      );
      if (targets.some((target) => target.type === "page" && target.id)) {
        return;
      }
      throw new Error("DevTools target list has no page target yet.");
    } catch (error) {
      lastError = error;
      await sleep(delay);
      delay = Math.min(delay * 1.5, 100);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for DevTools target list at ${listUrl}`);
}

function tailFile(filePath: string, maxLines = 80): string {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-maxLines)
      .join("\n");
  } catch {
    return "";
  }
}

function browserWsPathFromDebuggerUrl(webSocketDebuggerUrl: string): string {
  const parsed = new URL(webSocketDebuggerUrl);
  return `${parsed.pathname}${parsed.search}`;
}

function bootArgs(hostIp: string, guestIp: string): string {
  const args = [
    "console=ttyS0",
    "reboot=k",
    "panic=1",
    "pci=off",
    "ipv6.disable=1",
    "init=/init",
    `ip=${guestIp}::${hostIp}:${maskForTap()}::eth0:off`,
  ];

  if (agentConfig.firecrackerGuestBootArgsExtra) {
    args.push(agentConfig.firecrackerGuestBootArgsExtra);
  }

  return args.join(" ");
}

function snapshotInfo(name = agentConfig.firecrackerSnapshotName): FirecrackerSnapshotInfo {
  const dir = path.join(agentConfig.firecrackerSnapshotDir, name);
  return {
    name,
    snapshotPath: path.join(dir, "vmstate.snap"),
    memFilePath: path.join(dir, "memory.snap"),
    metadataPath: path.join(dir, "metadata.json"),
  };
}

function snapshotTargetForProxyConfig(
  proxyConfig: FirecrackerSessionProxyConfig,
): FirecrackerSnapshotTarget {
  if (proxyConfig.requiresLocalProxy) {
    return {
      snapshotName: agentConfig.firecrackerProxySnapshotName,
      rootfsPath: agentConfig.firecrackerProxyRootfsPath,
      requiresLocalProxy: true,
    };
  }

  return {
    snapshotName: agentConfig.firecrackerSnapshotName,
    rootfsPath: agentConfig.firecrackerRootfsPath,
    requiresLocalProxy: false,
  };
}

function readSnapshotMetadata(
  spec: FirecrackerSnapshotInfo,
): FirecrackerSnapshotMetadata | undefined {
  try {
    const raw = fs.readFileSync(spec.metadataPath, "utf8");
    return JSON.parse(raw) as FirecrackerSnapshotMetadata;
  } catch {
    return undefined;
  }
}

function resolveProxyProfile(proxyProfile?: string): FirecrackerSessionProxyConfig {
  if (!proxyProfile || proxyProfile === "direct") {
    return { proxyProfile };
  }

  if (proxyProfile === "local") {
    return {
      proxyProfile,
      requiresLocalProxy: true,
    };
  }

  if (proxyProfile === "proxy") {
    return {
      proxyProfile,
      requiresLocalProxy: true,
    };
  }

  if (/^http:\/\//i.test(proxyProfile)) {
    return {
      proxyProfile,
      upstreamProxyUrl: proxyProfile,
      requiresLocalProxy: true,
    };
  }

  if (!agentConfig.firecrackerProxyProfilesJson) {
    throw new Error(`Unknown proxy profile '${proxyProfile}'.`);
  }

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(agentConfig.firecrackerProxyProfilesJson) as Record<string, string>;
  } catch (error) {
    throw new Error(
      `Invalid FIRECRACKER_PROXY_PROFILES_JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const resolved = parsed[proxyProfile];
  if (!resolved) {
    throw new Error(`Unknown proxy profile '${proxyProfile}'.`);
  }
  if (!/^http:\/\//i.test(resolved)) {
    throw new Error(`Proxy profile '${proxyProfile}' must resolve to an http:// URL.`);
  }

  return {
    proxyProfile,
    upstreamProxyUrl: resolved,
    requiresLocalProxy: true,
  };
}

async function findFirecrackerPidBySocketPath(socketPath: string): Promise<number | undefined> {
  const pids = await listProcessesBySocketPath(socketPath);
  return pids.find((pid) => Number.isFinite(pid) && pid > 0);
}

function readProcessRssMb(pid: number): number {
  try {
    const smaps = fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const rssMatch = /^Rss:\s+(\d+)\s+kB$/m.exec(smaps);
    if (rssMatch?.[1]) {
      return Math.round(Number.parseInt(rssMatch[1], 10) / 1024);
    }
  } catch {
    // Fall back to status below.
  }

  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const vmMatch = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (vmMatch?.[1]) {
      return Math.round(Number.parseInt(vmMatch[1], 10) / 1024);
    }
  } catch {
    // Ignore.
  }

  return 0;
}

function readProcessCpuTimeMs(pid: number): number {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParenIndex = stat.lastIndexOf(")");
    if (closeParenIndex === -1) {
      return 0;
    }

    const fields = stat
      .slice(closeParenIndex + 2)
      .trim()
      .split(/\s+/);
    const userTicks = Number.parseInt(fields[11] ?? "0", 10) || 0;
    const systemTicks = Number.parseInt(fields[12] ?? "0", 10) || 0;
    return Math.round(
      ((userTicks + systemTicks) * 1000) / PROCESS_CLOCK_TICKS_PER_SECOND,
    );
  } catch {
    return 0;
  }
}

function estimatedMachineMemoryMb(machine: FirecrackerMachineHandle): number {
  if (!machine.firecrackerPid) {
    return agentConfig.firecrackerGuestMemoryMb;
  }

  const processRssMb = readProcessRssMb(machine.firecrackerPid);
  if (processRssMb <= 0) {
    return agentConfig.firecrackerGuestMemoryMb;
  }

  // Firecracker guest memory is not reliably reflected in process RSS on all
  // hosts, so keep the configured guest allocation as a floor.
  return Math.max(processRssMb, agentConfig.firecrackerGuestMemoryMb);
}

function schedulerWeightForState(activityState: SessionActivityState): number {
  switch (activityState) {
    case "launching":
      return agentConfig.firecrackerCpuWeightLaunching;
    case "active-navigation":
      return agentConfig.firecrackerCpuWeightActive;
    case "soak-idle":
      return agentConfig.firecrackerCpuWeightSoakIdle;
    case "interactive-idle":
    default:
      return agentConfig.firecrackerCpuWeightInteractiveIdle;
  }
}

function cpuPolicyForState(activityState: SessionActivityState): FirecrackerCpuPolicy {
  switch (activityState) {
    case "launching":
      return {
        schedulerWeight: agentConfig.firecrackerCpuWeightLaunching,
        cpuWeight: agentConfig.firecrackerCpuWeightLaunchingCgroup,
        cpuMax: agentConfig.firecrackerCpuMaxLaunching,
        cpuAffinity: agentConfig.firecrackerCpuAffinityLaunching,
      };
    case "active-navigation":
      return {
        schedulerWeight: agentConfig.firecrackerCpuWeightActive,
        cpuWeight: agentConfig.firecrackerCpuWeightActiveCgroup,
        cpuMax: agentConfig.firecrackerCpuMaxActive,
        cpuAffinity: agentConfig.firecrackerCpuAffinityActive,
      };
    case "soak-idle":
      return {
        schedulerWeight: agentConfig.firecrackerCpuWeightSoakIdle,
        cpuWeight: agentConfig.firecrackerCpuWeightSoakIdleCgroup,
        cpuMax: agentConfig.firecrackerCpuMaxSoakIdle,
        cpuAffinity: agentConfig.firecrackerCpuAffinitySoakIdle,
      };
    case "interactive-idle":
    default:
      return {
        schedulerWeight: agentConfig.firecrackerCpuWeightInteractiveIdle,
        cpuWeight: agentConfig.firecrackerCpuWeightInteractiveIdleCgroup,
        cpuMax: agentConfig.firecrackerCpuMaxInteractiveIdle,
        cpuAffinity: agentConfig.firecrackerCpuAffinityInteractiveIdle,
      };
  }
}

function overflowCpuPolicyForState(activityState: SessionActivityState): FirecrackerCpuPolicy {
  switch (activityState) {
    case "launching":
      return {
        schedulerWeight: agentConfig.firecrackerCpuWeightLaunchingOverflow,
        cpuWeight: agentConfig.firecrackerCpuWeightLaunchingOverflowCgroup,
        cpuMax: agentConfig.firecrackerCpuMaxLaunchingOverflow,
        cpuAffinity: agentConfig.firecrackerCpuAffinityLaunching,
      };
    case "active-navigation":
      return {
        schedulerWeight: agentConfig.firecrackerCpuWeightActiveOverflow,
        cpuWeight: agentConfig.firecrackerCpuWeightActiveOverflowCgroup,
        cpuMax: agentConfig.firecrackerCpuMaxActiveOverflow,
        cpuAffinity: agentConfig.firecrackerCpuAffinityActive,
      };
    case "interactive-idle":
    case "soak-idle":
    default:
      return cpuPolicyForState(activityState);
  }
}

function neutralCpuPolicy(activityState: SessionActivityState): FirecrackerCpuPolicy {
  const cpuAffinity =
    activityState === "launching"
      ? agentConfig.firecrackerCpuAffinityLaunching
      : activityState === "active-navigation"
        ? agentConfig.firecrackerCpuAffinityActive
        : activityState === "soak-idle"
          ? agentConfig.firecrackerCpuAffinitySoakIdle
          : agentConfig.firecrackerCpuAffinityInteractiveIdle;

  return {
    schedulerWeight: 0,
    cpuWeight: 100,
    cpuMax: "max 100000",
    cpuAffinity,
  };
}

async function waitForWebSocketUpgrade(
  host: string,
  port: number,
  requestPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 10;

  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        const timeout = setTimeout(() => {
          socket.destroy(new Error("Timed out waiting for WebSocket readiness."));
        }, Math.min(5_000, Math.max(500, deadline - Date.now())));

        let response = "";
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          socket.removeAllListeners();
          socket.end();
          socket.destroy();
          if (error) {
            reject(error);
            return;
          }
          resolve();
        };

        socket.once("error", (error) => finish(error));
        socket.on("data", (chunk) => {
          response += String(chunk);
          if (!response.includes("\r\n\r\n")) {
            return;
          }

          if (response.startsWith("HTTP/1.1 101") || response.startsWith("HTTP/1.0 101")) {
            finish();
            return;
          }

          finish(new Error(`Unexpected WebSocket response: ${response.split("\r\n", 1)[0] ?? ""}`));
        });
        socket.once("connect", () => {
          const key = randomBytes(16).toString("base64");
          socket.write(
            [
              `GET ${requestPath} HTTP/1.1`,
              `Host: ${host}:${port}`,
              "Upgrade: websocket",
              "Connection: Upgrade",
              `Sec-WebSocket-Key: ${key}`,
              "Sec-WebSocket-Version: 13",
              "",
              "",
            ].join("\r\n"),
          );
        });
      });
      return;
    } catch {
      await sleep(delay);
      delay = Math.min(delay * 1.5, 100);
    }
  }

  throw new Error(`Timed out waiting for WebSocket endpoint ws://${host}:${port}${requestPath}`);
}

async function waitForStableDevtoolsReady(
  machine: FirecrackerMachineHandle,
  browserWsPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await waitForJson<{ webSocketDebuggerUrl: string }>(
    machine.localDebugHttpUrl(),
    remainingDeadlineTimeoutMs(deadline),
  );
  await waitForDevtoolsTargetList(
    machine.localDebugHttpUrl(),
    remainingDeadlineTimeoutMs(deadline),
  );
  await waitForWebSocketUpgrade(
    agentConfig.relayProbeHost,
    machine.relay.port,
    browserWsPath,
    remainingDeadlineTimeoutMs(deadline),
  );
}

async function warmSnapshotMachine(machine: FirecrackerMachineHandle): Promise<string> {
  const version = await waitForJson<{ webSocketDebuggerUrl: string }>(
    machine.localDebugHttpUrl(),
    agentConfig.firecrackerBootTimeoutMs,
  );
  const warmLevel = agentConfig.firecrackerSnapshotWarmLevel;
  if (!agentConfig.firecrackerSnapshotWarmPage || warmLevel === "none" || warmLevel === "cdp") {
    return browserWsPathFromDebuggerUrl(version.webSocketDebuggerUrl);
  }

  if (warmLevel === "target") {
    const warmTargetUrl = agentConfig.firecrackerSnapshotWarmUrl || "about:blank";
    const targetUrl = machine
      .localDebugHttpUrl()
      .replace(/\/json\/version$/, `/json/new?${encodeURIComponent(warmTargetUrl)}`);
    await devtoolsPutJson<{ id?: string }>(targetUrl, agentConfig.firecrackerBootTimeoutMs);
    return browserWsPathFromDebuggerUrl(version.webSocketDebuggerUrl);
  }

  const browser = await chromium.connectOverCDP(machine.localDebugHttpUrl(), {
    timeout: agentConfig.firecrackerBootTimeoutMs,
  });

  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    if (warmLevel === "context") {
      return browserWsPathFromDebuggerUrl(version.webSocketDebuggerUrl);
    }

    const page = context.pages()[0] ?? (await context.newPage());
    if (warmLevel === "blank") {
      await page.evaluate(() => document.readyState);
      return browserWsPathFromDebuggerUrl(version.webSocketDebuggerUrl);
    }

    const warmPageUrl =
      warmLevel === "navigate" && agentConfig.firecrackerSnapshotWarmUrl
        ? agentConfig.firecrackerSnapshotWarmUrl
        : "data:text/html,<title>firecracker-warm</title><script>window.__baselayerBenchReady=true;</script><h1>warm</h1>";
    await page.goto(warmPageUrl, { waitUntil: "domcontentloaded" });
    await page.title();
  } finally {
    await browser.close().catch(() => undefined);
  }

  return browserWsPathFromDebuggerUrl(version.webSocketDebuggerUrl);
}

function optionalEnvInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function apiDirForCleanup(options: FirecrackerCleanupOptions = {}): string {
  return options.apiDir ?? agentConfig.firecrackerApiDir;
}

function stateDirForCleanup(options: FirecrackerCleanupOptions = {}): string {
  return options.stateDir ?? agentConfig.firecrackerStateDir;
}

function tapPrefixForCleanup(options: FirecrackerCleanupOptions = {}): string {
  return options.tapPrefix ?? agentConfig.firecrackerTapPrefix;
}

function resourceNamesForInstanceId(instanceId: string, tapPrefix = agentConfig.firecrackerTapPrefix): {
  tapName: string;
  netnsName: string;
  rootVethName: string;
  nsVethName: string;
} {
  const tapName = `${tapPrefix}${instanceId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)}`;
  return {
    tapName,
    netnsName: `${tapName}-ns`,
    rootVethName: `${tapName}r`,
    nsVethName: `${tapName}n`,
  };
}

async function listNetNamespaces(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("ip", ["netns", "list"], { windowsHide: true });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function listNetnsPids(netnsName: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("ip", ["netns", "pids", netnsName], {
      windowsHide: true,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((value) => Number.isFinite(value) && value > 0);
  } catch {
    return [];
  }
}

async function readPsProcessLines(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="], { windowsHide: true });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parsePidFromPsLine(line: string): number | undefined {
  const pid = Number.parseInt(line.split(/\s+/, 2)[0] ?? "", 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

function pidsFromPsLinesMatching(
  lines: string[],
  patterns: string[],
  options: { requireAll?: boolean; mustInclude?: string } = {},
): number[] {
  const pids: number[] = [];
  for (const line of lines) {
    if (options.mustInclude && !line.includes(options.mustInclude)) {
      continue;
    }
    const matched = options.requireAll
      ? patterns.every((pattern) => line.includes(pattern))
      : patterns.some((pattern) => line.includes(pattern));
    if (!matched) {
      continue;
    }
    const pid = parsePidFromPsLine(line);
    if (pid !== undefined) {
      pids.push(pid);
    }
  }
  return pids;
}

function pidsFromPsLinesForApiDir(lines: string[], apiDir: string): number[] {
  const pids: number[] = [];
  for (const line of lines) {
    if (!line.includes("--api-sock") || !line.includes(apiDir)) {
      continue;
    }
    const pid = parsePidFromPsLine(line);
    if (pid !== undefined) {
      pids.push(pid);
    }
  }
  return pids;
}

function pidsFromPsLinesForSocketPath(lines: string[], socketPath: string): number[] {
  const pids: number[] = [];
  for (const line of lines) {
    if (!line.includes("--api-sock") || !line.includes(socketPath)) {
      continue;
    }
    const pid = parsePidFromPsLine(line);
    if (pid !== undefined) {
      pids.push(pid);
    }
  }
  return pids;
}

async function listProcessesByApiDir(apiDir: string): Promise<number[]> {
  const lines = await readPsProcessLines();
  return pidsFromPsLinesForApiDir(lines, apiDir);
}

async function listProcessesBySocketPath(socketPath: string): Promise<number[]> {
  const lines = await readPsProcessLines();
  return pidsFromPsLinesForSocketPath(lines, socketPath);
}

async function listProcessesMatching(
  patterns: string[],
  options: { requireAll?: boolean; mustInclude?: string } = {},
): Promise<number[]> {
  const lines = await readPsProcessLines();
  return pidsFromPsLinesMatching(lines, patterns, options);
}

async function signalPids(pids: number[], signal: "TERM" | "KILL"): Promise<void> {
  if (pids.length === 0) {
    return;
  }

  const uniquePids = [...new Set(pids)];
  for (const pid of uniquePids) {
    try {
      await execPrivileged("kill", [`-${signal}`, String(pid)]);
    } catch {
      // Ignore processes that already exited.
    }
  }
}

async function cleanupNetnsProcesses(netnsName: string): Promise<void> {
  const pids = await listNetnsPids(netnsName);
  if (pids.length === 0) {
    return;
  }

  await signalPids(pids, "TERM");
  await sleep(agentConfig.firecrackerNetnsCleanupTermMs);
  const remaining = await listNetnsPids(netnsName);
  await signalPids(remaining, "KILL");
}

export async function cleanupFirecrackerHostResources(
  options: FirecrackerCleanupOptions = {},
): Promise<{
  staleNetnsRemoved: number;
  staleProcessesKilled: number;
  stateEntriesRemoved: number;
  apiEntriesRemoved: number;
}> {
  requireLinux("Firecracker stale resource cleanup");

  const apiDir = apiDirForCleanup(options);
  const stateDir = stateDirForCleanup(options);
  const tapPrefix = tapPrefixForCleanup(options);
  const touchedInstanceIds = new Set<string>();

  if (fs.existsSync(apiDir)) {
    for (const entry of fs.readdirSync(apiDir)) {
      if (entry.endsWith(".sock")) {
        touchedInstanceIds.add(entry.slice(0, -".sock".length));
      }
    }
  }

  if (fs.existsSync(stateDir)) {
    for (const entry of fs.readdirSync(stateDir)) {
      touchedInstanceIds.add(entry);
    }
  }

  const prefixedNamespaces = (await listNetNamespaces()).filter((name) => name.startsWith(tapPrefix));
  for (const netnsName of prefixedNamespaces) {
    const tapName = netnsName.slice(0, -"-ns".length);
    const instanceId = tapName.startsWith(tapPrefix) ? tapName.slice(tapPrefix.length) : tapName;
    if (instanceId) {
      touchedInstanceIds.add(instanceId);
    }
  }

  const staleLinesPass1 = await readPsProcessLines();
  const stalePids = pidsFromPsLinesForApiDir(staleLinesPass1, apiDir);
  const staleHelperPids = [
    ...new Set([
      ...pidsFromPsLinesMatching(staleLinesPass1, [tapPrefix], { mustInclude: "socat" }),
      ...pidsFromPsLinesMatching(staleLinesPass1, [tapPrefix], {
        mustInclude: "firecracker-egress-proxy",
      }),
    ]),
  ];
  await signalPids(stalePids, "TERM");
  await signalPids(staleHelperPids, "TERM");
  await sleep(agentConfig.firecrackerStaleCleanupTermMs);
  const staleLinesPass2 = await readPsProcessLines();
  const remainingPids = pidsFromPsLinesForApiDir(staleLinesPass2, apiDir);
  const remainingHelperPids = [
    ...new Set([
      ...pidsFromPsLinesMatching(staleLinesPass2, [tapPrefix], { mustInclude: "socat" }),
      ...pidsFromPsLinesMatching(staleLinesPass2, [tapPrefix], {
        mustInclude: "firecracker-egress-proxy",
      }),
    ]),
  ];
  await signalPids(remainingPids, "KILL");
  await signalPids(remainingHelperPids, "KILL");

  let staleNetnsRemoved = 0;
  for (const instanceId of touchedInstanceIds) {
    const names = resourceNamesForInstanceId(instanceId, tapPrefix);
    await cleanupNetnsProcesses(names.netnsName);
    const beforeNamespaces = await listNetNamespaces();
    await removeNetns(names.netnsName);
    if (beforeNamespaces.includes(names.netnsName)) {
      staleNetnsRemoved += 1;
    }
    try {
      await execPrivileged("ip", ["link", "del", names.rootVethName]);
    } catch {
      // Ignore if already removed.
    }
    try {
      await execPrivileged("ip", ["link", "del", names.tapName]);
    } catch {
      // Ignore if already removed.
    }
  }

  let stateEntriesRemoved = 0;
  if (fs.existsSync(stateDir)) {
    for (const entry of fs.readdirSync(stateDir)) {
      fs.rmSync(path.join(stateDir, entry), { recursive: true, force: true });
      stateEntriesRemoved += 1;
    }
  }

  let apiEntriesRemoved = 0;
  if (fs.existsSync(apiDir)) {
    for (const entry of fs.readdirSync(apiDir)) {
      fs.rmSync(path.join(apiDir, entry), { recursive: true, force: true });
      apiEntriesRemoved += 1;
    }
  }

  return {
    staleNetnsRemoved,
    staleProcessesKilled:
      stalePids.length +
      remainingPids.length +
      staleHelperPids.length +
      remainingHelperPids.length,
    stateEntriesRemoved,
    apiEntriesRemoved,
  };
}

export class FirecrackerOrchestrator {
  readonly #sessions = new Map<string, FirecrackerMachineHandle>();
  readonly #schedulerStates = new Map<string, FirecrackerSchedulerState>();
  readonly #warmSessionIds = new Set<string>();
  readonly #warmSessionProfiles = new Map<string, string>();
  readonly #warmSessionLastProbeAt = new Map<string, number>();
  readonly #restoreTimes: number[] = [];
  readonly #networkSlots = new Map<string, FirecrackerNetworkSlot>();
  readonly #freeNetworkSlotIds: string[] = [];
  readonly #slotRebuildPromises = new Map<string, Promise<FirecrackerNetworkSlot>>();
  #snapshotPreparePromise: Promise<FirecrackerSnapshotInfo> | undefined;
  #networkPoolPreparePromise: Promise<void> | undefined;
  #cpuControlReady: boolean | undefined;
  /** Last logged hybrid fluid gate (idle differentiation on/off). */
  #lastHybridFluidGate: boolean | undefined;

  get reservedMemoryMb(): number {
    return this.#sessions.size * agentConfig.firecrackerGuestMemoryMb;
  }

  get trackedResidentMemoryMb(): number {
    return [...this.#sessions.values()].reduce((sum, machine) => {
      return sum + estimatedMachineMemoryMb(machine);
    }, 0);
  }

  get activeMicrovmCount(): number {
    return this.#sessions.size;
  }

  get networkSlotCount(): number {
    return this.#networkSlots.size;
  }

  get freeNetworkSlotCount(): number {
    return this.#freeNetworkSlotIds.length;
  }

  get preparingNetworkPool(): boolean {
    return this.#networkPoolPreparePromise !== undefined;
  }

  get highPrioritySessionCount(): number {
    return [...this.#schedulerStates.values()].filter(
      (state) =>
        state.activityState === "launching" || state.activityState === "active-navigation",
    ).length;
  }

  get activeNavigationSessionCount(): number {
    return [...this.#schedulerStates.values()].filter(
      (state) => state.activityState === "active-navigation",
    ).length;
  }

  get averageRestoreMs(): number {
    if (this.#restoreTimes.length === 0) {
      return 0;
    }

    return Math.round(this.#restoreTimes.reduce((sum, value) => sum + value, 0) / this.#restoreTimes.length);
  }

  warmReadyCount(runtimeProfile?: string): number {
    if (!runtimeProfile) {
      return this.#warmSessionIds.size;
    }

    let count = 0;
    for (const sessionId of this.#warmSessionIds) {
      if (this.#warmSessionProfiles.get(sessionId) === runtimeProfile) {
        count += 1;
      }
    }
    return count;
  }

  warmSessionIds(runtimeProfile?: string): string[] {
    return [...this.#warmSessionIds].filter((sessionId) =>
      runtimeProfile ? this.#warmSessionProfiles.get(sessionId) === runtimeProfile : true,
    );
  }

  async revalidateWarmSessions(runtimeProfile?: string): Promise<void> {
    const now = Date.now();
    const minimumIntervalMs = Math.max(250, agentConfig.firecrackerWarmKeepaliveIntervalMs);
    const warmSessionIds = this.warmSessionIds(runtimeProfile);
    for (const warmSessionId of warmSessionIds) {
      const lastProbeAt = this.#warmSessionLastProbeAt.get(warmSessionId) ?? 0;
      if (now - lastProbeAt < minimumIntervalMs) {
        continue;
      }

      const machine = this.#sessions.get(warmSessionId);
      if (!machine) {
        this.#warmSessionIds.delete(warmSessionId);
        this.#warmSessionProfiles.delete(warmSessionId);
        this.#warmSessionLastProbeAt.delete(warmSessionId);
        continue;
      }

      this.#warmSessionLastProbeAt.set(warmSessionId, now);
      try {
        await this.#probeWarmMachine(machine, {
          timeoutMs: Math.min(
            agentConfig.firecrackerRestoreTimeoutMs,
            Math.max(1_000, agentConfig.firecrackerWarmClaimTimeoutMs),
          ),
          verifyWebSocketUpgrade: false,
        });
      } catch (error) {
        logError("firecracker", "warm-session-keepalive-failed", error, {
          warmSessionId,
          slotId: machine.networkSlotId,
          relayPort: machine.relay.port,
          localDebugHttpUrl: machine.localDebugHttpUrl(),
        });
        this.#warmSessionIds.delete(warmSessionId);
        this.#warmSessionProfiles.delete(warmSessionId);
        this.#warmSessionLastProbeAt.delete(warmSessionId);
        this.#sessions.delete(warmSessionId);
        this.#schedulerStates.delete(warmSessionId);
        this.#markSlotUnhealthy(machine.networkSlotId);
        await this.#destroyMachine(machine, true).catch(() => undefined);
      }
    }
  }

  hasSession(sessionId: string): boolean {
    const machine = this.#sessions.get(sessionId);
    if (!machine) {
      return false;
    }

    return (
      machine.process.child.exitCode === null &&
      machine.process.child.signalCode === null
    );
  }

  sessionIds(): string[] {
    return [...this.#sessions.keys()];
  }

  sessionMetrics(sessionId: string): {
    memoryMb: number;
    cpuPct: number;
    rendererCount: number;
    shmUsedMb: number;
    activityState: SessionActivityState;
    schedulerWeight: number;
  } | undefined {
    if (!this.hasSession(sessionId)) {
      return undefined;
    }

    const machine = this.#sessions.get(sessionId);
    const schedulerState = this.#schedulerStates.get(sessionId);
    const memoryMb = machine ? estimatedMachineMemoryMb(machine) : agentConfig.firecrackerGuestMemoryMb;
    const cpuPct = machine ? this.#sampleSessionCpuPct(sessionId, machine) : 0;

    return {
      memoryMb,
      cpuPct,
      rendererCount: 1,
      shmUsedMb: 0,
      activityState: schedulerState?.activityState ?? "interactive-idle",
      schedulerWeight: schedulerState?.schedulerWeight ?? schedulerWeightForState("interactive-idle"),
    };
  }

  sessionLogSnapshot(sessionId: string): SessionLogSnapshot | undefined {
    const machine = this.#sessions.get(sessionId);
    if (!machine) {
      return undefined;
    }

    const stdoutTail = tailFile(machine.stdoutLogPath, 40);
    const stderrTail = tailFile(machine.stderrLogPath, 40);
    const lines = [
      ...stdoutTail.split(/\r?\n/).filter(Boolean),
      ...stderrTail.split(/\r?\n/).filter(Boolean),
    ].slice(-80);

    return {
      source: "node-agent-microvm",
      capturedAt: new Date().toISOString(),
      lines,
    };
  }

  markSessionActivity(sessionId: string, activityState: SessionActivityState): boolean {
    const machine = this.#sessions.get(sessionId);
    if (!machine) {
      return false;
    }

    void this.#setSchedulerState(sessionId, machine, activityState).catch((error) => {
      logError("firecracker", "scheduler-update-failed", error, { sessionId, activityState });
    });
    return true;
  }

  refreshScheduling(nowMs = Date.now()): void {
    for (const [sessionId, machine] of this.#sessions.entries()) {
      const state = this.#schedulerStates.get(sessionId);
      if (!state) {
        continue;
      }

      if (
        (state.activityState === "launching" || state.activityState === "active-navigation") &&
        nowMs - state.lastActivityAtMs >= agentConfig.firecrackerActivityIdleMs
      ) {
        void this.#setSchedulerState(sessionId, machine, "interactive-idle").catch((error) => {
          logError("firecracker", "scheduler-refresh-failed", error, { sessionId });
        });
      }
    }
  }

  async prepareWarmSession(
    sessionId: string,
    options: { runtimeProfile: string; proxyProfile?: string },
  ): Promise<void> {
    await this.restoreSession(sessionId, { proxyProfile: options.proxyProfile });
    const machine = this.#sessions.get(sessionId);
    if (!machine) {
      throw new Error(`Warm Firecracker session '${sessionId}' is missing after restore.`);
    }
    try {
      await this.#setSchedulerState(sessionId, machine, "interactive-idle");
      await this.#verifyWarmMachine(machine, { verifyWebSocketUpgrade: true });
      this.#warmSessionIds.add(sessionId);
      this.#warmSessionProfiles.set(sessionId, options.runtimeProfile);
      this.#warmSessionLastProbeAt.set(sessionId, Date.now());
    } catch (error) {
      logError("firecracker", "warm-session-prepare-failed", error, {
        sessionId,
        slotId: machine.networkSlotId,
        relayPort: machine.relay.port,
        localDebugHttpUrl: machine.localDebugHttpUrl(),
      });
      this.#sessions.delete(sessionId);
      this.#schedulerStates.delete(sessionId);
      this.#warmSessionLastProbeAt.delete(sessionId);
      this.#markSlotUnhealthy(machine.networkSlotId);
      await this.#destroyMachine(machine, true).catch(() => undefined);
      throw error;
    }
  }

  async claimWarmSession(
    warmSessionId: string,
    requestedSessionId: string,
  ): Promise<RuntimeLaunchResult | undefined> {
    if (!this.#warmSessionIds.has(warmSessionId)) {
      return undefined;
    }

    const machine = this.#sessions.get(warmSessionId);
    if (!machine || !this.hasSession(warmSessionId)) {
      this.#warmSessionIds.delete(warmSessionId);
      this.#warmSessionProfiles.delete(warmSessionId);
      if (machine) {
        this.#sessions.delete(warmSessionId);
        this.#schedulerStates.delete(warmSessionId);
        await this.#destroyMachine(machine).catch(() => undefined);
      }
      return undefined;
    }

    const existingState = this.#schedulerStates.get(warmSessionId);
    this.#warmSessionIds.delete(warmSessionId);
    this.#warmSessionProfiles.delete(warmSessionId);
    this.#warmSessionLastProbeAt.delete(warmSessionId);
    this.#sessions.delete(warmSessionId);
    this.#schedulerStates.delete(warmSessionId);
    this.#sessions.set(requestedSessionId, machine);
    if (existingState) {
      this.#schedulerStates.set(requestedSessionId, existingState);
    }
    try {
      machine.startedAt = new Date().toISOString();
      await this.#setSchedulerState(requestedSessionId, machine, "launching");
      const browserWsPath = await this.#verifyWarmMachine(machine, {
        verifyWebSocketUpgrade: false,
      });

      return {
        sessionId: requestedSessionId,
        containerId: machine.instanceId,
        containerName: machine.instanceId,
        runtimeKind: "microvm",
        connectUrl: `ws://${agentConfig.publicHost}:${machine.relay.port}${browserWsPath}`,
        cdpUrl: `ws://${agentConfig.publicHost}:${machine.relay.port}${browserWsPath}`,
        playwrightUrl: `ws://${agentConfig.publicHost}:${machine.relay.port}${browserWsPath}`,
        puppeteerUrl: `ws://${agentConfig.publicHost}:${machine.relay.port}${browserWsPath}`,
        debugHttpUrl: machine.debugHttpUrl(),
        startedAt: machine.startedAt,
        launchTimings: {
          totalMs: 0,
        },
      };
    } catch (error) {
      logError("firecracker", "warm-session-claim-failed", error, {
        warmSessionId,
        requestedSessionId,
        slotId: machine.networkSlotId,
        relayPort: machine.relay.port,
        localDebugHttpUrl: machine.localDebugHttpUrl(),
      });
      this.#sessions.delete(requestedSessionId);
      this.#schedulerStates.delete(requestedSessionId);
      this.#warmSessionLastProbeAt.delete(requestedSessionId);
      this.#markSlotUnhealthy(machine.networkSlotId);
      await this.#destroyMachine(machine, true).catch(() => undefined);
      return undefined;
    }
  }

  sessionHostIp(sessionId: string): string | undefined {
    return this.#sessions.get(sessionId)?.hostIp;
  }

  async #verifyWarmMachine(
    machine: FirecrackerMachineHandle,
    options: { verifyWebSocketUpgrade?: boolean } = {},
  ): Promise<string> {
    const warmClaimTimeoutMs = Math.min(
      agentConfig.firecrackerRestoreTimeoutMs,
      Math.max(1_000, agentConfig.firecrackerWarmClaimTimeoutMs),
    );
    return this.#probeWarmMachine(machine, {
      timeoutMs: warmClaimTimeoutMs,
      verifyWebSocketUpgrade: options.verifyWebSocketUpgrade ?? false,
    });
  }

  async #probeWarmMachine(
    machine: FirecrackerMachineHandle,
    options: { timeoutMs: number; verifyWebSocketUpgrade: boolean },
  ): Promise<string> {
    const version = await waitForJson<{ webSocketDebuggerUrl: string }>(
      machine.localDebugHttpUrl(),
      options.timeoutMs,
    );
    const browserWsPath = browserWsPathFromDebuggerUrl(version.webSocketDebuggerUrl);
    await waitForDevtoolsTargetList(machine.localDebugHttpUrl(), options.timeoutMs);
    if (options.verifyWebSocketUpgrade) {
      await waitForWebSocketUpgrade(
        agentConfig.relayProbeHost,
        machine.relay.port,
        browserWsPath,
        options.timeoutMs,
      );
    }
    return browserWsPath;
  }

  #sampleSessionCpuPct(sessionId: string, machine: FirecrackerMachineHandle): number {
    if (!machine.firecrackerPid) {
      return this.#schedulerStates.get(sessionId)?.lastCpuPct ?? 0;
    }

    const cpuTimeMs = readProcessCpuTimeMs(machine.firecrackerPid);
    const sampledAtMs = Date.now();
    const state = this.#schedulerStates.get(sessionId);
    if (!state) {
      return 0;
    }

    const previous = state.lastCpuSample;
    state.lastCpuSample = {
      cpuTimeMs,
      sampledAtMs,
    };

    if (!previous) {
      state.lastCpuPct = 0;
      return 0;
    }

    const elapsedMs = Math.max(1, sampledAtMs - previous.sampledAtMs);
    const cpuDeltaMs = Math.max(0, cpuTimeMs - previous.cpuTimeMs);
    const cpuPct = Math.max(0, Math.round((cpuDeltaMs / elapsedMs) * 100));
    state.lastCpuPct = cpuPct;
    return cpuPct;
  }

  #hybridFluidGateSnapshot(): { open: boolean; total: number; idle: number } {
    const states = this.#schedulerStates;
    const total = states.size;
    if (total === 0) {
      return { open: false, total: 0, idle: 0 };
    }
    let idle = 0;
    for (const s of states.values()) {
      if (
        s.activityState === "interactive-idle" ||
        s.activityState === "soak-idle"
      ) {
        idle++;
      }
    }
    const open =
      idle >= agentConfig.firecrackerHybridIdleSessionThreshold ||
      idle / total >= agentConfig.firecrackerHybridIdleRatioThreshold;
    return { open, total, idle };
  }

  #fluidHybridPolicyForActivity(
    activityState: SessionActivityState,
    hybridActive: boolean,
  ): FirecrackerCpuPolicy {
    if (!hybridActive) {
      return neutralCpuPolicy(activityState);
    }
    if (
      activityState === "interactive-idle" ||
      activityState === "soak-idle"
    ) {
      return cpuPolicyForState(activityState);
    }
    return neutralCpuPolicy(activityState);
  }

  /**
   * Hybrid fluid CPU applies different weights to idle vs busy sessions only when
   * the gate is open. Re-apply all sessions so idles that were neutral before the
   * gate opened get demoted, and idles that become busy after the gate closes
   * return to neutral.
   */
  async #refreshAllHybridCpuPolicies(): Promise<void> {
    const { open: hybridActive, total, idle } = this.#hybridFluidGateSnapshot();
    if (this.#lastHybridFluidGate !== hybridActive) {
      this.#lastHybridFluidGate = hybridActive;
      log("firecracker", "fluid-hybrid-gate", {
        hybridActive,
        idleSessions: idle,
        totalSessions: total,
        thresholdSessions: agentConfig.firecrackerHybridIdleSessionThreshold,
        idleRatioThreshold: agentConfig.firecrackerHybridIdleRatioThreshold,
      });
    }

    const sessionsWithPids = [...this.#sessions.entries()]
      .filter(([, machine]) => machine.firecrackerPid)
      .map(([sessionId, machine]) => {
        const activityState =
          this.#schedulerStates.get(sessionId)?.activityState ??
          "interactive-idle";
        const policy = this.#fluidHybridPolicyForActivity(activityState, hybridActive);
        return { sessionId, machine, policy, activityState };
      });

    const reniceOps = sessionsWithPids.map(({ machine, policy }) =>
      execPrivileged("renice", [
        "-n",
        String(policy.schedulerWeight),
        "-p",
        String(machine.firecrackerPid),
      ]),
    );
    await Promise.all(reniceOps);

    const applyOps = sessionsWithPids.map(({ sessionId, machine, policy, activityState }) =>
      this.#applyCpuPolicy(machine, policy).catch((error) => {
        logError("firecracker", "cpu-policy-apply-failed", error, {
          sessionId,
          activityState,
        });
      }),
    );
    await Promise.all(applyOps);
  }

  async #setSchedulerState(
    sessionId: string,
    machine: FirecrackerMachineHandle,
    activityState: SessionActivityState,
  ): Promise<void> {
    const projectedStates = new Map(this.#schedulerStates);
    const existing = this.#schedulerStates.get(sessionId);
    projectedStates.set(sessionId, {
      activityState,
      schedulerWeight: existing?.schedulerWeight ?? 0,
      lastActivityAtMs: Date.now(),
      lastCpuPct: existing?.lastCpuPct ?? 0,
      lastCpuSample: existing?.lastCpuSample,
    });
    const totalSessions = projectedStates.size;
    const idleSessions = [...projectedStates.values()].filter(
      (state) =>
        state.activityState === "interactive-idle" || state.activityState === "soak-idle",
    ).length;
    const hybridActive =
      totalSessions > 0 &&
      (idleSessions >= agentConfig.firecrackerHybridIdleSessionThreshold ||
        idleSessions / totalSessions >= agentConfig.firecrackerHybridIdleRatioThreshold);
    const concurrentHighPrioritySessions = [...this.#schedulerStates.entries()].filter(
      ([candidateSessionId, state]) =>
        candidateSessionId !== sessionId &&
        (state.activityState === "launching" || state.activityState === "active-navigation"),
    ).length;
    let policy: FirecrackerCpuPolicy;
    if (!agentConfig.firecrackerDynamicCpuPolicy) {
      policy = neutralCpuPolicy(activityState);
    } else if (agentConfig.firecrackerDynamicCpuMode === "hybrid") {
      policy = this.#fluidHybridPolicyForActivity(activityState, hybridActive);
    } else {
      policy =
        (activityState === "launching" || activityState === "active-navigation") &&
        concurrentHighPrioritySessions >= agentConfig.firecrackerHighPriorityBudget
          ? overflowCpuPolicyForState(activityState)
          : cpuPolicyForState(activityState);
    }
    const nextState: FirecrackerSchedulerState = {
      activityState,
      schedulerWeight: policy.schedulerWeight,
      lastActivityAtMs: Date.now(),
      lastCpuPct: existing?.lastCpuPct ?? 0,
      lastCpuSample: existing?.lastCpuSample,
    };
    this.#schedulerStates.set(sessionId, nextState);

    if (!agentConfig.firecrackerDynamicCpuPolicy) {
      return;
    }

    if (agentConfig.firecrackerDynamicCpuMode === "hybrid") {
      await this.#refreshAllHybridCpuPolicies();
      return;
    }

    if (!machine.firecrackerPid) {
      return;
    }

    await execPrivileged("renice", [
      "-n",
      String(policy.schedulerWeight),
      "-p",
      String(machine.firecrackerPid),
    ]);
    await this.#applyCpuPolicy(machine, policy).catch((error) => {
      logError("firecracker", "cpu-policy-apply-failed", error, {
        sessionId,
        activityState,
      });
    });
  }

  async #ensureCpuControlReady(): Promise<boolean> {
    if (this.#cpuControlReady !== undefined) {
      return this.#cpuControlReady;
    }

    if (!agentConfig.firecrackerDynamicCpuCgroups || !isLinux()) {
      this.#cpuControlReady = false;
      return false;
    }

    try {
      const cgroupRoot = "/sys/fs/cgroup";
      const controllers = await readTextFile(path.join(cgroupRoot, "cgroup.controllers"));
      if (!controllers.split(/\s+/).includes("cpu")) {
        this.#cpuControlReady = false;
        return false;
      }

      const basePath = agentConfig.firecrackerCpuCgroupRoot;

      // cgroup v2: every ancestor of the per-machine leaf must list `cpu` in
      // its own `cgroup.subtree_control` before children may declare `cpu.*`
      // attributes. The previous implementation only enabled it on the
      // immediate parent of `basePath`, which left `basePath/cgroup.subtree_control`
      // empty and caused `cpu.weight: Permission denied` when writing per-machine
      // attributes (see ledger 2026-04-13 "Cgroup-backed fluid CPU policy").
      const ancestors: string[] = [];
      let cursor = basePath;
      while (cursor && cursor.startsWith(cgroupRoot) && cursor !== cgroupRoot) {
        ancestors.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          break;
        }
        cursor = parent;
      }

      // Walk parents (root-most first) so each ancestor is created and then
      // delegates `cpu` to the next level down.
      for (const ancestor of [...ancestors].reverse()) {
        await mkdirPrivileged(ancestor);
      }

      const enableCpuSubtree = async (dir: string): Promise<void> => {
        const subtreeControlPath = path.join(dir, "cgroup.subtree_control");
        const current = await readTextFile(subtreeControlPath).catch(() => "");
        if (current.split(/\s+/).includes("cpu")) {
          return;
        }
        await writePrivilegedFile(subtreeControlPath, "+cpu");
      };

      // Enable on the cgroup root first, then each intermediate ancestor down
      // to and including basePath, so per-machine cgroups inherit the cpu
      // controller.
      await enableCpuSubtree(cgroupRoot);
      for (const ancestor of [...ancestors].reverse()) {
        await enableCpuSubtree(ancestor);
      }

      this.#cpuControlReady = true;
      return true;
    } catch (error) {
      this.#cpuControlReady = false;
      logError("firecracker", "cpu-control-unavailable", error, {
        cgroupRoot: agentConfig.firecrackerCpuCgroupRoot,
      });
      return false;
    }
  }

  async #ensureMachineCgroup(machine: FirecrackerMachineHandle): Promise<string | undefined> {
    if (!(await this.#ensureCpuControlReady())) {
      return undefined;
    }

    if (machine.cgroupPath) {
      return machine.cgroupPath;
    }

    const cgroupPath = path.join(
      agentConfig.firecrackerCpuCgroupRoot,
      machine.instanceId.replace(/[^a-zA-Z0-9_-]/g, "-"),
    );
    await mkdirPrivileged(cgroupPath);
    machine.cgroupPath = cgroupPath;
    return cgroupPath;
  }

  async #applyCpuPolicy(
    machine: FirecrackerMachineHandle,
    policy: FirecrackerCpuPolicy,
  ): Promise<void> {
    if (!machine.firecrackerPid) {
      return;
    }

    const cgroupPath = await this.#ensureMachineCgroup(machine);
    if (cgroupPath) {
      await writePrivilegedFile(path.join(cgroupPath, "cpu.weight"), String(policy.cpuWeight));
      await writePrivilegedFile(path.join(cgroupPath, "cpu.max"), policy.cpuMax);
      await writePrivilegedFile(
        path.join(cgroupPath, "cgroup.procs"),
        `${machine.firecrackerPid}\n`,
      );
    }

    if (policy.cpuAffinity) {
      await execPrivileged("taskset", [
        "-pc",
        policy.cpuAffinity,
        String(machine.firecrackerPid),
      ]);
    }
  }

  async #cleanupMachineCgroup(machine: FirecrackerMachineHandle): Promise<void> {
    if (!machine.cgroupPath) {
      return;
    }

    try {
      await rmdirPrivileged(machine.cgroupPath);
    } catch {
      // Ignore cgroup cleanup failures; the host reconciler can sweep stale dirs.
    } finally {
      machine.cgroupPath = undefined;
    }
  }

  async prepareNetworkPool(force = false): Promise<void> {
    requireLinux("Firecracker network slot preparation");

    const targetSize = Math.max(
      0,
      Math.min(agentConfig.firecrackerNetworkPoolSize, agentConfig.firecrackerMaxMicrovmCount),
    );
    if (targetSize === 0) {
      return;
    }

    if (!force && agentConfig.firecrackerNetworkPoolPrepareMode !== "startup") {
      return;
    }

    if (this.#networkPoolPreparePromise) {
      return this.#networkPoolPreparePromise;
    }

    this.#networkPoolPreparePromise = (async () => {
      for (let slotIndex = 0; slotIndex < targetSize; slotIndex += 1) {
        await this.#ensureNetworkSlot(slotIndex);
      }
    })().finally(() => {
      this.#networkPoolPreparePromise = undefined;
    });

    return this.#networkPoolPreparePromise;
  }

  static assertAssetsAvailable(): void {
    if (!fs.existsSync(agentConfig.firecrackerKernelPath)) {
      throw new Error(`Firecracker kernel not found at ${agentConfig.firecrackerKernelPath}`);
    }

    if (!fs.existsSync(agentConfig.firecrackerRootfsPath)) {
      throw new Error(`Firecracker rootfs not found at ${agentConfig.firecrackerRootfsPath}`);
    }

    const worstCaseApiSock = path.join(
      agentConfig.firecrackerApiDir,
      "00000000-0000-0000-0000-000000000000.sock",
    );
    assertFirecrackerApiSocketPathLength(worstCaseApiSock);
  }

  snapshotExists(name = agentConfig.firecrackerSnapshotName): boolean {
    const spec = this.getSnapshotInfo(name);
    return (
      fs.existsSync(spec.snapshotPath) &&
      fs.existsSync(spec.memFilePath) &&
      fs.existsSync(spec.metadataPath)
    );
  }

  getSnapshotInfo(name = agentConfig.firecrackerSnapshotName): FirecrackerSnapshotInfo {
    return snapshotInfo(name);
  }

  async ensureBaseSnapshot(options: EnsureSnapshotOptions = {}): Promise<FirecrackerSnapshotInfo> {
    return this.#ensureSnapshot(
      snapshotTargetForProxyConfig({ proxyProfile: "direct" }),
      options,
    );
  }

  async ensureProxySnapshot(options: EnsureSnapshotOptions = {}): Promise<FirecrackerSnapshotInfo> {
    return this.#ensureSnapshot(
      snapshotTargetForProxyConfig({
        proxyProfile: "proxy",
        upstreamProxyUrl: "http://placeholder",
        requiresLocalProxy: true,
      }),
      options,
    );
  }

  async #ensureSnapshot(
    target: FirecrackerSnapshotTarget,
    options: EnsureSnapshotOptions = {},
  ): Promise<FirecrackerSnapshotInfo> {
    requireLinux("Firecracker snapshot preparation");
    if (!fs.existsSync(agentConfig.firecrackerKernelPath)) {
      throw new Error(`Firecracker kernel not found at ${agentConfig.firecrackerKernelPath}`);
    }
    if (!fs.existsSync(target.rootfsPath)) {
      throw new Error(`Firecracker rootfs not found at ${target.rootfsPath}`);
    }

    if (this.snapshotExists(target.snapshotName)) {
      return this.getSnapshotInfo(target.snapshotName);
    }

    if (this.#snapshotPreparePromise) {
      return this.#snapshotPreparePromise;
    }

    this.#snapshotPreparePromise = this.createBaseSnapshot({
      instanceId: `${target.snapshotName}-${Date.now()}`,
      snapshotName: target.snapshotName,
      rootfsPath: target.rootfsPath,
      requiresLocalProxy: target.requiresLocalProxy,
      verify: options.verify,
    }).finally(() => {
      this.#snapshotPreparePromise = undefined;
    });

    return this.#snapshotPreparePromise;
  }

  async createBaseSnapshot(options: CreateSnapshotOptions): Promise<FirecrackerSnapshotInfo> {
    requireLinux("Firecracker snapshot creation");
    if (!fs.existsSync(agentConfig.firecrackerKernelPath)) {
      throw new Error(`Firecracker kernel not found at ${agentConfig.firecrackerKernelPath}`);
    }
    if (!fs.existsSync(options.rootfsPath ?? agentConfig.firecrackerRootfsPath)) {
      throw new Error(
        `Firecracker rootfs not found at ${options.rootfsPath ?? agentConfig.firecrackerRootfsPath}`,
      );
    }

    const machine = await this.#bootFromRootfsWithOptions(options.instanceId, {
      rootfsPath: options.rootfsPath ?? agentConfig.firecrackerRootfsPath,
      requiresLocalProxy: options.requiresLocalProxy ?? false,
    });
    try {
      let browserWsPath: string | undefined;
      if (options.verify) {
        await options.verify(machine);
      } else {
        browserWsPath = await warmSnapshotMachine(machine);
      }

      if (!browserWsPath) {
        const version = await waitForJson<{ webSocketDebuggerUrl: string }>(
          machine.localDebugHttpUrl(),
          agentConfig.firecrackerBootTimeoutMs,
        );
        browserWsPath = browserWsPathFromDebuggerUrl(version.webSocketDebuggerUrl);
      }

      const spec = this.getSnapshotInfo(options.snapshotName ?? agentConfig.firecrackerSnapshotName);
      fs.mkdirSync(path.dirname(spec.snapshotPath), { recursive: true });

      await firecrackerRequest(machine.apiSocketPath, "PATCH", "/vm", {
        state: "Paused",
      });
      await firecrackerRequest(machine.apiSocketPath, "PUT", "/snapshot/create", {
        snapshot_type: "Full",
        snapshot_path: spec.snapshotPath,
        mem_file_path: spec.memFilePath,
      });
      await firecrackerRequest(machine.apiSocketPath, "PATCH", "/vm", {
        state: "Resumed",
      });

      fs.writeFileSync(
        spec.metadataPath,
        JSON.stringify(
          <FirecrackerSnapshotMetadata>{
            createdAt: new Date().toISOString(),
            kernelPath: agentConfig.firecrackerKernelPath,
            rootfsPath: options.rootfsPath ?? agentConfig.firecrackerRootfsPath,
            guestIp: machine.guestIp,
            hostIp: machine.hostIp,
            guestMac: machine.guestMac,
            guestMemoryMb: agentConfig.firecrackerGuestMemoryMb,
            guestVcpuCount: agentConfig.firecrackerGuestVcpuCount,
            guestCdpPort: agentConfig.firecrackerCdpPort,
            browserWsPath,
          },
          null,
          2,
        ),
      );

      return spec;
    } finally {
      await this.#destroyMachine(machine);
    }
  }

  async restoreSession(
    sessionId: string,
    options: { proxyProfile?: string } = {},
  ): Promise<RuntimeLaunchResult> {
    requireLinux("Firecracker restore");

    const started = performance.now();
    const proxyConfig = resolveProxyProfile(options.proxyProfile);
    const snapshotTarget = snapshotTargetForProxyConfig(proxyConfig);
    if (!this.snapshotExists(snapshotTarget.snapshotName)) {
      if (!agentConfig.firecrackerAllowAutoSnapshot) {
        throw new Error(
          `Firecracker snapshot '${snapshotTarget.snapshotName}' is missing. ` +
            `Expected rootfs ${snapshotTarget.rootfsPath}.`,
        );
      }
      await this.#ensureSnapshot(snapshotTarget);
    }
    const snapshotMetadata = readSnapshotMetadata(this.getSnapshotInfo(snapshotTarget.snapshotName));
    const maxAttempts = Math.max(1, 1 + agentConfig.firecrackerRestoreRetries);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptDeadlineMs = Date.now() + agentConfig.firecrackerRestoreTimeoutMs;
      const cdpPhaseTimeoutMs = () => Math.min(remainingDeadlineTimeoutMs(attemptDeadlineMs), 10_000);
      const restored = await this.#restoreFromSnapshot(sessionId, proxyConfig, snapshotTarget.snapshotName);
      const machine = restored.machine;
      try {
        this.#sessions.set(sessionId, machine);
        await this.#setSchedulerState(sessionId, machine, "launching");
        const cdpReadyStarted = performance.now();
        const cdpSocketReadyStarted = performance.now();
        let cdpVersionReadyMs = 0;
        let cdpTargetListReadyMs = 0;
        let cdpStableReadyMs = 0;
        let browserWsPath = snapshotMetadata?.browserWsPath;

        if (browserWsPath) {
          try {
            await waitForWebSocketUpgrade(
              agentConfig.relayProbeHost,
              machine.relay.port,
              browserWsPath,
              cdpPhaseTimeoutMs(),
            );
          } catch {
            browserWsPath = undefined;
          }
        }

        if (!browserWsPath) {
          const cdpVersionReadyStarted = performance.now();
          const version = await waitForJson<{ webSocketDebuggerUrl: string }>(
            machine.localDebugHttpUrl(),
            cdpPhaseTimeoutMs(),
          );
          cdpVersionReadyMs = performance.now() - cdpVersionReadyStarted;
          browserWsPath = browserWsPathFromDebuggerUrl(version.webSocketDebuggerUrl);
        } else {
          const cdpVersionReadyStarted = performance.now();
          await waitForJson<{ webSocketDebuggerUrl: string }>(
            machine.localDebugHttpUrl(),
            cdpPhaseTimeoutMs(),
          );
          cdpVersionReadyMs = performance.now() - cdpVersionReadyStarted;
        }

        const cdpTargetListReadyStarted = performance.now();
        await waitForDevtoolsTargetList(
          machine.localDebugHttpUrl(),
          cdpPhaseTimeoutMs(),
        );
        cdpTargetListReadyMs = performance.now() - cdpTargetListReadyStarted;

        const cdpStableReadyStarted = performance.now();
        await waitForStableDevtoolsReady(
          machine,
          browserWsPath,
          cdpPhaseTimeoutMs(),
        );
        cdpStableReadyMs = performance.now() - cdpStableReadyStarted;

        maybePrecreateTarget(machine.localDebugHttpUrl()).catch(() => undefined);

        if (agentConfig.firecrackerReadySettleMs > 0) {
          await sleep(agentConfig.firecrackerReadySettleMs);
        }
        const restoreMs = performance.now() - started;
        const launchTimings: LaunchTiming = {
          totalMs: restoreMs,
          ...restored.launchTimings,
          cdpReadyMs: performance.now() - cdpReadyStarted,
          cdpSocketReadyMs: performance.now() - cdpSocketReadyStarted,
          cdpVersionReadyMs,
          cdpTargetListReadyMs,
          cdpStableReadyMs,
        };
        this.#restoreTimes.push(restoreMs);
        if (this.#restoreTimes.length > 100) {
          this.#restoreTimes.shift();
        }
        log("firecracker", "restore-timing", {
          sessionId,
          attempt,
          ...launchTimings,
        });

        return {
          sessionId,
          containerId: machine.instanceId,
          containerName: machine.instanceId,
          runtimeKind: "microvm",
          connectUrl: `ws://${agentConfig.publicHost}:${machine.relay.port}${browserWsPath}`,
          cdpUrl: `ws://${agentConfig.publicHost}:${machine.relay.port}${browserWsPath}`,
          playwrightUrl: `ws://${agentConfig.publicHost}:${machine.relay.port}${browserWsPath}`,
          puppeteerUrl: `ws://${agentConfig.publicHost}:${machine.relay.port}${browserWsPath}`,
          debugHttpUrl: machine.debugHttpUrl(),
          startedAt: machine.startedAt,
          launchTimings,
        };
      } catch (error) {
        this.#sessions.delete(sessionId);
        this.#schedulerStates.delete(sessionId);
        const stdoutTail = tailFile(machine.stdoutLogPath);
        const stderrTail = tailFile(machine.stderrLogPath);
        await this.#destroyMachine(machine).catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        const enrichedError = new Error(
          [
            message,
            stdoutTail ? `firecracker-stdout:\n${stdoutTail}` : "",
            stderrTail ? `firecracker-stderr:\n${stderrTail}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        const shouldRetry =
          attempt < maxAttempts && shouldRetryFirecrackerRestoreError(enrichedError);
        if (!shouldRetry) {
          throw enrichedError;
        }

        log("firecracker", "restore-retrying", {
          sessionId,
          attempt,
          maxAttempts,
          reason: message,
        });
        await sleep(100);
      }
    }

    throw new Error(`Firecracker restore exhausted retries for session ${sessionId}.`);
  }

  async terminateSession(sessionId: string): Promise<void> {
    const machine = this.#sessions.get(sessionId);
    if (!machine) {
      return;
    }

    this.#warmSessionIds.delete(sessionId);
    this.#warmSessionProfiles.delete(sessionId);
    this.#warmSessionLastProbeAt.delete(sessionId);
    this.#sessions.delete(sessionId);
    this.#schedulerStates.delete(sessionId);
    await this.#destroyMachine(machine, true);
  }

  async destroyMachine(instanceId: string): Promise<void> {
    const machine = this.#sessions.get(instanceId);
    if (machine) {
      this.#warmSessionIds.delete(instanceId);
      this.#warmSessionProfiles.delete(instanceId);
      this.#warmSessionLastProbeAt.delete(instanceId);
      this.#sessions.delete(instanceId);
      this.#schedulerStates.delete(instanceId);
      await this.#destroyMachine(machine, true);
    }
  }

  async reconcileTrackedSessions(trackedSessionIds: Set<string>): Promise<void> {
    const staleSessionIds = [...this.#sessions.keys()].filter(
      (sessionId) => !trackedSessionIds.has(sessionId) && !this.#warmSessionIds.has(sessionId),
    );
    for (const sessionId of staleSessionIds) {
      await this.terminateSession(sessionId).catch((error) => {
        logError("firecracker", "stale-tracked-session-cleanup-failed", error, {
          sessionId,
        });
      });
    }
  }

  async #ensureNetworkSlot(slotIndex: number): Promise<FirecrackerNetworkSlot> {
    const slotId = `slot${String(slotIndex).padStart(2, "0")}`;
    const existing = this.#networkSlots.get(slotId);
    if (existing && existing.state !== "unhealthy" && existing.state !== "rebuilding") {
      return existing;
    }

    return this.#ensureSlotRebuild(slotId, slotIndex);
  }

  async #claimNetworkSlot(
    sessionId: string,
  ): Promise<{
    slot: FirecrackerNetworkSlot;
    networkClaimMs: number;
    networkValidateMs: number;
    networkPrepareMissMs: number;
    networkSetupMs: number;
  }> {
    const started = performance.now();
    const targetSize = Math.max(
      0,
      Math.min(agentConfig.firecrackerNetworkPoolSize, agentConfig.firecrackerMaxMicrovmCount),
    );
    if (targetSize === 0) {
      throw new Error("Firecracker network pool size must be at least 1.");
    }

    if (this.#networkSlots.size < targetSize) {
      await this.prepareNetworkPool(true);
    }

    const claimStarted = performance.now();
    let slotId: string | undefined;
    let slot: FirecrackerNetworkSlot | undefined;
    while (this.#freeNetworkSlotIds.length > 0) {
      const candidateId = this.#freeNetworkSlotIds.shift();
      if (!candidateId) {
        continue;
      }
      const candidate = this.#networkSlots.get(candidateId);
      if (!candidate) {
        continue;
      }
      if (candidate.state !== "free") {
        continue;
      }
      slotId = candidateId;
      slot = candidate;
      break;
    }
    const networkClaimMs = performance.now() - claimStarted;
    if (!slotId) {
      if (this.#slotRebuildPromises.size > 0) {
        await Promise.allSettled(this.#slotRebuildPromises.values());
        return this.#claimNetworkSlot(sessionId);
      }
      throw new Error("No prepared Firecracker network slots are available.");
    }

    if (!slot) {
      if (this.#slotRebuildPromises.size > 0) {
        await Promise.allSettled(this.#slotRebuildPromises.values());
        return this.#claimNetworkSlot(sessionId);
      }
      throw new Error(`Claimed network slot '${slotId}' is missing from the slot registry.`);
    }

    let networkPrepareMissMs = 0;
    let networkValidateMs = 0;
    if (
      agentConfig.firecrackerNetworkSlotValidateOnClaim ||
      agentConfig.firecrackerNetworkSlotEgressProbeOnClaim ||
      slot.requiresClaimValidation
    ) {
      const validateStarted = performance.now();
      const [networkValid, egressValid] = await Promise.all([
        validateSlotNetworkFast(slot),
        agentConfig.firecrackerNetworkSlotEgressProbeOnClaim
          ? validateSlotEgressFast(slot)
          : Promise.resolve(true),
      ]);
      const valid = networkValid && egressValid;
      networkValidateMs = performance.now() - validateStarted;
      if (!valid) {
        slot.state = "unhealthy";
        const rebuildStarted = performance.now();
        slot = await this.#ensureSlotRebuild(slot.slotId, slot.slotIndex);
        const rebuiltIndex = this.#freeNetworkSlotIds.indexOf(slot.slotId);
        if (rebuiltIndex >= 0) {
          this.#freeNetworkSlotIds.splice(rebuiltIndex, 1);
        }
        networkPrepareMissMs = performance.now() - rebuildStarted;
      }
    }

    slot.state = "reserved";
    slot.lastSessionId = sessionId;
    slot.lastValidationAt = new Date().toISOString();
    slot.requiresClaimValidation = false;

    return {
      slot,
      networkClaimMs,
      networkValidateMs,
      networkPrepareMissMs,
      networkSetupMs: performance.now() - started,
    };
  }

  #releaseNetworkSlot(slotId: string): void {
    const slot = this.#networkSlots.get(slotId);
    if (!slot || !canReleaseFirecrackerNetworkSlot(slot.state)) {
      return;
    }

    slot.state = "free";
    slot.lastValidationAt = new Date().toISOString();
    slot.requiresClaimValidation = true;
    if (!this.#freeNetworkSlotIds.includes(slotId)) {
      this.#freeNetworkSlotIds.push(slotId);
    }
  }

  #markSlotUnhealthy(slotId: string): void {
    const slot = this.#networkSlots.get(slotId);
    if (!slot) {
      return;
    }

    slot.state = "unhealthy";
    slot.requiresClaimValidation = true;
    const freeIndex = this.#freeNetworkSlotIds.indexOf(slotId);
    if (freeIndex >= 0) {
      this.#freeNetworkSlotIds.splice(freeIndex, 1);
    }
    this.#scheduleSlotRebuild(slotId, slot.slotIndex);
  }

  #scheduleSlotRebuild(slotId: string, slotIndex: number): void {
    if (this.#slotRebuildPromises.has(slotId)) {
      return;
    }

    const rebuild = this.#ensureSlotRebuild(slotId, slotIndex)
      .catch((error) => {
        logError("firecracker", "network-slot-rebuild-failed", error, {
          slotId,
          slotIndex,
        });
        throw error;
      })
      .finally(() => {
        this.#slotRebuildPromises.delete(slotId);
      });

    this.#slotRebuildPromises.set(slotId, rebuild);
  }

  async #ensureSlotRebuild(slotId: string, slotIndex: number): Promise<FirecrackerNetworkSlot> {
    const existingPromise = this.#slotRebuildPromises.get(slotId);
    if (existingPromise) {
      return existingPromise;
    }

    const rebuild = this.#rebuildNetworkSlot(slotId, slotIndex).finally(() => {
      this.#slotRebuildPromises.delete(slotId);
    });
    this.#slotRebuildPromises.set(slotId, rebuild);
    return rebuild;
  }

  async #rebuildNetworkSlot(slotId: string, slotIndex: number): Promise<FirecrackerNetworkSlot> {
    const names = resourceNamesForInstanceId(slotId, agentConfig.firecrackerTapPrefix);
    const linkNetwork = namespaceLinkNetworkForIndex(slotIndex);
    const network = fixedGuestNetwork();

    const existing = this.#networkSlots.get(slotId);
    if (existing) {
      existing.state = "rebuilding";
    }

    await cleanupNetnsProcesses(names.netnsName).catch(() => undefined);
    await removeNetns(names.netnsName).catch(() => undefined);
    try {
      await execPrivileged("ip", ["link", "del", names.rootVethName]);
    } catch {
      // Ignore if already removed.
    }

    await ensureHostInternetEgress(agentConfig.firecrackerTapPrefix);
    await setupNamespacedNetwork(
      names.netnsName,
      names.tapName,
      names.rootVethName,
      names.nsVethName,
      linkNetwork.rootVethIp,
      linkNetwork.nsVethIp,
      network.hostIp,
    );

    const slot: FirecrackerNetworkSlot = {
      slotId,
      slotIndex,
      tapName: names.tapName,
      netnsName: names.netnsName,
      rootVethName: names.rootVethName,
      nsVethName: names.nsVethName,
      rootVethIp: linkNetwork.rootVethIp,
      nsVethIp: linkNetwork.nsVethIp,
      hostIp: network.hostIp,
      guestIp: network.guestIp,
      guestMac: network.guestMac,
      state: "free",
      lastValidationAt: new Date().toISOString(),
      lastSessionId: existing?.lastSessionId,
      requiresClaimValidation: false,
    };

    this.#networkSlots.set(slotId, slot);
    this.#freeNetworkSlotIds.splice(
      0,
      this.#freeNetworkSlotIds.length,
      ...this.#freeNetworkSlotIds.filter((candidate) => candidate !== slotId),
    );
    if (!this.#freeNetworkSlotIds.includes(slotId)) {
      this.#freeNetworkSlotIds.push(slotId);
      this.#freeNetworkSlotIds.sort();
    }

    return slot;
  }

  async #killSlotHelperProcesses(
    slot: FirecrackerNetworkSlot,
    options: { graceMs?: number; reason?: string; cleanupNetns?: boolean } = {},
  ): Promise<void> {
    if (options.cleanupNetns !== false) {
      await cleanupNetnsProcesses(slot.netnsName).catch(() => undefined);
    }

    const helperPatterns = [
      slot.netnsName,
      slot.tapName,
      slot.rootVethName,
      slot.nsVethName,
      slot.rootVethIp,
      slot.nsVethIp,
    ];
    const helperLinesPass1 = await readPsProcessLines();
    const helperPids = [
      ...new Set([
        ...pidsFromPsLinesMatching(helperLinesPass1, helperPatterns, { mustInclude: "socat" }),
        ...pidsFromPsLinesMatching(helperLinesPass1, helperPatterns, {
          mustInclude: "firecracker-egress-proxy",
        }),
      ]),
    ];
    if (helperPids.length === 0) {
      return;
    }

    const graceMs = Math.max(
      0,
      options.graceMs ?? agentConfig.firecrackerSlotHelperCleanupGraceMs,
    );
    log("firecracker", "slot-helper-cleanup", {
      slotId: slot.slotId,
      tapName: slot.tapName,
      helperPidCount: helperPids.length,
      graceMs,
      reason: options.reason ?? "unknown",
    });

    await signalPids(helperPids, "TERM");
    if (graceMs > 0) {
      await sleep(graceMs);
    }
    const helperLinesPass2 = await readPsProcessLines();
    const remaining = [
      ...new Set([
        ...pidsFromPsLinesMatching(helperLinesPass2, helperPatterns, { mustInclude: "socat" }),
        ...pidsFromPsLinesMatching(helperLinesPass2, helperPatterns, {
          mustInclude: "firecracker-egress-proxy",
        }),
      ]),
    ];
    await signalPids(remaining, "KILL");
  }

  async #destroyMachine(machine: FirecrackerMachineHandle, skipSlotValidation = false): Promise<void> {
    await machine.relay.close().catch(() => undefined);
    await Promise.allSettled([
      stopPrivilegedProcess(machine.benchProxyProcess, 150),
      stopPrivilegedProcess(machine.proxyProcess, 150),
      stopPrivilegedProcess(machine.egressProxyProcess, 150),
    ]);

    const socketLinesPass1 = await readPsProcessLines();
    const socketPids = pidsFromPsLinesForSocketPath(socketLinesPass1, machine.apiSocketPath);
    await signalPids(socketPids, "TERM");
    await sleep(50);
    const socketLinesPass2 = await readPsProcessLines();
    const remainingSocketPids = pidsFromPsLinesForSocketPath(
      socketLinesPass2,
      machine.apiSocketPath,
    );
    await signalPids(remainingSocketPids, "KILL");

    if (machine.process.child.pid) {
      await stopPrivilegedProcess(machine.process, 250);
    }

    await this.#killSlotHelperProcesses({
      slotId: machine.networkSlotId,
      slotIndex: this.#networkSlots.get(machine.networkSlotId)?.slotIndex ?? 0,
      tapName: machine.tapName,
      netnsName: machine.netnsName,
      rootVethName: machine.rootVethName,
      nsVethName: machine.nsVethName,
      rootVethIp: machine.rootVethIp,
      nsVethIp: machine.nsVethIp,
      hostIp: machine.hostIp,
      guestIp: machine.guestIp,
      guestMac: machine.guestMac,
      state: "reserved",
    }, {
      graceMs: agentConfig.firecrackerSlotHelperCleanupGraceMs,
      reason: "destroy",
      cleanupNetns: true,
    }).catch(() => undefined);
    fs.rmSync(machine.stateDir, { recursive: true, force: true });
    fs.rmSync(machine.apiSocketPath, { force: true });
    await this.#cleanupMachineCgroup(machine).catch(() => undefined);

    const slot = this.#networkSlots.get(machine.networkSlotId);
    if (!slot) {
      return;
    }

    if (skipSlotValidation) {
      if (!canReleaseFirecrackerNetworkSlot(slot.state)) {
        return;
      }
      this.#releaseNetworkSlot(machine.networkSlotId);
      return;
    }

    const [networkHealthy, egressHealthy] = await Promise.all([
      validateSlotNetworkFast(slot),
      agentConfig.firecrackerNetworkSlotEgressProbeOnClaim
        ? validateSlotEgressFast(slot)
        : Promise.resolve(true),
    ]);
    const healthy = networkHealthy && egressHealthy;
    if (healthy) {
      this.#releaseNetworkSlot(machine.networkSlotId);
      return;
    }

    this.#markSlotUnhealthy(machine.networkSlotId);
  }

  async #bootFromRootfs(instanceId: string): Promise<FirecrackerMachineHandle> {
    return this.#bootFromRootfsWithOptions(instanceId, {
      rootfsPath: agentConfig.firecrackerRootfsPath,
      requiresLocalProxy: false,
    });
  }

  async #bootFromRootfsWithOptions(
    instanceId: string,
    options: {
      rootfsPath: string;
      requiresLocalProxy: boolean;
    },
  ): Promise<FirecrackerMachineHandle> {
    const network = fixedGuestNetwork();
    const spawned = await this.#spawnMachine(
      instanceId,
      network,
      { proxyProfile: options.requiresLocalProxy ? "proxy" : "direct" },
      options.requiresLocalProxy,
      async (socketPath, tapName) => {
      await firecrackerRequest(socketPath, "PUT", "/machine-config", {
        vcpu_count: agentConfig.firecrackerGuestVcpuCount,
        mem_size_mib: agentConfig.firecrackerGuestMemoryMb,
        track_dirty_pages: agentConfig.firecrackerTrackDirtyPages,
      });
      await firecrackerRequest(socketPath, "PUT", "/boot-source", {
        kernel_image_path: agentConfig.firecrackerKernelPath,
        boot_args: bootArgs(network.hostIp, network.guestIp),
      });
      await firecrackerRequest(socketPath, "PUT", "/drives/rootfs", {
        drive_id: "rootfs",
        path_on_host: options.rootfsPath,
        is_root_device: true,
        is_read_only: true,
      });
      await firecrackerRequest(socketPath, "PUT", "/network-interfaces/net1", {
        iface_id: "net1",
        host_dev_name: tapName,
        guest_mac: network.guestMac,
      });
      await firecrackerRequest(socketPath, "PUT", "/actions", {
        action_type: "InstanceStart",
      });
      },
    );
    const machine = spawned.machine;

    try {
      await waitForJson(machine.localDebugHttpUrl(), agentConfig.firecrackerBootTimeoutMs);
      return machine;
    } catch (error) {
      const stdoutTail = tailFile(machine.stdoutLogPath);
      const stderrTail = tailFile(machine.stderrLogPath);
      await this.#destroyMachine(machine).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        [
          message,
          stdoutTail ? `firecracker-stdout:\n${stdoutTail}` : "",
          stderrTail ? `firecracker-stderr:\n${stderrTail}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }
  }

  async #restoreFromSnapshot(
    instanceId: string,
    proxyConfig: FirecrackerSessionProxyConfig,
    snapshotName: string,
  ): Promise<SpawnMachineResult> {
    const spec = this.getSnapshotInfo(snapshotName);
    if (!fs.existsSync(spec.snapshotPath) || !fs.existsSync(spec.memFilePath)) {
      throw new Error(
        `Firecracker snapshot is missing. Expected ${spec.snapshotPath} and ${spec.memFilePath}.`,
      );
    }

    const network = fixedGuestNetwork();
    return this.#spawnMachine(
      instanceId,
      network,
      proxyConfig,
      snapshotTargetForProxyConfig(proxyConfig).requiresLocalProxy,
      async (socketPath, tapName) => {
      await firecrackerRequest(socketPath, "PUT", "/snapshot/load", {
        snapshot_path: spec.snapshotPath,
        mem_file_path: spec.memFilePath,
        enable_diff_snapshots: agentConfig.firecrackerEnableDiffSnapshots,
        resume_vm: true,
        network_overrides: [
          {
            iface_id: "net1",
            host_dev_name: tapName,
            guest_mac: network.guestMac,
          },
        ],
      });
      },
    );
  }

  async #spawnMachine(
    instanceId: string,
    network: { hostIp: string; guestIp: string; guestMac: string },
    proxyConfig: FirecrackerSessionProxyConfig,
    requiresLocalProxy: boolean,
    configure: (socketPath: string, tapName: string) => Promise<void>,
  ): Promise<SpawnMachineResult> {
    requireLinux("Firecracker machine launch");

    const stateDir = path.join(agentConfig.firecrackerStateDir, instanceId);
    const apiSocketPath = path.join(agentConfig.firecrackerApiDir, `${instanceId}.sock`);
    assertFirecrackerApiSocketPathLength(apiSocketPath);
    const stdoutLogPath = path.join(stateDir, "firecracker.stdout.log");
    const stderrLogPath = path.join(stateDir, "firecracker.stderr.log");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(agentConfig.firecrackerApiDir, { recursive: true });
    fs.rmSync(apiSocketPath, { force: true });

    const claimed = await this.#claimNetworkSlot(instanceId);
    const { slot } = claimed;
    const helperCleanupStarted = performance.now();
    if (agentConfig.firecrackerPrelaunchHelperCleanup) {
      await this.#killSlotHelperProcesses(slot, {
        graceMs: agentConfig.firecrackerPrelaunchHelperCleanupGraceMs,
        reason: "prelaunch",
      });
    }
    const helperCleanupMs = performance.now() - helperCleanupStarted;

    const processSpawnStarted = performance.now();
    const benchSitePort = optionalEnvInt("BENCH_SITE_PORT");

    const [child, proxyProcess, egressProxyProcess, benchProxyProcess] = await Promise.all([
      spawnPrivileged(
        "ip",
        ["netns", "exec", slot.netnsName, agentConfig.firecrackerBin, "--api-sock", apiSocketPath],
        {
        cwd: stateDir,
        stdio: ["ignore", "pipe", "pipe"],
        },
      ),
      spawnPrivileged(
        "ip",
        [
          "netns",
          "exec",
          slot.netnsName,
          "socat",
          `TCP-LISTEN:${agentConfig.firecrackerCdpPort},bind=${slot.nsVethIp},reuseaddr,fork`,
          `TCP:${network.guestIp}:${agentConfig.firecrackerCdpPort}`,
        ],
        {
          cwd: stateDir,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
      requiresLocalProxy
        ? spawnPrivileged(
            "ip",
            [
              "netns",
              "exec",
              slot.netnsName,
              process.execPath,
              path.join(process.cwd(), "dist", "node-agent", "firecracker-egress-proxy.js"),
              network.hostIp,
              String(agentConfig.firecrackerProxyPort),
              proxyConfig.upstreamProxyUrl ?? "",
            ],
            {
              cwd: stateDir,
              stdio: ["ignore", "pipe", "pipe"],
            },
          )
        : Promise.resolve(undefined),
      benchSitePort === undefined
        ? Promise.resolve(undefined)
        : spawnPrivileged(
            "ip",
            [
              "netns",
              "exec",
              slot.netnsName,
              "socat",
              `TCP-LISTEN:${benchSitePort},bind=${network.hostIp},reuseaddr,fork`,
              `TCP:${slot.rootVethIp}:${benchSitePort}`,
            ],
            {
              cwd: stateDir,
              stdio: ["ignore", "pipe", "pipe"],
            },
          ),
    ]);

    const stdoutLines: string[] = [];
    const stdoutStream = fs.createWriteStream(stdoutLogPath, { flags: "a" });
    const stderrStream = fs.createWriteStream(stderrLogPath, { flags: "a" });
    child.child.stdout?.on("data", (chunk) => stdoutLines.push(String(chunk)));
    child.child.stderr?.on("data", (chunk) => stdoutLines.push(String(chunk)));
    child.child.stdout?.on("data", (chunk) => stdoutStream.write(chunk));
    child.child.stderr?.on("data", (chunk) => stderrStream.write(chunk));
    proxyProcess.child.stdout?.on("data", (chunk) => stdoutStream.write(chunk));
    proxyProcess.child.stderr?.on("data", (chunk) => stderrStream.write(chunk));
    egressProxyProcess?.child.stdout?.on("data", (chunk) => stdoutStream.write(chunk));
    egressProxyProcess?.child.stderr?.on("data", (chunk) => stderrStream.write(chunk));
    benchProxyProcess?.child.stdout?.on("data", (chunk) => stdoutStream.write(chunk));
    benchProxyProcess?.child.stderr?.on("data", (chunk) => stderrStream.write(chunk));
    child.child.once("exit", () => {
      stdoutStream.end();
      stderrStream.end();
    });

    try {
      await waitForPath(apiSocketPath, 10_000);
      const processSpawnMs = performance.now() - processSpawnStarted;
      if (typeof process.getuid === "function" && process.getuid() !== 0) {
        await execPrivileged("chmod", ["0666", apiSocketPath]);
      }
      const firecrackerPid = await findFirecrackerPidBySocketPath(apiSocketPath);

      const configureStarted = performance.now();
      await configure(apiSocketPath, slot.tapName);
      const configureMs = performance.now() - configureStarted;

      const relayStarted = performance.now();
      const relay = await createTcpRelay(
        agentConfig.relayBindHost,
        slot.nsVethIp,
        agentConfig.firecrackerCdpPort,
      );
      const relayReadyMs = performance.now() - relayStarted;

      const machine: FirecrackerMachineHandle = {
        instanceId,
        apiSocketPath,
        stateDir,
        tapName: slot.tapName,
        netnsName: slot.netnsName,
        rootVethName: slot.rootVethName,
        nsVethName: slot.nsVethName,
        rootVethIp: slot.rootVethIp,
        nsVethIp: slot.nsVethIp,
        hostIp: network.hostIp,
        guestIp: network.guestIp,
        guestMac: network.guestMac,
        relay,
        process: child,
        proxyProcess,
        egressProxyProcess,
        benchProxyProcess,
        firecrackerPid,
        networkSlotId: slot.slotId,
        startedAt: new Date().toISOString(),
        stdoutLogPath,
        stderrLogPath,
        debugHttpUrl() {
          return `http://${agentConfig.publicHost}:${relay.port}/json/version`;
        },
        localDebugHttpUrl() {
          return `http://${agentConfig.relayProbeHost}:${relay.port}/json/version`;
        },
      };

      log("firecracker", "machine-started", {
        instanceId,
        slotId: slot.slotId,
        tapName: slot.tapName,
        guestIp: network.guestIp,
        netnsName: slot.netnsName,
        nsRelayIp: slot.nsVethIp,
        relayPort: relay.port,
      });

      return {
        machine,
        launchTimings: {
          networkSetupMs: claimed.networkSetupMs,
          networkClaimMs: claimed.networkClaimMs,
          networkValidateMs: claimed.networkValidateMs,
          networkPrepareMissMs: claimed.networkPrepareMissMs,
          helperCleanupMs,
          processSpawnMs,
          configureMs,
          relayReadyMs,
        },
      };
    } catch (error) {
      child.kill("SIGKILL");
      proxyProcess.kill("SIGKILL");
      egressProxyProcess?.kill("SIGKILL");
      benchProxyProcess?.kill("SIGKILL");
      this.#markSlotUnhealthy(slot.slotId);
      fs.rmSync(stateDir, { recursive: true, force: true });
      throw new Error(
        error instanceof Error
          ? `${error.message}\nfirecracker-output:\n${stdoutLines.join("")}`
          : String(error),
      );
    }
  }

  async reconcileStaleResources(): Promise<void> {
    this.#networkSlots.clear();
    this.#freeNetworkSlotIds.splice(0, this.#freeNetworkSlotIds.length);
    const summary = await cleanupFirecrackerHostResources();
    if (
      summary.staleProcessesKilled > 0 ||
      summary.staleNetnsRemoved > 0 ||
      summary.stateEntriesRemoved > 0 ||
      summary.apiEntriesRemoved > 0
    ) {
      log("firecracker", "stale-resource-cleanup", summary);
    }
  }
}

export function firecrackerCapabilitySummary(): {
  supported: boolean;
  platform: string;
  totalMemoryMb: number;
} {
  return {
    supported: isLinux(),
    platform: process.platform,
    totalMemoryMb: bytesToMb(os.totalmem()),
  };
}
