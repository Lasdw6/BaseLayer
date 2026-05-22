import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getSupportedProfile } from "./lib/profiles.js";
import type { SupportedProfileId } from "./lib/types.js";

const execFileAsync = promisify(execFile);

interface ProfileMatrixEntry {
  profileId: SupportedProfileId;
  label: string;
  outputPath: string;
  hostsPath: string;
  result: unknown;
  hosts?: unknown;
}

interface ProfileMatrixReport {
  benchmark: "provider-profile-matrix";
  schema: "browserarena-stages-v1";
  generatedAt: string;
  benchmarkDir: string;
  profileIds: SupportedProfileId[];
  concurrencyValues: number[];
  results: ProfileMatrixEntry[];
}

function parseProfileIds(): SupportedProfileId[] {
  const raw = process.env["BENCH_PROFILE_IDS"] ?? process.env["BENCH_SWEEP_PROFILE_IDS"] ?? "";
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error("BENCH_PROFILE_IDS or BENCH_SWEEP_PROFILE_IDS is required for provider-profile-matrix.");
  }

  const seen = new Set<SupportedProfileId>();
  const ids: SupportedProfileId[] = [];
  for (const value of values) {
    const profile = getSupportedProfile(value);
    if (!seen.has(profile.id)) {
      seen.add(profile.id);
      ids.push(profile.id);
    }
  }
  return ids;
}

function parseConcurrencyValues(): number[] {
  const raw = process.env["BENCH_CONCURRENCY_VALUES"] ?? "1,4,8,12,16,24";
  const values = raw
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) {
    throw new Error("BENCH_CONCURRENCY_VALUES must contain at least one positive integer.");
  }
  return values;
}

function sanitizeLabel(value: string): string {
  return value
    .replace(/^BaseLayer-/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

async function readJsonIfExists(filePath: string): Promise<unknown | undefined> {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(await fs.promises.readFile(filePath, "utf8")) as unknown;
}

async function stopBaseLayerProcesses(root: string): Promise<void> {
  await execFileAsync(
    "bash",
    [
      "-lc",
      [
        `pkill -f "${root}/dist/api/server.js" || true`,
        `pkill -f "${root}/dist/node-agent/server.js" || true`,
      ].join("; "),
    ],
    {
      cwd: root,
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    },
  ).catch(() => undefined);
}

async function main(): Promise<void> {
  const root = process.cwd();
  const benchmarkDir =
    process.env["BENCH_REPORT_DIR"] ??
    path.join(root, "data", "benchmarks", `provider-profile-matrix-${Date.now()}`);
  const outputPath =
    process.env["BENCH_OUT"] ?? path.join(benchmarkDir, "provider-profile-matrix.json");
  const runScript = path.join(root, "scripts", "bench", "run-baremetal-provider-matrix.sh");
  const profileIds = parseProfileIds();
  const concurrencyValues = parseConcurrencyValues();

  await fs.promises.mkdir(benchmarkDir, { recursive: true });

  const results: ProfileMatrixEntry[] = [];
  try {
    for (const profileId of profileIds) {
      const profile = getSupportedProfile(profileId);
      const label = sanitizeLabel(profile.id);
      const profileDir = path.join(benchmarkDir, label);
      await fs.promises.mkdir(profileDir, { recursive: true });
      const profileOutputPath = path.join(profileDir, `provider-matrix-${label}.json`);
      const hostsPath = path.join(profileDir, `hosts-after-${label}.json`);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...profile.defaultAgentEnv,
        BENCH_PROFILE_IDS: profile.id,
        BASELAYER_RUNTIME_PROFILE: profile.id,
        BASELAYER_RESET_STATE_ON_START: process.env["BASELAYER_RESET_STATE_ON_START"] ?? "1",
        BENCH_REPORT_DIR: profileDir,
        BENCH_OUT: profileOutputPath,
        BENCH_HOSTS_OUT: hostsPath,
        BENCH_PROFILE_LABEL: label,
        BENCH_CONCURRENCY_VALUES: concurrencyValues.join(","),
      };

      await execFileAsync("bash", [runScript, root], {
        cwd: root,
        env,
        maxBuffer: 64 * 1024 * 1024,
      });

      const result = await readJsonIfExists(profileOutputPath);
      if (!result) {
        throw new Error(`Expected benchmark output for ${profile.id} at ${profileOutputPath}.`);
      }

      results.push({
        profileId: profile.id,
        label,
        outputPath: profileOutputPath,
        hostsPath,
        result,
        hosts: await readJsonIfExists(hostsPath),
      });
    }

    const report: ProfileMatrixReport = {
      benchmark: "provider-profile-matrix",
      schema: "browserarena-stages-v1",
      generatedAt: new Date().toISOString(),
      benchmarkDir,
      profileIds,
      concurrencyValues,
      results,
    };

    await fs.promises.writeFile(outputPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await stopBaseLayerProcesses(root);
  }
}

await main();
