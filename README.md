# BaseLayer

BaseLayer is an open-source browser hosting control plane and host runtime for
running Chromium sessions with Docker and Firecracker-backed isolation.

It was built to test how fast a self-hosted browser provider can get on the
BrowserArena lifecycle methodology:

```text
session create + CDP connect + page.goto + session release
```

## Results

These are **self-hosted** BrowserArena-methodology runs.

### Latest Methodology Snapshot

BrowserArena changed its default fairness URL to `example.com` on 2026-05-05.
Using that current target, BaseLayer's latest five-run sequential self-hosted
average was measured on 2026-05-31. The competitor positioning referenced in
[`docs/browserarena-results.md`](./docs/browserarena-results.md) uses
BrowserArena c1 leaderboard numbers checked on 2026-05-31.

In the BrowserArena c1 leaderboard snapshot checked on 2026-05-31, this places
BaseLayer above the top listed provider by sequential p50 lifecycle latency.

| Runtime / profile | Run date | Topology | Runs | Success | Create p50 | Connect p50 | Goto p50 | Release p50 | Lifecycle p50 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `baselayer-firecracker-headless-shell` | 2026-05-31 | AWS `t3.micro` runner -> AWS `m5zn.metal` host, `us-east-2`, BrowserArena stages, `http://example.com`, `c1 x100`, 5 repeats | 500 | `498/500` | `90.3 ms` | `39.5 ms` | `83.0 ms` | `11.5 ms` | `211.4 ms` |

These are **self-hosted, sequential** benchmark results, averaged across five
`c1 x100` runs on 2026-05-31. They are not official BrowserArena leaderboard
submissions. The runs are reproducible, and this repo includes the
[benchmark harness used, run artifacts, and replication notes](./docs/benchmarks/browserarena-c1-final-2026-05-31/).

The latest concurrent `c10 x10` run remains under review while the scheduler and
demo harness are being hardened. The current public headline is the sequential
five-run average above.

See [`docs/browserarena-results.md`](./docs/browserarena-results.md) for the
replication notes and caveats.

### Google-Target Snapshot

The headline BaseLayer rows below used the BrowserArena `hello-browser`
methodology as it existed at the time of the runs: `page.goto` against
`https://google.com/` with `waitUntil: "domcontentloaded"`.

BrowserArena changed its default fairness URL to `example.com` on 2026-05-05.
Current BrowserArena leaderboard numbers are therefore much lower and are not
directly comparable with these Google-target rows.

| Runtime / profile | Run date | Topology | Runs | Success | Create p50 | Connect p50 | Goto p50 | Release p50 | Lifecycle p50 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `baselayer-firecracker-headless-shell-cdp-warm-density` | 2026-04-23 | AWS `t3.micro` runner -> AWS `m5zn.metal` provider, `us-east-2`, BrowserArena `hello-browser`, Google target | 100 | `99/100` | `93 ms` | `56 ms` | `618 ms` | `5 ms` | `769 ms` |
| `baselayer-firecracker-headless-shell-cdp-warm-density` | 2026-04-24 | AWS `t3.micro` runner -> AWS `m5zn.metal` provider, `us-east-1`, BrowserArena `hello-browser`, Google target | 100 | `99/100` | `87 ms` | `102 ms` | `555 ms` | `5 ms` | `749 ms` |
| `baselayer-firecracker-full-chromium` | 2026-05-07 | AWS `t3.micro` runner -> AWS `m5zn.metal` provider, public `/v1`, BrowserArena `hello-browser`, Google target | 100 | `100/100` | `96 ms` | `61 ms` | `619 ms` | `10 ms` | `784 ms` |
| `baselayer-firecracker-headless-shell` | 2026-04-12 | AWS `m5zn.metal`, concurrent BrowserArena-style waves, Google target | c24 | `24/24` | `448 ms` | `104 ms` | `3788 ms` | `9 ms` | `4349 ms` |

See
[`docs/browserarena-results.md`](./docs/browserarena-results.md) and
[`docs/current-best-profiles.md`](./docs/current-best-profiles.md) for
replication notes and historical context.

## What This Repo Contains

- control-plane HTTP API for browser session lifecycle management
- node-agent runtime for launching browser sessions
- Docker-backed per-session runtime support
- Firecracker snapshot/restore tooling for `chromium-headless-shell`
- benchmark harnesses aligned to BrowserArena stage names
- public result notes and profile documentation

BaseLayer is lower-level infrastructure for browser hosting experiments. It is
not a managed browser automation product.

## Replicate The Self-Hosted Methodology

The most direct in-repo replication path is the provider `/v1` benchmark
harness. It uses the same lifecycle stages as BrowserArena:

- `session_creation_ms`
- `session_connect_ms`
- `page_goto_ms`
- `session_release_ms`
- `total_ms`

### 1. Prepare A Linux/KVM Provider Host

Use a Linux host with KVM enabled. The published AWS runs used `m5zn.metal`.

```bash
git clone https://github.com/Lasdw6/baselayer.git baselayer
cd baselayer
npm ci
npm run build
./scripts/bench/bootstrap-firecracker-linux.sh
sudo ./scripts/firecracker/build-headless-shell-rootfs.sh
```

Start the control plane and Firecracker node agent:

```bash
export CONTROL_PLANE_PORT=3000
export CONTROL_PLANE_ASYNC_SESSION_DELETE=1
export CONTROL_PLANE_ASYNC_SESSION_DELETE_DELAY_MS=120000

export CONTROL_PLANE_URL="http://127.0.0.1:3000"
export NODE_AGENT_PORT=4000
export NODE_AGENT_PUBLIC_HOST="127.0.0.1"
export NODE_AGENT_MODE="firecracker"
export BASELAYER_SUPPORTED_RUNTIME_PROFILES="baselayer-firecracker-headless-shell"
export MAX_SESSIONS=128

export FIRECRACKER_KERNEL_PATH="$PWD/artifacts/firecracker/vmlinux"
export FIRECRACKER_ROOTFS_PATH="$PWD/artifacts/firecracker/rootfs.ext4"
export FIRECRACKER_SNAPSHOT_DIR="$PWD/data/firecracker/snapshots"
export FIRECRACKER_ALLOW_AUTO_SNAPSHOT=1
export FIRECRACKER_MAX_MICROVM_COUNT=128
export FIRECRACKER_NETWORK_POOL_SIZE=128
export FIRECRACKER_READY_SETTLE_MS=50
export FIRECRACKER_RESTORE_RETRIES=2

npm run dev:api
# in another shell:
npm run dev:agent
```

For public network tests, put the API behind your own firewall/reverse proxy and
enable API-key auth. If you run a split public/internal deployment, set
`CONTROL_PLANE_PUBLIC_V1_ONLY=1` only on the public listener; the node agent
still needs internal registration routes. See [Public API Safety](#public-api-safety).

### 2. Run The Built-In BrowserArena-Stage Harness

From the provider host or a same-region runner:

```bash
export BASELAYER_API_URL="http://<provider-host>:3000/v1"
export BASELAYER_RUNTIME_PROFILE="baselayer-firecracker-headless-shell"
export BENCH_RUNS=100
export BENCH_CONCURRENCY=1
export BENCH_BROWSERARENA_PAGE_URL="http://example.com/"
export BENCH_PAGE_GOTO_WAIT_UNTIL="domcontentloaded"
export BENCH_CONNECT_RETRY_BUDGET_MS=15000
export BENCH_OUT="$PWD/data/benchmarks/provider-api-100.json"

npm run bench:provider-api
```

The output JSON includes p50/p95/p99 for each BrowserArena-style stage plus the
raw per-iteration rows.

The current c1 replication rows used that shape with `BENCH_RUNS=100` and
`BENCH_CONCURRENCY=1`, repeated five times.

```bash
export BENCH_RUNS=10
export BENCH_CONCURRENCY=10
export BENCH_OUT="$PWD/data/benchmarks/provider-api-example-c10x10.json"

npm run bench:provider-api
```

In this harness, `BENCH_RUNS=10` at `BENCH_CONCURRENCY=10` means 10 waves of
10 sessions, or 100 measured sessions total.

To reproduce the historical Google-target rows, use:

```bash
export BENCH_BROWSERARENA_PAGE_URL="https://google.com/"
```

### 3. Run With The BrowserArena Harness

The headline rows above were produced with the BrowserArena `hello-browser`
lifecycle against a self-hosted BaseLayer provider endpoint. Use the same
topology when comparing numbers:

- runner and provider in the same AWS region
- target: `example.com` for current BrowserArena methodology, or Google only
  when reproducing the historical snapshot above
- wait condition: `domcontentloaded`
- runs: `100`
- concurrency: `1`
- no request blocking
- async delete enabled for latency-style runs

Shape:

```bash
BASELAYER_BASE_URL="http://<provider-host>:3000/v1" \
npm run bench -- --provider=baselayer --benchmark=hello-browser --runs=100 --concurrency=1
```

Use a short smoke first:

```bash
BENCH_RUNS=1 npm run bench:provider-api
BENCH_RUNS=5 npm run bench:provider-api
BENCH_RUNS=100 npm run bench:provider-api
```

Only compare a `100`-run if the smoke runs are clean.

## Requirements

- Node.js 22+
- npm
- Docker for the container runtime path
- Linux/KVM for Firecracker proof and benchmark paths

Windows and macOS are fine for editing, building TypeScript, and running unit
tests that do not require Docker/KVM.

## Local Quick Start

Install dependencies:

```bash
npm install
```

Build and test:

```bash
npm run build
npm test
```

Build the runtime image:

```bash
docker build -f Dockerfile.runtime -t baselayer-runtime:local .
```

Start the control plane:

```bash
npm run dev:api
```

Start a local node agent in managed mode:

```bash
export CONTROL_PLANE_URL="http://127.0.0.1:3000"
export NODE_AGENT_PORT="4000"
export NODE_AGENT_PUBLIC_HOST="127.0.0.1"
export NODE_AGENT_MODE="managed"
export RUNTIME_IMAGE="baselayer-runtime:local"
npm run dev:agent
```

Create a session:

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions \
  -H "content-type: application/json" \
  -d '{"browser":"chromium","keepAlive":false,"timeoutSec":900,"idleTimeoutSec":120}'
```

## Public API Safety

The control plane is designed for local and lab use by default. Before exposing
`/v1` outside a trusted network:

- set `CONTROL_PLANE_PUBLIC_V1_ONLY=1`
- set `CONTROL_PLANE_ENFORCE_PROVIDER_API_KEY_AUTH=1`
- provide API keys through `CONTROL_PLANE_PROVIDER_API_KEY_CONFIG_PATH`
- bind services behind a firewall or reverse proxy

Example config files live in [`config`](./config).

## Repository Layout

- `src/api` - control plane, scheduler, API routes, store
- `src/node-agent` - host runtime, Docker launcher, Firecracker integration
- `src/runtime` - browser runtime container entrypoint
- `src/bench` - benchmark harnesses and runtime experiments
- `scripts/firecracker` - rootfs and Firecracker image helpers
- `scripts/bench` - Linux bootstrap and benchmark helpers
- `docs` - public architecture, benchmark, and experiment notes
- `test` - unit and contract tests

## Documentation

- [`docs/BENCHMARKS.md`](./docs/BENCHMARKS.md)
- [`docs/browserarena-results.md`](./docs/browserarena-results.md)
- [`docs/current-best-profiles.md`](./docs/current-best-profiles.md)
- [`docs/profile-naming-system.md`](./docs/profile-naming-system.md)
- [`docs/firecracker-phases.md`](./docs/firecracker-phases.md)
- [`docs/provider-api-scaffold.md`](./docs/provider-api-scaffold.md)

## License

MIT. See [`LICENSE`](./LICENSE).
