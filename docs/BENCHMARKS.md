# Benchmarks

BaseLayer includes benchmark harnesses for local latency/density checks and
BrowserArena-stage provider/API runs.

Public profile IDs follow [profile-naming-system.md](./profile-naming-system.md).
Legacy `BaseLayer-<codename>-...` and `profile-*` IDs still resolve as
compatibility aliases, but new commands and docs should use descriptive IDs such
as `baselayer-firecracker-headless-shell`.

## Maintained Profiles

| Profile | Mode | Purpose |
| --- | --- | --- |
| `baselayer-firecracker-headless-shell` | Firecracker | Main public benchmark profile: Firecracker + `chromium-headless-shell`. |
| `baselayer-firecracker-full-chromium` | Firecracker | Experimental full Chromium guest for compatibility-heavy workloads. |
| `baselayer-managed-node` | Managed host | Browser-aware node-agent reference outside the Firecracker lane. |
| `baselayer-container-generic` | Container | Generic container-per-session reference baseline. |
| `baselayer-firecracker-headless-shell-cdp-warm-density` | Firecracker | Experimental CDP-ready warm snapshot lane. |
| `baselayer-firecracker-headless-shell-startup-prune` | Firecracker | Experimental startup/service-prune lane. |
| `baselayer-firecracker-fluid-density` | Firecracker | Experimental hybrid CPU policy lane. |

Additional narrow research aliases exist in the harness for reproducing older
local artifacts. Treat those as internal/experimental unless they appear in
[current-best-profiles.md](./current-best-profiles.md).

## Local Checks

Build first:

```bash
npm run build
```

Run tests:

```bash
npm test
```

Build the local runtime image:

```bash
docker build -f Dockerfile.runtime -t baselayer-runtime:local .
```

## Local Harnesses

Latency benchmark:

```bash
BENCH_ITERATIONS=5 \
BENCH_MIN_FREE_MEMORY_MB=256 \
npm run bench:latency
```

Density benchmark:

```bash
BENCH_MAX_CONCURRENCY=6 \
BENCH_CONCURRENCY_STEP=1 \
BENCH_SUCCESS_THRESHOLD=1 \
BENCH_SOAK_SECONDS=10 \
BENCH_ACTIVE_SESSION_RATIO=0.5 \
BENCH_ACTIVE_ROUNDS_PER_SESSION=3 \
BENCH_ACTIVE_PAUSE_MS=500 \
BENCH_POST_WARMUP_SETTLE_MS=0 \
BENCH_MIN_FREE_MEMORY_MB=0 \
npm run bench:density
```

Firecracker proof on Linux/KVM:

```bash
./scripts/bench/bootstrap-firecracker-linux.sh
sudo ./scripts/firecracker/build-headless-shell-rootfs.sh
sudo -E npm run bench:firecracker-proof
```

Firecracker profile in the shared harness:

```bash
BENCH_ENABLE_FIRECRACKER=1 \
BENCH_PROFILE_IDS=baselayer-firecracker-headless-shell \
FIRECRACKER_KERNEL_PATH="$PWD/artifacts/firecracker/vmlinux" \
FIRECRACKER_ROOTFS_PATH="$PWD/artifacts/firecracker/rootfs.ext4" \
FIRECRACKER_SNAPSHOT_DIR="$PWD/data/firecracker/snapshots" \
npm run bench:latency
```

## BrowserArena-Stage Provider/API Replication

The current public numbers use the provider harness because it records the same
stage names while targeting a self-hosted BaseLayer endpoint:

- `session_creation_ms`
- `session_connect_ms`
- `page_goto_ms`
- `session_release_ms`
- `total_ms`

If you are using a coding agent to reproduce the run on fresh hosts, start with
[reproduction-agent-prompt.md](./reproduction-agent-prompt.md). It includes the
expected topology, smoke checks, headline-number calculation, and common failure
modes.

### One-Shot Self-Hosted BrowserArena Runner

For the closest BrowserArena-style reproduction, use the self-hosted runner
wrapper. In `runner` mode it provisions a fresh AWS `t3.micro` benchmark runner,
provisions a fresh AWS `m5zn.metal` BaseLayer host in the same region, clones the
requested BaseLayer ref onto the metal host, bootstraps Firecracker, waits for
health and warm-pool readiness, runs BrowserArena from the `t3.micro`, pulls
artifacts, writes `summary.json`, and tears down resources unless keep flags are
provided.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bench\run-browserarena-selfhosted.ps1 `
  -Mode runner `
  -Region us-west-2 `
  -Repeats 1 `
  -BaseLayerRepo https://github.com/Lasdw6/BaseLayer.git `
  -BaseLayerRef browserarena-update `
  -BrowserArenaPath C:\path\to\browserarena-with-baselayer-provider `
  -Target https://example.com `
  -Concurrency 1,10 `
  -Runs 100 `
  -OutDir .tmp/browserarena-selfhosted
```

Equivalent Node wrapper:

```bash
npm run bench:browserarena:selfhosted -- -- \
  --mode runner \
  --region us-west-2 \
  --baselayer-repo https://github.com/Lasdw6/BaseLayer.git \
  --baselayer-ref browserarena-update \
  --browserarena-path ../browserarena-with-baselayer-provider \
  --target https://example.com \
  --concurrency 1,10 \
  --runs 100
```

To reuse an already-provisioned metal host, pass its public IP and SSH key. This
keeps the BrowserArena runner flow the same, but skips AWS metal provisioning and
leaves the supplied metal host running after the benchmark:

```bash
npm run bench:browserarena:selfhosted -- -- \
  --mode runner \
  --region us-west-2 \
  --metal-public-ip 203.0.113.10 \
  --metal-ssh-key-path .tmp/baselayer-metal.pem \
  --baselayer-repo https://github.com/Lasdw6/BaseLayer.git \
  --baselayer-ref browserarena-update \
  --target https://example.com \
  --concurrency 1,10 \
  --runs 100
```

If the metal host is already set up and BaseLayer is already exposing its
production-compatible API on port `3000`, add `--use-running-baselayer`. In that
mode the harness only waits for BaseLayer health and warm-pool readiness before
running BrowserArena:

```bash
npm run bench:browserarena:selfhosted -- -- \
  --mode runner \
  --region us-west-2 \
  --metal-public-ip 203.0.113.10 \
  --metal-ssh-key-path .tmp/baselayer-metal.pem \
  --use-running-baselayer \
  --target https://example.com \
  --concurrency 1,10 \
  --runs 100
```

`--concurrency 1,10 --runs 100` runs BrowserArena `c1 x100` and `c10 x100`.
For `c10`, BrowserArena runs 100 waves of 10 parallel sessions, or 1000 session
attempts total.

Current self-host runner knobs:

| Setting | Value | Why it exists |
| --- | ---: | --- |
| `CONTROL_PLANE_ASYNC_SESSION_DELETE` | `1` | Releases return after the session is logically terminated; node-agent teardown runs asynchronously. |
| `CONTROL_PLANE_TERMINATED_SESSION_RETENTION` | `25` | Keeps the control-plane JSON state bounded during long `c10 x100` runs. Without this, release latency grows as old terminated sessions accumulate. |
| `CONTROL_PLANE_SCHEDULER_ADMISSION_WAIT_MS` | `30000` | Applies bounded provider-side backpressure when the host is temporarily saturated. The wait is counted inside BrowserArena `session_creation_ms`; it is not hidden from the benchmark. |
| `CONTROL_PLANE_SCHEDULER_ADMISSION_POLL_MS` | `250` | Poll cadence while waiting for host admission capacity. |
| `CONTROL_PLANE_HOST_DELETE_RESERVATION_TTL_MS` | `3000` | Keeps async-delete capacity reservations short while the node agent catches up. |
| `CONTROL_PLANE_REMOTE_CREATE_TIMEOUT_MS` | `180000` | Gives rare drained-pool requests time to recover through warm refill instead of failing at the tail. The wait is counted inside BrowserArena `session_creation_ms`. |
| `CONTROL_PLANE_REMOTE_CREATE_RETRIES` | `0` | Avoids doubling create-reservation hold time during host contention. Local Firecracker restore retries still happen inside the node agent. |
| `MAX_SESSIONS` | `20` | Base admission target for the single metal host. Warm-borrow logic can reuse prebuilt warm sessions above this where safe. |
| `FIRECRACKER_MAX_MICROVM_COUNT` | `44` | Hard cap for active and warm Firecracker microVMs on the `m5zn.metal` host. |
| `FIRECRACKER_NETWORK_POOL_SIZE` | `44` | Prepares one network slot per possible Firecracker microVM. |
| `WARM_POOL_SIZE` | `30` | Maintains a deeper pool of ready Chromium microVMs for BrowserArena create waves while leaving refill headroom under the microVM cap. |
| `WARM_POOL_RESERVE` | `4` | Leaves headroom for warm-pool refill and active sessions. |
| `WARM_POOL_FILL_CONCURRENCY` | `4` | Refills the warm pool conservatively to avoid the restore-stampede settings rejected during tuning. |
| `NODE_AGENT_LAUNCH_ADMISSION_WAIT_MS` | `175000` | Applies bounded node-agent backpressure if active sessions and launch reservations briefly exceed local admission capacity. The wait is counted inside BrowserArena `session_creation_ms`. |
| `NODE_AGENT_LAUNCH_ADMISSION_POLL_MS` | `100` | Poll cadence while the node agent waits for local launch capacity. |
| `FIRECRACKER_LAUNCH_CONCURRENCY` | `4` | Caps concurrent warm preparation restores. |
| `FIRECRACKER_COLD_RESTORE_CONCURRENCY` | `2` | Separates cold restore capacity from warm-pool refill capacity. |
| `FIRECRACKER_WARM_CLAIM_TIMEOUT_MS` | `3000` | Bounds stale warm-VM claim validation. |
| `FIRECRACKER_WARM_WAIT_MS` | `175000` | Makes a c10 create wait for warm-pool refill before failing. The wait is counted inside BrowserArena `session_creation_ms`. |
| `FIRECRACKER_WARM_FALLBACK_TO_COLD` | `0` | Keeps BrowserArena self-host runs on the warm restore path instead of letting temporary pool drain trigger cold-restore storms. |

The bounded admission wait is intentionally part of the provider create path.
If the host is saturated, BrowserArena should see slower `session_creation_ms`,
not a fast `503` that makes the run fail. A run is not considered clean unless
the artifacts show the expected success count for each concurrency level.
Metal-side diagnostics are pulled before teardown on both passing and failing
runs so setup or benchmark failures leave provider logs next to the BrowserArena
artifacts.

Recommended provider settings for the May 2026 `example.com` runs:

```bash
export CONTROL_PLANE_ASYNC_SESSION_DELETE=1
export CONTROL_PLANE_ASYNC_SESSION_DELETE_DELAY_MS=120000
export MAX_SESSIONS=128
export FIRECRACKER_MAX_MICROVM_COUNT=128
export FIRECRACKER_NETWORK_POOL_SIZE=128
export FIRECRACKER_READY_SETTLE_MS=50
export FIRECRACKER_RESTORE_RETRIES=2
```

c1 x100 replication:

```bash
export BASELAYER_API_URL="http://<provider-host>:3000/v1"
export BASELAYER_RUNTIME_PROFILE="baselayer-firecracker-headless-shell"
export BENCH_BROWSERARENA_PAGE_URL="https://example.com/"
export BENCH_PAGE_GOTO_WAIT_UNTIL="domcontentloaded"
export BENCH_CONNECT_RETRY_BUDGET_MS=15000
export BENCH_RUNS=100
export BENCH_CONCURRENCY=1
export BENCH_OUT="$PWD/data/benchmarks/provider-api-example-c1x100.json"

npm run bench:provider-api
```

c10 x10 validation:

```bash
export BENCH_RUNS=10
export BENCH_CONCURRENCY=10
export BENCH_OUT="$PWD/data/benchmarks/provider-api-example-c10x10.json"

npm run bench:provider-api
```

In this harness, `BENCH_RUNS=10` at `BENCH_CONCURRENCY=10` means 10 waves of
10 sessions, or 100 measured sessions total.

The June 1, 2026 replication produced a conservative `223.6 ms` c1 p50
lifecycle result, rounded to `224 ms`, by taking the slowest clean `100/100`
run from a five-run `c1 x100` batch. For each run, the BrowserArena-style
lifecycle is computed by taking each stage p50, then summing those stage p50s.
The full five-run batch ranged from `190.8 ms` to `223.6 ms`; pooled successful
iterations summed to `216.3 ms` across `498/500` successes. See
[browserarena-results.md](./browserarena-results.md) for the exact rows and
caveats.

## Output Shape

`bench:provider-api` and the BrowserArena-stage harness report:

- per-iteration `session_creation_ms`, `session_connect_ms`, `page_goto_ms`,
  `session_release_ms`, and `total_ms`
- `avg`, `p50`, `p95`, and `p99` summaries
- success counts and failure details
- optional navigation breakdown metrics

`session_release_ms` measures the public API release response. BaseLayer returns
release after marking the session terminated and starts node-agent teardown
asynchronously, so this metric should stay close to control-plane response
latency rather than full VM cleanup time.

## Provider Scorecard

After benchmark runs, normalize artifacts with:

```bash
npm run bench:provider-scorecard
```

Optional inputs:

```bash
PROVIDER_SCORECARD_HOST_HOURLY_USD=5 \
PROVIDER_SCORECARD_HOST_UTILIZATION=0.70 \
PROVIDER_SCORECARD_HOST_CONCURRENCY=200 \
PROVIDER_SCORECARD_HOST_VCPU=48 \
PROVIDER_SCORECARD_HOST_MEMORY_GB=192 \
npm run bench:provider-scorecard
```

Targets and formulas: [provider-scorecard-metrics.md](./provider-scorecard-metrics.md).

## Practical Notes

- Firecracker profiles require Linux/KVM.
- Generated artifacts belong under ignored local directories such as
  `data/benchmarks/`, `.tmp/`, or `artifacts/`.
- Use `BENCH_BROWSERARENA_PAGE_URL=https://google.com/` only when reproducing
  historical Google-target rows.
- Do not hide admission waits or navigation work outside the BrowserArena
  lifecycle. If the provider queues under load, that wait belongs inside
  `session_creation_ms`.
