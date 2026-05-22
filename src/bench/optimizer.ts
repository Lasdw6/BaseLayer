import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type BenchmarkKind = "latency" | "density";
type CandidateStatus = "planned" | "completed" | "failed" | "skipped";

interface OptimizerCandidate {
  id: string;
  description: string;
  env: Record<string, string>;
}

interface CandidateResult {
  candidate: OptimizerCandidate;
  status: CandidateStatus;
  score: number | null;
  reason: string;
  outputPath?: string;
  metrics?: Record<string, unknown>;
}

interface OptimizerReport {
  benchmark: BenchmarkKind;
  model: string;
  dryRun: boolean;
  generatedAt: string;
  outputDir: string;
  candidates: OptimizerCandidate[];
  results: CandidateResult[];
}

const benchmark = parseBenchmarkKind(process.env["BENCH_OPTIMIZER_BENCHMARK"] ?? "latency");
const model = process.env["BENCH_OPTIMIZER_MODEL"] ?? process.env["OPENAI_MODEL"] ?? "gpt-5.4";
const dryRun = process.env["BENCH_OPTIMIZER_RUN"] !== "1";
const maxCandidates = parsePositiveInt(process.env["BENCH_OPTIMIZER_MAX_CANDIDATES"], 24);
const outputDir =
  process.env["BENCH_OPTIMIZER_OUTPUT_DIR"] ??
  path.join(
    process.cwd(),
    "data",
    "benchmarks",
    `optimizer-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );

const safeSeedCandidates: OptimizerCandidate[] = [
  {
    id: "baseline-c-1vcpu-1024",
    description: "Current density default: headless-shell snapshot, 1 vCPU, 1024 MB, async delete.",
    env: {
      BENCH_PROFILE_IDS: "baselayer-firecracker-headless-shell",
      BENCH_FIRECRACKER_GUEST_VCPU_COUNT: "1",
      BENCH_FIRECRACKER_GUEST_MEMORY_MB: "1024",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "baseline-c-1536mb",
    description: "Raise guest memory to check whether RAM reduces goto tail without adding too much launch pressure.",
    env: {
      BENCH_PROFILE_IDS: "baselayer-firecracker-headless-shell",
      BENCH_FIRECRACKER_GUEST_VCPU_COUNT: "1",
      BENCH_FIRECRACKER_GUEST_MEMORY_MB: "1536",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "baseline-c-active-nav-cap-16",
    description: "Cap active navigation to reduce host run-queue pressure at density.",
    env: {
      BENCH_PROFILE_IDS: "baselayer-firecracker-headless-shell",
      BENCH_FIRECRACKER_GUEST_VCPU_COUNT: "1",
      BENCH_FIRECRACKER_GUEST_MEMORY_MB: "1024",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      FIRECRACKER_MAX_CONCURRENT_ACTIVE_NAVIGATION: "16",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "fluid-r-hybrid-renice-only",
    description: "Fluid hybrid policy without cgroups; tests renice/taskset behavior only.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Pidgeotto-fluid-hybrid",
      BENCH_FIRECRACKER_GUEST_VCPU_COUNT: "1",
      BENCH_FIRECRACKER_GUEST_MEMORY_MB: "1024",
      FIRECRACKER_DYNAMIC_CPU_POLICY: "1",
      FIRECRACKER_DYNAMIC_CPU_MODE: "hybrid",
      FIRECRACKER_DYNAMIC_CPU_CGROUPS: "0",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "fluid-s-always-renice-only",
    description: "Fluid always policy without cgroups; expected to be worse unless active sessions are bursty.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Pidgeot-fluid-always",
      BENCH_FIRECRACKER_GUEST_VCPU_COUNT: "1",
      BENCH_FIRECRACKER_GUEST_MEMORY_MB: "1024",
      FIRECRACKER_DYNAMIC_CPU_POLICY: "1",
      FIRECRACKER_DYNAMIC_CPU_MODE: "always",
      FIRECRACKER_DYNAMIC_CPU_CGROUPS: "0",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "fluid-z-density-1024",
    description: "Density-oriented fluid profile with memory raised to avoid known 512 MB Chrome OOM.",
    env: {
      BENCH_PROFILE_IDS: "baselayer-firecracker-fluid-density",
      BENCH_FCFLUIDDENSE_GUEST_MEMORY_MB: "1024",
      FIRECRACKER_DYNAMIC_CPU_POLICY: "1",
      FIRECRACKER_DYNAMIC_CPU_MODE: "hybrid",
      FIRECRACKER_DYNAMIC_CPU_CGROUPS: "0",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "density-navcap-12",
    description: "Dedicated profile BA: density snapshot + active-navigation cap 12.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Fearow-density-navcap-12",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "density-navcap-16-profile-bb",
    description: "Dedicated profile BB: density snapshot + active-navigation cap 16.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Ekans-density-navcap-16",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "density-navcap-20",
    description: "Dedicated profile BC: density snapshot + active-navigation cap 20.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Arbok-density-navcap-20",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "density-mem1536-profile-bd",
    description: "Dedicated profile BD: 1536 MB guest RAM on density snapshot (goto tail vs density).",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Pikachu-density-mem1536",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "density-mem1280-profile-bi",
    description: "Dedicated profile BI: 1280 MB guest RAM on density snapshot.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Raichu-density-mem1280",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "density-mem1792-profile-bj",
    description: "Dedicated profile BJ: 1792 MB guest RAM on density snapshot.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Sandshrew-density-mem1792",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "density-mem2048-profile-bk",
    description: "Dedicated profile BK: 2048 MB guest RAM on density snapshot.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Sandslash-density-mem2048",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "density-navcap16-mem1536",
    description: "Dedicated profile BE: nav cap 16 + 1536 MB RAM.",
    env: {
      BENCH_PROFILE_IDS: "baselayer-firecracker-headless-shell-navcap16-mem1536",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "density-navcap16-mem2048",
    description: "Dedicated profile BL: nav cap 16 + 2048 MB RAM.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Nidorina-density-navcap16-mem2048",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "fluid-density-navcap-16",
    description: "Dedicated profile BF: fluid hybrid density + nav cap 16.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Nidoqueen-fluid-density-navcap-16",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "fluid-density-cgroups",
    description: "Dedicated profile BG: fluid hybrid with cgroups (cpu.weight path); use on fixed hosts only.",
    env: {
      BENCH_PROFILE_IDS: "baselayer-firecracker-fluid-cgroups",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "density-launch-cap-12",
    description: "Dedicated profile BH: stagger launches (launch concurrency 12) on density snapshot.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Nidorino-density-launch-cap-12",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "density-navcap-8-profile-bm",
    description: "Dedicated profile BM: strict nav cap 8 to test lower simultaneous Google renderer pressure.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Nidoking-density-navcap-8",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "2vcpu-navcap-12-profile-bn",
    description: "Dedicated profile BN: 2 vCPU guests with active-navigation cap 12.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Clefairy-2vcpu-navcap-12",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "2vcpu-navcap-16-profile-bo",
    description: "Dedicated profile BO: 2 vCPU guests with active-navigation cap 16.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Clefable-2vcpu-navcap-16",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "density-cdp-warm-profile-bp",
    description: "Dedicated profile BP: 1 vCPU CDP-only warm snapshot.",
    env: {
      BENCH_PROFILE_IDS: "baselayer-firecracker-headless-shell-cdp-warm-density",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "density-context-warm-profile-bq",
    description: "Dedicated profile BQ: 1 vCPU context-warm snapshot.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Ninetales-density-context-warm",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "density-target-warm-profile-br",
    description: "Dedicated profile BR: 1 vCPU target-only warm snapshot.",
    env: {
      BENCH_PROFILE_IDS: "baselayer-firecracker-headless-shell-target-warm-density",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "density-blank-warm-profile-bs",
    description: "Dedicated profile BS: 1 vCPU blank-page warm snapshot.",
    env: {
      BENCH_PROFILE_IDS: "baselayer-firecracker-headless-shell-blank-warm-density",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "density-cdp-warm-nav8-profile-bt",
    description: "Dedicated profile BT: 1 vCPU CDP-warm snapshot with nav cap 8.",
    env: {
      BENCH_PROFILE_IDS: "baselayer-firecracker-headless-shell-cdp-warm-navcap-8",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "kernel-goto-profile-bu",
    description: "Dedicated profile BU: Kernel-inspired guest Chromium flags on the 1 vCPU density lane.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Oddish-kernel-goto",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "kernel-goto-lite-profile-bx",
    description: "Dedicated profile BX: narrower Kernel-inspired guest Chromium flag subset on the 1 vCPU density lane.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Gloom-kernel-goto-lite",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "kernel-feature-prune-profile-by",
    description: "Dedicated profile BY: larger Kernel-derived disable-features bundle without the broader startup bundle.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Vileplume-kernel-feature-prune",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "kernel-startup-prune-profile-bz",
    description: "Dedicated profile BZ: Kernel-style startup/service pruning with baseline-like feature flags.",
    env: {
      BENCH_PROFILE_IDS: "baselayer-firecracker-headless-shell-startup-prune",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "kernel-goto-ipv6off-profile-bv",
    description: "Dedicated profile BV: Kernel-inspired guest Chromium flags plus guest IPv6 disabled.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Paras-kernel-goto-ipv6off",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "kernel-balanced-profile-ca",
    description: "Dedicated profile CA: balanced Kernel-style startup pruning plus a curated disable-features bundle.",
    env: {
      BENCH_PROFILE_IDS: "baselayer-firecracker-headless-shell-kernel-balanced",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "kernel-startup-prune-lite-profile-cb",
    description: "Dedicated profile CB: tighter startup/service pruning after Gengar.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Krabby-kernel-startup-prune-lite",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "kernel-balanced-lite-profile-cc",
    description: "Dedicated profile CC: tighter balanced Kernel bundle after Dragonite.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Kingler-kernel-balanced-lite",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "async-gengar-merge-profile-cd",
    description: "Dedicated profile CD: async-parity candidate merging Mew semantics with Gengar startup-prune rootfs.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Horsea-async-gengar-merge",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "async-dragonite-merge-profile-ce",
    description: "Dedicated profile CE: async-parity candidate merging Mew semantics with Dragonite balanced rootfs.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Seadra-async-dragonite-merge",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "async-gloom-merge-profile-cf",
    description: "Dedicated profile CF: async-parity candidate merging Mew semantics with Gloom goto-lite rootfs.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Goldeen-async-gloom-merge",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "async-manual-gengar-profile-ci",
    description: "Dedicated profile CI: manual async-parity integration using a curated Gengar-style rootfs.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Poliwag-async-manual-gengar",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "async-manual-dragonite-profile-cj",
    description: "Dedicated profile CJ: manual async-parity integration using a curated Dragonite-style rootfs.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Poliwhirl-async-manual-dragonite",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "custom-shell-startup-network-profile-cg",
    description: "Dedicated profile CG: custom-built headless-shell baseline lane for build-level startup/network experiments.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Staryu-custom-shell-startup-network",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "custom-shell-baseline-profile-ck",
    description: "Dedicated profile CK: custom-built headless-shell baseline alias lane.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Abra-custom-shell-baseline",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "custom-shell-startup-prune-profile-cl",
    description: "Dedicated profile CL: custom-built headless-shell lane using startup-prune launch profile.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Kadabra-custom-shell-startup-prune",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "async-custom-shell-merge-profile-ch",
    description: "Dedicated profile CH: async-parity candidate using the custom headless-shell async-manual rootfs.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Starmie-async-custom-shell-merge",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "custom-shell-async-manual-profile-cm",
    description: "Dedicated profile CM: custom-built headless-shell lane using the manual async-parity rootfs.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Alakazam-custom-shell-async-manual",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
  {
    id: "kernel-goto-cdp-warm-profile-bw",
    description: "Dedicated profile BW: Kernel-inspired guest Chromium flags plus CDP-only warm snapshot.",
    env: {
      BENCH_PROFILE_IDS: "BaseLayer-Parasect-kernel-goto-cdp-warm",
      CONTROL_PLANE_ASYNC_SESSION_DELETE: "1",
      BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS: "1",
    },
  },
];

function parseBenchmarkKind(value: string): BenchmarkKind {
  return value === "density" ? "density" : "latency";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function candidateIsSafe(candidate: OptimizerCandidate): boolean {
  const waitUntil = candidate.env["BENCH_PAGE_GOTO_WAIT_UNTIL"];
  const blockImages = candidate.env["BENCH_GOTO_BLOCK_IMAGE_REQUESTS"];
  const memory =
    Number.parseInt(candidate.env["BENCH_FIRECRACKER_GUEST_MEMORY_MB"] ?? "", 10) ||
    Number.parseInt(candidate.env["BENCH_FCFLUIDDENSE_GUEST_MEMORY_MB"] ?? "", 10) ||
    Number.parseInt(candidate.env["BENCH_FCDENSE5121_GUEST_MEMORY_MB"] ?? "", 10) ||
    1024;

  return waitUntil !== "commit" && blockImages !== "1" && memory >= 768;
}

function normalizeCandidate(candidate: OptimizerCandidate, index: number): OptimizerCandidate {
  return {
    id: sanitizeId(candidate.id || `candidate-${index + 1}`),
    description: candidate.description || "Optimizer candidate",
    env: Object.fromEntries(
      Object.entries(candidate.env ?? {}).map(([key, value]) => [key, String(value)]),
    ),
  };
}

function sanitizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function loadCandidateFile(): Promise<OptimizerCandidate[] | null> {
  const candidatePath = process.env["BENCH_OPTIMIZER_CANDIDATES"];
  if (!candidatePath) {
    return null;
  }
  const raw = await readFile(candidatePath, "utf8");
  const parsed = JSON.parse(raw) as { candidates?: OptimizerCandidate[] } | OptimizerCandidate[];
  return Array.isArray(parsed) ? parsed : parsed.candidates ?? [];
}

async function llmCandidates(seedCandidates: OptimizerCandidate[]): Promise<OptimizerCandidate[]> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    return [];
  }

  const prompt = {
    task: "Suggest safe BaseLayer benchmark optimizer candidates.",
    benchmark,
    constraints: [
      "Return JSON only with shape {\"candidates\":[{\"id\":\"...\",\"description\":\"...\",\"env\":{\"KEY\":\"VALUE\"}}]}",
      "Do not use BENCH_PAGE_GOTO_WAIT_UNTIL=commit.",
      "Do not use BENCH_GOTO_BLOCK_IMAGE_REQUESTS=1 for BrowserArena parity.",
      "Do not set Firecracker guest memory below 768 MB.",
      "Prefer total lifecycle and success rate over page_goto_ms alone.",
      "Keep BENCH_FIRECRACKER_ENABLE_INTERNET_EGRESS=1 for external-site runs.",
      "Use cgroups disabled until the cpu.weight write-path bug is fixed.",
    ],
    seedCandidates,
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content:
            "You are a benchmark optimizer for BaseLayer. Output compact JSON only. No markdown.",
        },
        {
          role: "user",
          content: JSON.stringify(prompt),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI candidate generation failed: ${response.status} ${errorBody}`);
  }

  const body = (await response.json()) as {
    output_text?: string;
    output?: Array<{
      content?: Array<{ text?: string }>;
    }>;
  };
  const text =
    body.output_text ??
    body.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text ?? "")
      .join("") ??
    "";
  const parsed = JSON.parse(text) as { candidates?: OptimizerCandidate[] };
  return parsed.candidates ?? [];
}

async function getCandidates(): Promise<OptimizerCandidate[]> {
  const fileCandidates = await loadCandidateFile();
  const seeds = fileCandidates && fileCandidates.length > 0 ? fileCandidates : safeSeedCandidates;
  let llmGenerated: OptimizerCandidate[] = [];
  if (process.env["BENCH_OPTIMIZER_USE_LLM"] === "1") {
    try {
      llmGenerated = await llmCandidates(seeds);
    } catch (error) {
      console.error(String(error instanceof Error ? error.message : error));
    }
  }

  const byId = new Map<string, OptimizerCandidate>();
  for (const candidate of [...seeds, ...llmGenerated].map(normalizeCandidate)) {
    if (candidateIsSafe(candidate)) {
      byId.set(candidate.id, candidate);
    }
  }
  return [...byId.values()].slice(0, maxCandidates);
}

async function runCandidate(candidate: OptimizerCandidate): Promise<CandidateResult> {
  const candidateDir = path.join(outputDir, candidate.id);
  await mkdir(candidateDir, { recursive: true });
  await writeFile(
    path.join(candidateDir, "config.json"),
    JSON.stringify({ candidate, benchmark }, null, 2),
  );

  if (dryRun) {
    return {
      candidate,
      status: "planned",
      score: null,
      reason: "Dry run; set BENCH_OPTIMIZER_RUN=1 to execute benchmarks.",
      outputPath: candidateDir,
    };
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...candidate.env,
    BENCH_ITERATIONS: process.env["BENCH_ITERATIONS"] ?? "5",
    BENCH_WARMUP_ITERATIONS: process.env["BENCH_WARMUP_ITERATIONS"] ?? "3",
    BENCH_REPORT_DIR: process.env["BENCH_REPORT_DIR"] ?? candidateDir,
  };
  if (benchmark === "density") {
    env["BENCH_CONCURRENCY_VALUES"] ??= process.env["BENCH_CONCURRENCY_VALUES"] ?? "1,4";
    env["BENCH_SOAK_SECONDS"] ??= process.env["BENCH_SOAK_SECONDS"] ?? "10";
  }

  try {
    const { stdout, stderr } = await execFileAsync("npm", ["run", `bench:${benchmark}`], {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: parsePositiveInt(process.env["BENCH_OPTIMIZER_TIMEOUT_MS"], 15 * 60 * 1000),
    });
    await writeFile(path.join(candidateDir, "stdout.log"), stdout);
    await writeFile(path.join(candidateDir, "stderr.log"), stderr);
    const parsed = parseJsonFromStdout(stdout);
    await writeFile(path.join(candidateDir, "summary.json"), JSON.stringify(parsed, null, 2));
    const scored = scoreBenchmark(parsed);
    return {
      candidate,
      status: "completed",
      score: scored.score,
      reason: scored.reason,
      outputPath: candidateDir,
      metrics: scored.metrics,
    };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    await writeFile(path.join(candidateDir, "error.log"), message);
    return {
      candidate,
      status: "failed",
      score: Number.POSITIVE_INFINITY,
      reason: message,
      outputPath: candidateDir,
    };
  }
}

function parseJsonFromStdout(stdout: string): unknown {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("Benchmark stdout did not contain a JSON object.");
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

function scoreBenchmark(parsed: unknown): {
  score: number;
  reason: string;
  metrics: Record<string, unknown>;
} {
  const report = parsed as {
    results?: Array<{
      successRate?: number;
      total_ms?: { p50?: number; p95?: number; avg?: number };
      browserarena_latency_ms?: { p50?: number; p95?: number; avg?: number };
      maxStableConcurrency?: number;
      levels?: Array<{
        requestedConcurrency?: number;
        navigationSuccessRate?: number;
        createSuccessRate?: number;
        avgCreateMs?: number;
        avgNavigateMs?: number;
        p95PageGotoMs?: number;
        soakActionFailures?: number;
        peakCpuUtilizationPct?: number;
        peakMemoryPressurePct?: number;
      }>;
    }>;
  };
  const first = report.results?.[0];
  if (!first) {
    return {
      score: Number.POSITIVE_INFINITY,
      reason: "No benchmark results found.",
      metrics: {},
    };
  }

  if (benchmark === "latency") {
    const lifecycle = first.browserarena_latency_ms ?? first.total_ms;
    const p50 = lifecycle?.p50 ?? lifecycle?.avg ?? Number.POSITIVE_INFINITY;
    const p95 = lifecycle?.p95 ?? p50;
    const successRate = first.successRate ?? 0;
    const failurePenalty = (1 - successRate) * 100_000;
    return {
      score: p50 + 0.5 * p95 + failurePenalty,
      reason: `latency score = p50 + 0.5*p95 + failurePenalty; successRate=${successRate}`,
      metrics: { p50, p95, successRate },
    };
  }

  const levels = first.levels ?? [];
  const worstLevel = levels[levels.length - 1];
  const navSuccess = worstLevel?.navigationSuccessRate ?? 0;
  const createSuccess = worstLevel?.createSuccessRate ?? 0;
  const avgNavigateMs = worstLevel?.avgNavigateMs ?? Number.POSITIVE_INFINITY;
  const p95PageGotoMs = worstLevel?.p95PageGotoMs ?? avgNavigateMs;
  const soakFailures = worstLevel?.soakActionFailures ?? 0;
  const stableConcurrency = first.maxStableConcurrency ?? 0;
  const failurePenalty = (2 - navSuccess - createSuccess) * 100_000 + soakFailures * 2_000;
  return {
    score: avgNavigateMs + 0.5 * p95PageGotoMs - stableConcurrency * 1_000 + failurePenalty,
    reason:
      "density score = avgNavigate + 0.5*p95Goto - stableConcurrency*1000 + failure/soak penalties",
    metrics: {
      requestedConcurrency: worstLevel?.requestedConcurrency,
      navSuccess,
      createSuccess,
      avgNavigateMs,
      p95PageGotoMs,
      soakFailures,
      stableConcurrency,
      peakCpuUtilizationPct: worstLevel?.peakCpuUtilizationPct,
      peakMemoryPressurePct: worstLevel?.peakMemoryPressurePct,
    },
  };
}

await mkdir(outputDir, { recursive: true });
const candidates = await getCandidates();
const results: CandidateResult[] = [];
for (const candidate of candidates) {
  results.push(await runCandidate(candidate));
}

results.sort((left, right) => {
  const leftScore = left.score ?? Number.POSITIVE_INFINITY;
  const rightScore = right.score ?? Number.POSITIVE_INFINITY;
  return leftScore - rightScore;
});

const report: OptimizerReport = {
  benchmark,
  model,
  dryRun,
  generatedAt: new Date().toISOString(),
  outputDir,
  candidates,
  results,
};
await writeFile(path.join(outputDir, "optimizer-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
