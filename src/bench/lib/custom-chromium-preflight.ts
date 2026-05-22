/**
 * Host prerequisites for Firecracker profiles that use a custom-built
 * headless shell (custom rootfs .ext4 images). Fails fast on AWS/lab hosts
 * before long matrix runs when neither a Chromium checkout nor a prebuilt
 * binary + runtime blobs is available.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { getSupportedProfile } from "./profiles.js";
import { type SupportedProfileId } from "./types.js";

/** Profiles whose guest image is built from FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM. */
export const CUSTOM_SHELL_BENCHMARK_PROFILE_IDS: readonly SupportedProfileId[] = [
  "BaseLayer-Staryu-custom-shell-startup-network",
  "BaseLayer-Starmie-async-custom-shell-merge",
  "BaseLayer-Abra-custom-shell-baseline",
  "BaseLayer-Kadabra-custom-shell-startup-prune",
  "BaseLayer-Alakazam-custom-shell-async-manual",
  "BaseLayer-Ditto-custom-shell-kernel-balanced",
];

const CUSTOM_SHELL_SET = new Set<string>(CUSTOM_SHELL_BENCHMARK_PROFILE_IDS);

export function profileNeedsCustomChromiumHost(profileId: string): boolean {
  return CUSTOM_SHELL_SET.has(profileId);
}

/**
 * Enforce host checkout / prebuilt-binary checks only when the operator
 * explicitly requested a custom-shell profile via BENCH_PROFILE_IDS. Full
 * multi-profile runs without BENCH_PROFILE_IDS skip this so local Mew-only
 * work does not require a Chromium tree.
 */
export function shouldEnforceCustomChromiumPreflight(profileId: string): boolean {
  if (process.env["BASELAYER_SKIP_CUSTOM_CHROMIUM_PREFLIGHT"] === "1") {
    return false;
  }
  if (!profileNeedsCustomChromiumHost(profileId)) {
    return false;
  }
  const raw = process.env["BENCH_PROFILE_IDS"]?.trim();
  if (!raw) {
    return false;
  }
  for (const token of raw.split(",")) {
    const t = token.trim();
    if (!t) {
      continue;
    }
    try {
      if (getSupportedProfile(t).id === profileId) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function hasAnyPak(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((name) => name.endsWith(".pak"));
  } catch {
    return false;
  }
}

/** Matches rootfs `resolve_browser_assets` / Playwright minimal layout. */
function chromiumRuntimeLayoutComplete(dir: string): boolean {
  const icu = path.join(dir, "icudtl.dat");
  const snap = path.join(dir, "snapshot_blob.bin");
  const v8snap = path.join(dir, "v8_context_snapshot.bin");
  if (fs.existsSync(icu) && fs.existsSync(snap) && fs.existsSync(v8snap) && hasAnyPak(dir)) {
    return true;
  }
  const headlessBin = path.join(dir, "chrome-headless-shell");
  const pakA = path.join(dir, "headless_lib_data.pak");
  const pakB = path.join(dir, "headless_command_resources.pak");
  if (
    fs.existsSync(headlessBin) &&
    fs.existsSync(pakA) &&
    fs.existsSync(pakB) &&
    hasAnyPak(dir)
  ) {
    return true;
  }
  return false;
}

/**
 * Resolve directory that holds Chromium runtime blobs for a built binary
 * (same rules as `build-custom-headless-shell.sh` / rootfs builder).
 */
export function resolveChromiumRuntimeDir(binaryPath: string): { dir: string; ok: boolean } {
  const abs = path.resolve(binaryPath);
  let dir = path.dirname(abs);
  if (chromiumRuntimeLayoutComplete(dir)) {
    return { dir, ok: true };
  }
  const parent = path.dirname(dir);
  if (parent !== dir && chromiumRuntimeLayoutComplete(parent)) {
    return { dir: parent, ok: true };
  }
  return { dir, ok: false };
}

function commandOnPath(name: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", `command -v "${name.replace(/"/g, '\\"')}" >/dev/null 2>&1`]);
    return true;
  } catch {
    return false;
  }
}

function isExecutableFile(filePath: string): boolean {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) {
      return false;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function chromiumSrcTreeReady(srcDir: string): boolean {
  const buildGn = path.join(srcDir, "BUILD.gn");
  try {
    return fs.statSync(srcDir).isDirectory() && fs.existsSync(buildGn);
  } catch {
    return false;
  }
}

const CUSTOM_CHROMIUM_HELP =
  "Custom Chromium / custom-shell profiles are in BENCH_PROFILE_IDS but this host has no usable Chromium build inputs.\n" +
  "Provide one of:\n" +
  "  • BASELAYER_CHROMIUM_SRC_DIR=<path to Chromium src> with BUILD.gn, and put depot_tools on PATH so `gn` and `autoninja` exist; or\n" +
  "  • FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM=<path to headless_shell or chrome-headless-shell> with runtime files beside it (or in the parent out/ dir):\n" +
  "      icudtl.dat, snapshot_blob.bin, v8_context_snapshot.bin, and at least one .pak\n" +
  "    (Playwright-style trees: chrome-headless-shell + headless_lib_data.pak + headless_command_resources.pak + *.pak.)\n" +
  "Then build rootfs images (see scripts/bench/build-firecracker-rootfs-variants.sh custom block) before benchmarking.\n" +
  "Set BASELAYER_SKIP_CUSTOM_CHROMIUM_PREFLIGHT=1 only to bypass this check (not recommended on paid hosts).";

/**
 * When any requested profile needs a custom shell image, require either:
 * - `BASELAYER_CHROMIUM_SRC_DIR` → Chromium checkout with BUILD.gn, plus `gn` and `autoninja` on PATH; or
 * - `FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM` → executable binary with runtime resources (full or Playwright-minimal layout).
 */
export function assertCustomChromiumHostPrerequisitesIfNeeded(profileIds: readonly string[]): void {
  if (process.env["BASELAYER_SKIP_CUSTOM_CHROMIUM_PREFLIGHT"] === "1") {
    return;
  }

  const needs = profileIds.some((id) => profileNeedsCustomChromiumHost(id));
  if (!needs) {
    return;
  }

  const srcRaw = process.env["BASELAYER_CHROMIUM_SRC_DIR"]?.trim() ?? "";
  const binRaw = process.env["FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM"]?.trim() ?? "";

  const srcTreeOk = srcRaw.length > 0 && chromiumSrcTreeReady(srcRaw);
  const binExecOk = binRaw.length > 0 && isExecutableFile(binRaw);
  const binResourcesOk = binExecOk && resolveChromiumRuntimeDir(binRaw).ok;

  if (srcTreeOk) {
    if (!commandOnPath("gn") || !commandOnPath("autoninja")) {
      throw new Error(
        `BASELAYER_CHROMIUM_SRC_DIR is set (${srcRaw}) but 'gn' and/or 'autoninja' were not found on PATH. ` +
          "Add depot_tools to PATH before building, or set FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM to a prebuilt binary with runtime resources.",
      );
    }
    return;
  }

  if (binResourcesOk) {
    return;
  }

  if (binRaw.length > 0 && !binExecOk) {
    throw new Error(
      `FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM is set (${binRaw}) but is not an executable file.`,
    );
  }

  if (binRaw.length > 0 && binExecOk && !resolveChromiumRuntimeDir(binRaw).ok) {
    const { dir } = resolveChromiumRuntimeDir(binRaw);
    throw new Error(
      `FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM points to ${binRaw} but Chromium runtime resources were not found next to it or under the parent of the binary (${dir}). ` +
        "Expected icudtl.dat + snapshot_blob.bin + v8_context_snapshot.bin + *.pak, or a Playwright-style chrome-headless-shell + headless *.pak set.",
    );
  }

  if (srcRaw.length > 0 && !srcTreeOk) {
    throw new Error(
      `BASELAYER_CHROMIUM_SRC_DIR (${srcRaw}) is not a Chromium source tree (missing BUILD.gn).`,
    );
  }

  throw new Error(CUSTOM_CHROMIUM_HELP);
}
