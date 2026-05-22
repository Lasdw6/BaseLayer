#!/usr/bin/env node
/**
 * Guardrail: benchmark hosts should disable network-slot validation and egress probes by default
 * (see aws-custom-lanes-session-2026-04-18). provider-api must emit phase summaries for A/B.
 * Exit 1 if invariants break. CI: npm run bench:verify-defaults
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

const failures = [];

function mustMatch(rel, label, pattern) {
  const s = read(rel);
  if (!pattern.test(s)) {
    failures.push(`${rel}: expected ${label}`);
  }
}

mustMatch(
  "scripts/bench/start-baselayer-baremetal.sh",
  "FIRECRACKER_NETWORK_SLOT_VALIDATE_ON_CLAIM default :-0",
  /FIRECRACKER_NETWORK_SLOT_VALIDATE_ON_CLAIM="\$\{FIRECRACKER_NETWORK_SLOT_VALIDATE_ON_CLAIM:-0\}"/,
);
mustMatch(
  "scripts/bench/start-baselayer-baremetal.sh",
  "FIRECRACKER_NETWORK_SLOT_EGRESS_PROBE_ON_CLAIM default :-0",
  /FIRECRACKER_NETWORK_SLOT_EGRESS_PROBE_ON_CLAIM="\$\{FIRECRACKER_NETWORK_SLOT_EGRESS_PROBE_ON_CLAIM:-0\}"/,
);
mustMatch(
  "scripts/bench/run-baremetal-provider-matrix.sh",
  "slot validate default :-0",
  /FIRECRACKER_NETWORK_SLOT_VALIDATE_ON_CLAIM="\$\{FIRECRACKER_NETWORK_SLOT_VALIDATE_ON_CLAIM:-0\}"/,
);
mustMatch(
  "scripts/bench/run-baremetal-provider-matrix.sh",
  "egress probe default :-0",
  /FIRECRACKER_NETWORK_SLOT_EGRESS_PROBE_ON_CLAIM="\$\{FIRECRACKER_NETWORK_SLOT_EGRESS_PROBE_ON_CLAIM:-0\}"/,
);

const providerApi = read("src/bench/provider-api.ts");
if (!providerApi.includes("phaseSummaryP50")) {
  failures.push("src/bench/provider-api.ts: missing phaseSummaryP50");
}
if (!providerApi.includes("navigationBreakdownP50")) {
  failures.push("src/bench/provider-api.ts: missing navigationBreakdownP50");
}

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`verify-benchmark-host-defaults: ${f}`);
  }
  process.exit(1);
}

console.log("verify-benchmark-host-defaults: ok");
