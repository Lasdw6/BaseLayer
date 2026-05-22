import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

type DensityLevel = {
  requestedConcurrency: number;
  avgCreateMs: number;
  avgNavigateMs: number;
  createSuccessRate: number;
  navigationSuccessRate: number;
  soakActionFailures: number;
};

type DensityProfile = {
  profileId: string;
  label: string;
  maxStableConcurrency: number;
  levels: DensityLevel[];
};

type DensityReport = {
  benchmark: string;
  maxConcurrency: number;
  soakSeconds: number;
  activeSessionRatio: number;
  activeRoundsPerSession: number;
  activePauseMs: number;
  results: DensityProfile[];
};

type BrowserlessDensityLevel = {
  requestedConcurrency: number;
  successes: number;
  successRate: number;
  avgConnectMs: number;
  avgNavigateMs: number;
  soakActionFailures: number;
};

type BrowserlessReport = {
  benchmark: string;
  image: string;
  configuredConcurrency: number;
  soakSeconds: number;
  activeSessionRatio: number;
  activeRoundsPerSession: number;
  activePauseMs: number;
  density: {
    maxStableConcurrency: number;
    levels: BrowserlessDensityLevel[];
  };
};

const execFileAsync = promisify(execFile);
const root = process.cwd();
const resultsPath = path.join(root, "results.md");
const snapshotsDir = path.join(root, "data", "benchmarks", "snapshots");

function formatNumber(value: number | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "n/a";
  }

  return value.toFixed(2);
}

function findLevel<T extends { requestedConcurrency: number }>(
  levels: T[],
  requestedConcurrency: number,
): T | undefined {
  return levels.find((level) => level.requestedConcurrency === requestedConcurrency);
}

async function runBuiltScript(scriptPath: string): Promise<unknown> {
  const { stdout } = await execFileAsync(process.execPath, [scriptPath], {
    cwd: root,
    env: process.env,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function appendSnapshotMarkdown(
  existing: string,
  timestamp: string,
  density: DensityReport,
  browserless: BrowserlessReport,
): string {
  const targetConcurrency = density.maxConcurrency;
  const baseline = density.results.find(
    (result) => result.profileId === "BaseLayer-Bulbasaur-generic-container",
  );
  const managed = density.results.find(
    (result) => result.profileId === "BaseLayer-Charizard-managed-node",
  );
  const baselineLevel = baseline
    ? findLevel(baseline.levels, targetConcurrency) ?? baseline.levels.at(-1)
    : undefined;
  const managedLevel = managed
    ? findLevel(managed.levels, targetConcurrency) ?? managed.levels.at(-1)
    : undefined;
  const browserlessLevel =
    findLevel(browserless.density.levels, targetConcurrency) ??
    browserless.density.levels.at(-1);

  const section = `

## Snapshot ${timestamp}

- Workload:
  - \`maxConcurrency=${density.maxConcurrency}\`
  - \`soakSeconds=${density.soakSeconds}\`
  - \`activeSessionRatio=${density.activeSessionRatio}\`
  - \`activeRoundsPerSession=${density.activeRoundsPerSession}\`
  - \`activePauseMs=${density.activePauseMs}\`
- Baseline @ c${targetConcurrency}:
  - \`avgCreateMs=${formatNumber(baselineLevel?.avgCreateMs)}\`
  - \`avgNavigateMs=${formatNumber(baselineLevel?.avgNavigateMs)}\`
  - \`maxStableConcurrency=${baseline?.maxStableConcurrency ?? "n/a"}\`
- Managed @ c${targetConcurrency}:
  - \`avgCreateMs=${formatNumber(managedLevel?.avgCreateMs)}\`
  - \`avgNavigateMs=${formatNumber(managedLevel?.avgNavigateMs)}\`
  - \`maxStableConcurrency=${managed?.maxStableConcurrency ?? "n/a"}\`
- Browserless local @ c${targetConcurrency}:
  - \`avgConnectMs=${formatNumber(browserlessLevel?.avgConnectMs)}\`
  - \`avgNavigateMs=${formatNumber(browserlessLevel?.avgNavigateMs)}\`
  - \`maxStableConcurrency=${browserless.density.maxStableConcurrency}\`
`;

  return `${existing.trimEnd()}\n${section}\n`;
}

async function main(): Promise<void> {
  fs.mkdirSync(snapshotsDir, { recursive: true });

  const density = (await runBuiltScript("dist/bench/density.js")) as DensityReport;
  const browserless = (await runBuiltScript(
    "dist/bench/browserless-local.js",
  )) as BrowserlessReport;

  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const snapshot = {
    timestamp,
    density,
    browserless,
  };

  const snapshotPath = path.join(snapshotsDir, `${timestamp}.json`);
  const latestPath = path.join(snapshotsDir, "latest.json");
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  fs.writeFileSync(latestPath, JSON.stringify(snapshot, null, 2));

  const existing = fs.existsSync(resultsPath) ? fs.readFileSync(resultsPath, "utf8") : "# Benchmark Snapshot\n";
  const updated = appendSnapshotMarkdown(existing, timestamp, density, browserless);
  fs.writeFileSync(resultsPath, updated);

  console.log(
    JSON.stringify(
      {
        benchmark: "snapshot",
        snapshotPath,
        latestPath,
        resultsPath,
      },
      null,
      2,
    ),
  );
}

await main();
