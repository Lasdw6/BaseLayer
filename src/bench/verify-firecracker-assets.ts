/**
 * Preflight: ensure kernel + rootfs exist for each active Firecracker benchmark profile.
 * Run before paid remote or long matrix work: `npm run bench:verify-firecracker`
 * (after `npm run build` so dist/ is current if you only ship dist).
 */
import fs from "node:fs";
import os from "node:os";

import { assertCustomChromiumHostPrerequisitesIfNeeded } from "./lib/custom-chromium-preflight.js";
import { ACTIVE_BENCHMARK_PROFILES } from "./lib/profiles.js";

function mergedAgentEnv(profile: {
  mode: string;
  defaultAgentEnv: Record<string, string>;
}): Record<string, string | undefined> {
  return { ...process.env, ...profile.defaultAgentEnv };
}

function main(): void {
  if (os.platform() !== "linux") {
    console.warn(
      "[verify-firecracker-assets] Skipping: not Linux (set BENCH_ENABLE_FIRECRACKER=1 on Linux only).",
    );
    return;
  }

  if (process.env["BENCH_ENABLE_FIRECRACKER"] !== "1") {
    console.warn(
      "[verify-firecracker-assets] Skipping: BENCH_ENABLE_FIRECRACKER is not 1.",
    );
    return;
  }

  const requestedRaw = process.env["BENCH_PROFILE_IDS"] ?? "";
  if (requestedRaw.trim() && ACTIVE_BENCHMARK_PROFILES.length === 0) {
    console.error(
      "[verify-firecracker-assets] No profiles matched BENCH_PROFILE_IDS. Check IDs (commas, typos, legacy aliases).",
    );
    process.exit(1);
  }

  const failures: string[] = [];
  for (const profile of ACTIVE_BENCHMARK_PROFILES) {
    if (profile.mode !== "firecracker") {
      continue;
    }
    const env = mergedAgentEnv(profile);
    const kernel = env["FIRECRACKER_KERNEL_PATH"];
    const rootfs = env["FIRECRACKER_ROOTFS_PATH"];
    if (!kernel || !fs.existsSync(kernel)) {
      failures.push(
        `  ${profile.id}: kernel missing or unreadable: ${kernel ?? "(unset)"}`,
      );
    }
    if (!rootfs || !fs.existsSync(rootfs)) {
      failures.push(
        `  ${profile.id}: rootfs missing or unreadable: ${rootfs ?? "(unset)"}`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("[verify-firecracker-assets] Missing assets:\n" + failures.join("\n"));
    console.error(
      "\nBuild vmlinux + rootfs (see docs/custom-headless-shell-build.md and scripts/bench/build-firecracker-rootfs-variants.sh).",
    );
    process.exit(1);
  }

  if (requestedRaw.trim()) {
    try {
      assertCustomChromiumHostPrerequisitesIfNeeded(ACTIVE_BENCHMARK_PROFILES.map((p) => p.id));
    } catch (error) {
      console.error("[verify-firecracker-assets] Custom Chromium host preflight failed.");
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }

  const fcProfiles = ACTIVE_BENCHMARK_PROFILES.filter((p) => p.mode === "firecracker");
  if (fcProfiles.length === 0 && requestedRaw.trim()) {
    console.warn(
      "[verify-firecracker-assets] No Firecracker profiles in BENCH_PROFILE_IDS; nothing to verify.",
    );
    return;
  }

  console.log(
    `[verify-firecracker-assets] OK: ${fcProfiles.length} Firecracker profile(s) have kernel and rootfs on disk.`,
  );
}

main();
