import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { BenchmarkRunMetadata, SupportedProfileConfig } from "./types.js";

const execFileAsync = promisify(execFile);

function readFirstLine(filePath: string): string | undefined {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return text.split(/\r?\n/)[0]?.trim();
  } catch {
    return undefined;
  }
}

function readCpuModel(): string | undefined {
  if (os.platform() !== "linux") {
    return undefined;
  }
  try {
    const text = fs.readFileSync("/proc/cpuinfo", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^model name\s*:\s*(.+)$/i.exec(line);
      if (match?.[1]) {
        return match[1].trim();
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

function readTransparentHugepage(): string | undefined {
  if (os.platform() !== "linux") {
    return undefined;
  }
  return readFirstLine("/sys/kernel/mm/transparent_hugepage/enabled");
}

function readCgroupControllers(): string | undefined {
  if (os.platform() !== "linux") {
    return undefined;
  }
  return readFirstLine("/sys/fs/cgroup/cgroup.controllers");
}

async function readFirecrackerVersion(bin: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], {
      windowsHide: true,
      timeout: 5_000,
    });
    return stdout.split(/\r?\n/)[0]?.trim();
  } catch {
    return undefined;
  }
}

async function buildBenchmarkRunMetadata(
  merged: Record<string, string | undefined>,
  profileId: string | undefined,
): Promise<BenchmarkRunMetadata> {
  const kernelPath = merged["FIRECRACKER_KERNEL_PATH"];
  const rootfsPath = merged["FIRECRACKER_ROOTFS_PATH"];
  const fcBin = merged["FIRECRACKER_BIN"] ?? "firecracker";

  let firecrackerKernelBytes: number | undefined;
  let firecrackerKernelMtimeMs: number | undefined;
  if (kernelPath) {
    try {
      const st = fs.statSync(kernelPath);
      firecrackerKernelBytes = st.size;
      firecrackerKernelMtimeMs = Math.round(st.mtimeMs);
    } catch {
      // ignore
    }
  }

  let firecrackerRootfsBytes: number | undefined;
  let firecrackerRootfsMtimeMs: number | undefined;
  if (rootfsPath) {
    try {
      const st = fs.statSync(rootfsPath);
      firecrackerRootfsBytes = st.size;
      firecrackerRootfsMtimeMs = Math.round(st.mtimeMs);
    } catch {
      // ignore
    }
  }

  let firecrackerKernelVersionLabel: string | undefined;
  if (kernelPath) {
    const sidecar = path.join(path.dirname(kernelPath), "vmlinux.version");
    try {
      firecrackerKernelVersionLabel = fs.readFileSync(sidecar, "utf8").trim().split(/\r?\n/)[0];
    } catch {
      // ignore
    }
  }

  const firecrackerVersion = await readFirecrackerVersion(fcBin);

  return {
    collectedAt: new Date().toISOString(),
    os: os.type(),
    platform: os.platform(),
    nodeVersion: process.version,
    profileId,
    cpuModel: readCpuModel(),
    transparentHugepage: readTransparentHugepage(),
    cgroupControllers: readCgroupControllers(),
    firecrackerVersion,
    firecrackerKernelPath: kernelPath,
    firecrackerKernelBytes,
    firecrackerKernelMtimeMs,
    firecrackerKernelVersionLabel,
    firecrackerRootfsPath: rootfsPath,
    firecrackerRootfsBytes,
    firecrackerRootfsMtimeMs,
  };
}

/**
 * Snapshot kernel/rootfs identity and host shape for benchmark JSON artifacts.
 */
export async function collectBenchmarkRunMetadata(
  profile: SupportedProfileConfig,
): Promise<BenchmarkRunMetadata> {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    ...profile.defaultAgentEnv,
  };
  return buildBenchmarkRunMetadata(merged, profile.id);
}

/**
 * Same host snapshot as {@link collectBenchmarkRunMetadata}, using only
 * `process.env` (for provider-api / bare-metal runs where no profile object exists).
 * Set `FIRECRACKER_KERNEL_PATH`, `FIRECRACKER_ROOTFS_PATH`, etc. on the benchmark process.
 */
export async function collectBenchmarkRunMetadataFromEnv(
  profileId?: string,
): Promise<BenchmarkRunMetadata> {
  const merged: Record<string, string | undefined> = { ...process.env };
  return buildBenchmarkRunMetadata(merged, profileId);
}
