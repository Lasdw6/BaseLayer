import { getSupportedProfile } from "./lib/profiles.js";
import { type LatencyBenchmarkResult } from "./lib/types.js";

const childProcess = await import("node:child_process");
const util = await import("node:util");
const execFileAsync = util.promisify(childProcess.execFile);

const { stdout } = await execFileAsync(process.execPath, ["dist/bench/latency.js"], {
  cwd: process.cwd(),
  env: process.env,
  windowsHide: true,
});

const parsed = JSON.parse(stdout) as {
  results: LatencyBenchmarkResult[];
};

const baselineId =
  process.env["BENCH_COMPARE_BASELINE_ID"]?.trim() || "BaseLayer-Bulbasaur-generic-container";
const candidateId =
  process.env["BENCH_COMPARE_CANDIDATE_ID"]?.trim() || "BaseLayer-Charizard-managed-node";

let baseline: LatencyBenchmarkResult | undefined;
let candidate: LatencyBenchmarkResult | undefined;
try {
  baseline = parsed.results.find((result) => result.profileId === getSupportedProfile(baselineId).id);
  candidate = parsed.results.find((result) => result.profileId === getSupportedProfile(candidateId).id);
} catch {
  baseline = parsed.results.find((result) => result.profileId === baselineId);
  candidate = parsed.results.find((result) => result.profileId === candidateId);
}

function delta(
  a: { avg: number } | undefined,
  b: { avg: number } | undefined,
): number {
  return (a?.avg ?? 0) - (b?.avg ?? 0);
}

function faster(
  a: { avg: number } | undefined,
  b: { avg: number } | undefined,
): boolean {
  return (a?.avg ?? Number.POSITIVE_INFINITY) < (b?.avg ?? Number.POSITIVE_INFINITY);
}

console.log(
  JSON.stringify(
    {
      baselineId,
      candidateId,
      baseline,
      candidate,
      comparison: {
        session_creation_ms_delta: delta(candidate?.session_creation_ms, baseline?.session_creation_ms),
        session_connect_ms_delta: delta(candidate?.session_connect_ms, baseline?.session_connect_ms),
        page_goto_ms_delta: delta(candidate?.page_goto_ms, baseline?.page_goto_ms),
        session_release_ms_delta: delta(candidate?.session_release_ms, baseline?.session_release_ms),
        browserarena_latency_ms_delta: delta(
          candidate?.browserarena_latency_ms,
          baseline?.browserarena_latency_ms,
        ),
        firstContentfulPaint_ms_delta: delta(
          candidate?.firstContentfulPaintMs,
          baseline?.firstContentfulPaintMs,
        ),
        candidateFasterSessionCreation: faster(
          candidate?.session_creation_ms,
          baseline?.session_creation_ms,
        ),
        candidateFasterSessionConnect: faster(
          candidate?.session_connect_ms,
          baseline?.session_connect_ms,
        ),
        candidateFasterPageGoto: faster(candidate?.page_goto_ms, baseline?.page_goto_ms),
        candidateFasterSessionRelease: faster(
          candidate?.session_release_ms,
          baseline?.session_release_ms,
        ),
        candidateFasterBrowserArenaLatency: faster(
          candidate?.browserarena_latency_ms,
          baseline?.browserarena_latency_ms,
        ),
        candidateFasterFcp: faster(
          candidate?.firstContentfulPaintMs,
          baseline?.firstContentfulPaintMs,
        ),
      },
    },
    null,
    2,
  ),
);
