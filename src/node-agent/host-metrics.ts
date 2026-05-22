import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface HostMetricsSnapshot {
  totalMemoryMb: number;
  freeMemoryMb: number;
  usedMemoryMb: number;
  memoryPressurePct: number;
  shmCapacityMb: number;
  shmUsedMb: number;
  cpuUtilizationPct: number;
  loadAvg1m: number;
  loadAvg5m: number;
}

let previousCpuSnapshot:
  | {
      idle: number;
      total: number;
    }
  | undefined;

function bytesToMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

async function readShm(): Promise<{ capacityMb: number; usedMb: number }> {
  try {
    const { stdout } = await execFileAsync("df", ["-k", "/dev/shm"], {
      windowsHide: true,
    });
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const last = lines[lines.length - 1];
    const parts = last?.split(/\s+/) ?? [];
    if (parts.length < 5) {
      return { capacityMb: 0, usedMb: 0 };
    }

    const totalKb = Number.parseInt(parts[1] ?? "0", 10) || 0;
    const usedKb = Number.parseInt(parts[2] ?? "0", 10) || 0;
    return {
      capacityMb: Math.round(totalKb / 1024),
      usedMb: Math.round(usedKb / 1024),
    };
  } catch {
    return { capacityMb: 0, usedMb: 0 };
  }
}

function readPsiMemoryPressurePct(): number {
  try {
    const raw = fs.readFileSync("/proc/pressure/memory", "utf8");
    const line = raw
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith("some "));
    const match = line?.match(/avg10=([\d.]+)/);
    if (!match) {
      return 0;
    }

    return Math.min(100, Number.parseFloat(match[1]) || 0);
  } catch {
    return 0;
  }
}

function readCpuUtilizationPct(): number {
  const cpus = os.cpus();
  if (cpus.length === 0) {
    return 0;
  }

  const snapshot = cpus.reduce(
    (totals, cpu) => {
      const idle = cpu.times.idle;
      const total =
        cpu.times.user +
        cpu.times.nice +
        cpu.times.sys +
        cpu.times.idle +
        cpu.times.irq;
      totals.idle += idle;
      totals.total += total;
      return totals;
    },
    { idle: 0, total: 0 },
  );

  if (!previousCpuSnapshot) {
    previousCpuSnapshot = snapshot;
    return 0;
  }

  const idleDelta = Math.max(0, snapshot.idle - previousCpuSnapshot.idle);
  const totalDelta = Math.max(0, snapshot.total - previousCpuSnapshot.total);
  previousCpuSnapshot = snapshot;
  if (totalDelta === 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}

export async function collectHostMetrics(): Promise<HostMetricsSnapshot> {
  const totalMemoryMb = bytesToMb(os.totalmem());
  const freeMemoryMb = bytesToMb(os.freemem());
  const usedMemoryMb = Math.max(0, totalMemoryMb - freeMemoryMb);
  const memoryPressurePct =
    totalMemoryMb === 0 ? 0 : Math.round((usedMemoryMb / totalMemoryMb) * 100);
  const shm = await readShm();

  return {
    totalMemoryMb,
    freeMemoryMb,
    usedMemoryMb,
    memoryPressurePct: Math.max(memoryPressurePct, readPsiMemoryPressurePct()),
    shmCapacityMb: shm.capacityMb,
    shmUsedMb: shm.usedMb,
    cpuUtilizationPct: readCpuUtilizationPct(),
    loadAvg1m: Number(os.loadavg()[0]?.toFixed(2) ?? 0),
    loadAvg5m: Number(os.loadavg()[1]?.toFixed(2) ?? 0),
  };
}
