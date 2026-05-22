# Benchmarks

The repo now includes a benchmark suite for the browser-worker profiles described in
[`provider-target-and-benchmark-plan.md`](./provider-target-and-benchmark-plan.md).

Public profile IDs follow [profile-naming-system.md](./profile-naming-system.md). Legacy `BaseLayer-<codename>-...` and `profile-*` IDs still resolve as compatibility aliases, but new commands and docs should prefer descriptive IDs such as `baselayer-firecracker-headless-shell`.

## Supported Profiles

These profiles are executable in the current repo:

- `BaseLayer-Bulbasaur-generic-container`
  - baseline mode
  - generic container-worker reference
- `BaseLayer-Charizard-managed-node`
  - managed mode
  - browser-aware node-agent reference
- `baselayer-firecracker-headless-shell`
  - firecracker mode
  - Linux/KVM-only snapshot-restore proof/integration profile
- `BaseLayer-Ivysaur-firecracker-vanilla`
  - firecracker mode
  - minimally configured Chrome snapshot comparison profile
- `BaseLayer-Venusaur-managed-cold-node`
  - managed mode
  - warm-pool-disabled cold burst profile
- `BaseLayer-Squirtle-managed-dense-384mb`
  - managed mode
  - tighter memory and renderer-budget density profile
- `BaseLayer-Wartortle-managed-large-shm`
  - managed mode
  - compatibility profile with larger `/dev/shm`
- `baselayer-firecracker-headless-shell-512mb`
  - firecracker mode
  - 512MB hardened-tier memory experiment
- `baselayer-firecracker-headless-shell-384mb`
  - firecracker mode
  - 384MB lower-bound memory experiment
- `baselayer-firecracker-headless-shell-1vcpu`
  - firecracker mode
  - one-vCPU packing experiment
- `baselayer-firecracker-headless-shell-cdp-warm`
  - firecracker mode
  - CDP-ready snapshot warm-level control
- `baselayer-firecracker-headless-shell-context-warm`
  - firecracker mode
  - warmed-context snapshot experiment
- `baselayer-firecracker-headless-shell-no-warm`
  - firecracker mode
  - no warm-page snapshot control
- `baselayer-firecracker-full-chromium`
  - firecracker mode
  - full Chromium guest comparison
- `BaseLayer-Beedrill-full-chromium-512`
  - firecracker mode
  - full Chromium guest at 512MB
- `BaseLayer-Pidgey-network-validate`
  - firecracker mode
  - network-slot validation overhead profile
- `BaseLayer-Pidgeotto-fluid-hybrid`
  - firecracker mode
  - hybrid dynamic CPU policy profile
- `BaseLayer-Pidgeot-fluid-always`
  - firecracker mode
  - always-on dynamic CPU policy profile
- `BaseLayer-Rattata-fast-slot-reuse`
  - firecracker mode
  - skips helper cleanup grace on clean slots to test create-path overhead
- `baselayer-firecracker-headless-shell-density-512mb-1vcpu`
  - firecracker mode
  - 512MB/1vCPU density profile with fast slot reuse
- `baselayer-firecracker-fluid-density`
  - firecracker mode
  - 512MB/1vCPU density profile with hybrid fluid CPU policy
- `BaseLayer-Oddish-kernel-goto`
  - firecracker mode
  - kernel-inspired guest Chromium/headless-shell launch flags baked into a separate rootfs
- `BaseLayer-Gloom-kernel-goto-lite`
  - firecracker mode
  - narrower kernel-inspired guest launch flag subset baked into a separate rootfs
- `BaseLayer-Paras-kernel-goto-ipv6off`
  - firecracker mode
  - kernel-inspired guest launch flags plus guest IPv6 disabled
- `BaseLayer-Parasect-kernel-goto-cdp-warm`
  - firecracker mode
  - kernel-inspired guest launch flags plus CDP-only warm snapshot
- `BaseLayer-Krabby-kernel-startup-prune-lite`
  - firecracker mode
  - tighter follow-up to the Gengar startup/service-prune bundle
- `BaseLayer-Kingler-kernel-balanced-lite`
  - firecracker mode
  - tighter follow-up to the Dragonite balanced bundle
- `BaseLayer-Horsea-async-gengar-merge`
  - firecracker mode
  - async-parity merge candidate using the Gengar rootfs on the Mew runtime lane
- `BaseLayer-Seadra-async-dragonite-merge`
  - firecracker mode
  - async-parity merge candidate using the Dragonite rootfs on the Mew runtime lane
- `BaseLayer-Goldeen-async-gloom-merge`
  - firecracker mode
  - async-parity merge candidate using the Gloom rootfs on the Mew runtime lane
- `BaseLayer-Staryu-custom-shell-startup-network`
  - firecracker mode
  - custom-built `chrome-headless-shell` lane for build-level startup/network tests
- `BaseLayer-Starmie-async-custom-shell-merge`
  - firecracker mode
  - async-parity candidate using the custom-built headless-shell rootfs

These profiles are represented in the output but not yet executable:

- `BaseLayer-Venomoth-dedicated-vm`
- `BaseLayer-Diglett-paused-microvm-pool`
- `BaseLayer-Dugtrio-unikraft-standby`
- `BaseLayer-Meowth-lightpanda-runtime`
- `BaseLayer-Persian-managed-ksm-cow`

See [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) for the experiment matrix and copy-pasteable run commands.

## Benchmark Commands

Build first:

```powershell
npm run build
docker build -f Dockerfile.runtime -t baselayer-runtime:local .
```

Latency benchmark:

```powershell
$env:BENCH_ITERATIONS="5"
$env:BENCH_MIN_FREE_MEMORY_MB="256"
npm run bench:latency
```

Density benchmark:

```powershell
$env:BENCH_MAX_CONCURRENCY="6"
$env:BENCH_CONCURRENCY_STEP="1"
$env:BENCH_SUCCESS_THRESHOLD="1"
$env:BENCH_SOAK_SECONDS="10"
$env:BENCH_ACTIVE_SESSION_RATIO="0.5"
$env:BENCH_ACTIVE_ROUNDS_PER_SESSION="3"
$env:BENCH_ACTIVE_PAUSE_MS="500"
$env:BENCH_POST_WARMUP_SETTLE_MS="0"
$env:BENCH_MIN_FREE_MEMORY_MB="0"
npm run bench:density
```

Full matrix:

```powershell
$env:BENCH_ITERATIONS="5"
$env:BENCH_MAX_CONCURRENCY="4"
$env:BENCH_CONCURRENCY_STEP="1"
$env:BENCH_SUCCESS_THRESHOLD="1"
$env:BENCH_MIN_FREE_MEMORY_MB="256"
npm run bench:matrix
```

Firecracker profile in the shared harness:

```bash
export BENCH_ENABLE_FIRECRACKER="1"
export BENCH_PROFILE_IDS="baselayer-firecracker-headless-shell"
export FIRECRACKER_KERNEL_PATH="$PWD/artifacts/firecracker/vmlinux"
export FIRECRACKER_ROOTFS_PATH="$PWD/artifacts/firecracker/rootfs.ext4"
export FIRECRACKER_SNAPSHOT_DIR="$PWD/data/firecracker/snapshots"
npm run bench:latency
```

Firecracker proof on Linux/KVM:

```bash
./scripts/bench/bootstrap-firecracker-linux.sh
sudo ./scripts/firecracker/build-headless-shell-rootfs.sh
sudo -E npm run bench:firecracker-proof
```

Firecracker-backed node-agent mode behind the normal session API:

```bash
export BENCH_ENABLE_FIRECRACKER="1"
export BENCH_PROFILE_IDS="baselayer-firecracker-headless-shell"
export FIRECRACKER_KERNEL_PATH="$PWD/artifacts/firecracker/vmlinux"
export FIRECRACKER_ROOTFS_PATH="$PWD/artifacts/firecracker/rootfs.ext4"
export FIRECRACKER_SNAPSHOT_DIR="$PWD/data/firecracker/snapshots"
export FIRECRACKER_ALLOW_AUTO_SNAPSHOT="1"
npm run bench:latency
```

BrowserArena concurrent validation is run through the BrowserArena runner, not `bench:latency`:

```bash
BASELAYER_BASE_URL="http://<provider-host>:3000" \
npm run bench -- --provider=baselayer --benchmark=hello-browser --runs=100 --concurrency=16 \
  --out="results/hello-browser/baselayer/$(date -u +%F)/results.jsonl"
```

For provider `/v1` BrowserArena-comparable runs, use this progression:

1. `1`-run smoke
2. `5`-run validation
3. `100`-run measured pass only if the `5`-run is clean

Run the remote benchmark as a detached script and poll logs/results with short bounded `ssh-run` calls. Do not keep one attached SSH session open for the full run.

For async-delete provider runs, do not use the absolute minimum host shape for the `100`-run lane. A host with only `2` slots / `2` microVMs can still collapse late into:

- `503 No host is currently eligible for session admission`

even at sequential `c=1`, because teardown lags creation. Keep at least one spare slot beyond the active workload when promoting a provider path from smoke to `100`-run benchmarking.

Details for the GCP `n2-standard-12` replication plan: [browserarena-concurrent-gcp-plan.md](./browserarena-concurrent-gcp-plan.md).

Local Browserless reference:

```powershell
$env:BENCH_ITERATIONS="5"
$env:BENCH_MAX_CONCURRENCY="4"
$env:BROWSERLESS_CONCURRENT="4"
npm run bench:browserless-local
```

Legacy baseline-vs-managed latency comparison:

```powershell
$env:BENCH_ITERATIONS="5"
$env:BENCH_MIN_FREE_MEMORY_MB="256"
npm run bench:compare
```

## Output Shape

### `bench:latency`

Aligned with BrowserArena `hello-browser` stage names. Default navigation is `BENCH_BROWSERARENA_PAGE_URL` or `https://example.com/` with Playwright `page.goto` `waitUntil: domcontentloaded` (set `BENCH_PAGE_GOTO_WAIT_UNTIL` to override). Set `BENCH_BROWSERARENA_PAGE_URL=https://google.com/` only when reproducing the historical Google-era rows. Set `BENCH_USE_LOCAL_BENCH_SITE=1` to use the in-repo HTTP bench page instead.

`session_release_ms` measures the public API release response. BaseLayer intentionally returns release after marking the session terminated and starts node-agent teardown asynchronously, so this metric should stay close to control-plane response latency rather than full VM cleanup time. If it jumps into hundreds or thousands of milliseconds, the delete path has likely regressed back to synchronous teardown.

`browserarena_latency_ms` mirrors the BrowserArena leaderboard latency aggregation: stage medians summed as `session_creation_ms + session_connect_ms + page_goto_ms + session_release_ms`.

Reports per-profile:

- per-iteration `session_creation_ms`, `session_connect_ms`, `page_goto_ms`, `session_release_ms`, `total_ms`
- `avg` / `p50` / `p95` for each of those metrics and `browserarena_latency_ms`
- `successRate`

### `bench:density`

Reports per-profile:

- `requestedConcurrency`
- `sessionCreateSuccesses`
- `navigationSuccesses`
- `createSuccessRate`
- `navigationSuccessRate`
- `avgCreateMs`
- `avgNavigateMs`
- `avgPageGotoMs`
- `p50PageGotoMs`
- `p95PageGotoMs`
- `avgLifecycleMs` (`avgCreateMs + avgSessionConnectMs + avgNavigateMs`)
- `avgCreateConnectGotoMs` (`avgCreateMs + avgSessionConnectMs + avgPageGotoMs`)
- `avgNavigationQueueWaitMs`
- `p95NavigationQueueWaitMs`
- `avgConnectQueueWaitMs`
- `p95ConnectQueueWaitMs`
- `avgDeleteMs`
- `p95DeleteMs`
- `avgLifecycleWithDeleteMs`
- `avgCreateConnectGotoDeleteMs`
- `avgSessionConnectMs`
- `p50SessionConnectMs`
- `p95SessionConnectMs`
- `soakSeconds`
- `activeSessionCount`
- `idleSessionCount`
- `soakActionSuccesses`
- `soakActionFailures`
- `hostStatus`
- `hostActiveSessions`
- `hostActiveRendererCount`
- `hostTrackedMemoryMb`
- `hostTrackedShmUsedMb`
- `crashCount5m`
- `reportPath`

`maxStableConcurrency` is the highest concurrency level whose create and navigation success rates both meet `BENCH_SUCCESS_THRESHOLD`.

Each density level also writes a JSON artifact under `data/benchmarks` by default. Each artifact includes:

- per-create outcomes
- per-session soak outcomes
- a host snapshot captured during the level
- session snapshots including per-session memory, renderer, and `/dev/shm` metrics

For Firecracker runs, the density harness waits for the agent to return to idle after warmup by default. Set `BENCH_WAIT_FOR_WARMUP_IDLE=0` only for a deliberate cleanup-race experiment. `BENCH_POST_WARMUP_SETTLE_MS` is still available when a timed delay is needed before the measured create burst.

For active-navigation experiments, set `BENCH_NAVIGATION_CONCURRENCY=<n>` to queue benchmark `page.goto` calls through a semaphore. If unset, Firecracker profiles with `FIRECRACKER_MAX_CONCURRENT_ACTIVE_NAVIGATION` use that value as the benchmark-side navigation semaphore. This makes nav-cap profiles measure queue delay explicitly instead of only changing host admission.

Set `BENCH_STAGED_NAVIGATION=1` to make density sessions connect first, wait for the wave to be ready, and then start first navigation together. This separates create/connect pressure from first-goto pressure. `BENCH_STAGED_NAVIGATION_TIMEOUT_MS` controls the maximum wait for every session to reach the navigation gate.

Set `BENCH_CONNECT_CONCURRENCY=<n>` to queue `connectOverCDP` calls. Use this when staged-navigation runs show CDP socket hangups or `ECONNRESET` during the connect wave.

### `bench:provider-scorecard`

Converts BrowserArena JSONL artifacts and density artifacts into provider-facing latency, reliability, density, and cost metrics. It does not launch browsers; use it after benchmark runs to normalize results.

```bash
npm run bench:provider-scorecard
```

Optional cost and host-shape inputs:

```bash
PROVIDER_SCORECARD_HOST_HOURLY_USD=5 \
PROVIDER_SCORECARD_HOST_UTILIZATION=0.70 \
PROVIDER_SCORECARD_HOST_CONCURRENCY=200 \
PROVIDER_SCORECARD_HOST_VCPU=48 \
PROVIDER_SCORECARD_HOST_MEMORY_GB=192 \
npm run bench:provider-scorecard
```

Optional artifact overrides:

```bash
PROVIDER_SCORECARD_BROWSERARENA_PATHS="data/benchmarks/aws-baremetal-m5zn-2026-04-11/browserarena-results.jsonl" \
PROVIDER_SCORECARD_DENSITY_PATHS="data/benchmarks/gcp-n2s8/density-profile-b-optimized-node-c50.json" \
npm run bench:provider-scorecard
```

Targets and formulas: [provider-scorecard-metrics.md](./provider-scorecard-metrics.md).

### `bench:matrix`

Runs both supported profiles through:

- latency benchmark
- density benchmark

Then emits:

- the full profile list
- supported-profile latency results
- supported-profile density results
- direct baseline vs managed deltas for:
  - average create latency
  - average navigation latency
  - max stable concurrency

### `bench:browserless-local`

Runs a local Browserless OSS container as an external reference implementation and reports:

- connect latency
- navigate latency
- max stable concurrency up to `BENCH_MAX_CONCURRENCY`

Notes:

- this is a benchmark of Browserless OSS self-hosted locally, not Browserless cloud
- the benchmark starts and stops a Docker container automatically
- the metric is `connectMs`, not `createMs`, because Browserless OSS does not expose the same explicit session-create API shape as BaseLayer

### `bench:criu-proof`

Runs a host-level Linux CRIU proof against a settled Chromium instance and reports:

- Chromium executable path and launch flags
- browser PID and process tree at dump time
- CRIU `check` result
- cold launch time
- checkpoint time
- restore-to-CDP-ready time
- reconnect success
- restored-page and fresh-page correctness checks
- artifact paths for CRIU logs and the JSON report

### `bench:firecracker-proof`

Runs the host-level Firecracker snapshot proof and reports:

- host capability summary
- base snapshot creation success
- cold boot time for the base VM
- restore success/failure across repeated runs
- restore-to-CDP timing distribution
- Playwright reconnect timing
- deterministic page correctness after restore
- artifact directory for the JSON report

## Practical Notes

- The benchmark uses a deterministic local benchmark site instead of external pages, so results include real HTTP, DOM, and JS work without internet variability.
- The density benchmark now soaks the node: it keeps sessions open, keeps a subset active, and samples host/session state during the run.
- The managed profile may self-mark as `no-admit` on memory-constrained machines unless `BENCH_MIN_FREE_MEMORY_MB` is reduced.
- Density numbers in this repo are bounded by the current implementation. They are not yet a claim about an optimized production runtime.
- Firecracker profile C is intentionally gated behind `BENCH_ENABLE_FIRECRACKER=1` and only activates on Linux hosts.
- The current Firecracker profile is for proof/integration work. It is not yet the tuned density path used in the main benchmark claims.
- The current Firecracker profile owns session lifecycle and snapshot preparation, but not yet the final concurrent network model needed for large `c20+` density sweeps.
- The CRIU proof is Linux-only and intentionally host-level, not containerized, because the first milestone is “restore Chrome into a working CDP session at all.”
