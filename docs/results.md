# Benchmark Snapshot

Date: `2026-04-05`

This snapshot captures the current best-performing managed worker configuration and the latest local benchmark results from this repo.

## Workload

- Deterministic local benchmark site served by [`src/bench/lib/site.ts`](../src/bench/lib/site.ts)
- Real HTTP navigation from containerized browsers to `host.docker.internal`
- DOM construction, CSS load, and deterministic client-side JS work
- Soak pattern:
  - `BENCH_MAX_CONCURRENCY=6`
  - `BENCH_CONCURRENCY_STEP=1`
  - `BENCH_SUCCESS_THRESHOLD=1`
  - `BENCH_WARMUP_ITERATIONS=1`
  - `BENCH_SOAK_SECONDS=10`
  - `BENCH_ACTIVE_SESSION_RATIO=0.5`
  - `BENCH_ACTIVE_ROUNDS_PER_SESSION=3`
  - `BENCH_ACTIVE_PAUSE_MS=500`

## Managed Profile

Current winning managed benchmark shape from [`src/bench/lib/profiles.ts`](../src/bench/lib/profiles.ts):

- `MAX_SESSIONS=6`
- `WARM_POOL_SIZE=6`
- `WARM_POOL_RESERVE=1`
- `WARM_POOL_FILL_CONCURRENCY=6`
- `WARM_RUNTIME_SETTLE_MS=400`
- `SESSION_MEMORY_LIMIT_MB=512`
- `SESSION_MEMORY_RESERVATION_MB=384`
- `SESSION_ADMISSION_MEMORY_MB=192`
- `SESSION_SHM_LIMIT_MB=128`
- `SESSION_ADMISSION_SHM_MB=48`
- `SESSION_RENDERER_LIMIT=6`
- `MAX_RENDERERS=36`

Runtime tuning is in [`src/runtime/server.ts`](../src/runtime/server.ts).

## Latest Results

### Managed vs Baseline

Source artifacts were written under the ignored local directory `data/benchmarks/`.

At concurrency `6`:

- Baseline:
  - `avgCreateMs = 4371.29`
  - `avgNavigateMs = 421.77`
  - `maxStableConcurrency = 6`
- Managed:
  - `avgCreateMs = 180.41`
  - `avgNavigateMs = 363.69`
  - `maxStableConcurrency = 6`

Interpretation:
- Managed is materially faster on session bring-up.
- Managed is also faster on navigation at the target stable concurrency.

### Managed vs Browserless Local

Browserless local was run with:

- `BROWSERLESS_CONCURRENT=6`
- the same deterministic local-site soak settings above

Latest Browserless local result:

- `avgConnectMs = 617.99`
- `avgNavigateMs = 4465.47`
- `maxStableConcurrency = 6`

Interpretation:
- On the current local-site soak workload, the managed worker is ahead of Browserless local on both session handoff and high-concurrency navigation.

## Commands

Build and test:

```powershell
npm run build
npm test
docker build -f Dockerfile.runtime -t baselayer-runtime:local .
```

Managed/baseline soak benchmark:

```powershell
$env:BENCH_MAX_CONCURRENCY='6'
$env:BENCH_CONCURRENCY_STEP='1'
$env:BENCH_SUCCESS_THRESHOLD='1'
$env:BENCH_WARMUP_ITERATIONS='1'
$env:BENCH_SOAK_SECONDS='10'
$env:BENCH_ACTIVE_SESSION_RATIO='0.5'
$env:BENCH_ACTIVE_ROUNDS_PER_SESSION='3'
$env:BENCH_ACTIVE_PAUSE_MS='500'
npm run bench:density
```

Browserless local reference:

```powershell
$env:BENCH_ITERATIONS='5'
$env:BENCH_WARMUP_ITERATIONS='1'
$env:BENCH_MAX_CONCURRENCY='6'
$env:BENCH_SOAK_SECONDS='10'
$env:BENCH_ACTIVE_SESSION_RATIO='0.5'
$env:BENCH_ACTIVE_ROUNDS_PER_SESSION='3'
$env:BENCH_ACTIVE_PAUSE_MS='500'
$env:BROWSERLESS_CONCURRENT='6'
npm run bench:browserless-local
```

## Notes

- These are local-machine results, not cloud claims.
- The current benchmark is deterministic and comparable, but it is still synthetic.
- The next useful step is to run the same benchmark matrix on multiple VM sizes and Linux hosts with stable KVM support.


## Snapshot 2026-04-05T21-09-14.740Z

- Workload:
  - `maxConcurrency=6`
  - `soakSeconds=10`
  - `activeSessionRatio=0.5`
  - `activeRoundsPerSession=3`
  - `activePauseMs=500`
- Baseline @ c6:
  - `avgCreateMs=4356.13`
  - `avgNavigateMs=379.85`
  - `maxStableConcurrency=6`
- Managed @ c6:
  - `avgCreateMs=176.01`
  - `avgNavigateMs=417.63`
  - `maxStableConcurrency=6`
- Browserless local @ c6:
  - `avgConnectMs=826.10`
  - `avgNavigateMs=413.17`
  - `maxStableConcurrency=6`
