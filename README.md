# BaseLayer

BaseLayer is an open-source browser hosting control plane and host runtime for
running Chromium sessions with Docker and Firecracker-backed isolation.

This repository is a research/runtime release. It includes:

- a control-plane HTTP API for browser session lifecycle management
- a node-agent runtime that can launch browser sessions
- Docker-backed per-session runtime support
- Firecracker snapshot/restore tooling for `chromium-headless-shell`
- benchmark harnesses and result notes for browser hosting experiments

BaseLayer is not a managed browser automation product. It is lower-level
infrastructure for people experimenting with browser hosting, session
scheduling, and microVM-based browser runtimes.

## Status

The main path is Firecracker snapshot restore with
`chromium-headless-shell`. Full Chromium guests, fluid CPU scheduling, and
Lightpanda-related experiments are kept as experimental lanes unless a doc says
otherwise.

Do not treat the benchmark notes as official leaderboard submissions unless the
specific document says the run used a leaderboard-equivalent topology. Many
results are same-host or lab runs intended to guide runtime development.

## Requirements

- Node.js 22+
- npm
- Docker for the container runtime path
- Linux/KVM for Firecracker proof and benchmark paths

Windows and macOS are fine for editing, building TypeScript, and running unit
tests that do not require Docker/KVM.

## Quick Start

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Run tests:

```bash
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

Start with [`docs/README.md`](./docs/README.md).

Useful entry points:

- [`docs/BENCHMARKS.md`](./docs/BENCHMARKS.md)
- [`docs/current-best-profiles.md`](./docs/current-best-profiles.md)
- [`docs/profile-naming-system.md`](./docs/profile-naming-system.md)
- [`docs/firecracker-phases.md`](./docs/firecracker-phases.md)
- [`docs/provider-api-scaffold.md`](./docs/provider-api-scaffold.md)

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
