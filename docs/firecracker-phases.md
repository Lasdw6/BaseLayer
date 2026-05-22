# Firecracker Phases

## Summary

The Firecracker work is split into three phases:

1. Firecracker proof of concept
2. Node agent plus session lifecycle integration
3. Benchmark and density validation

The phase ordering is strict. Phase 1 is the gate. If snapshot restore does not materially outperform the current cold-launch path, the later phases need to be reconsidered.

## Phase 1: Firecracker Proof Of Concept

Target duration:
- `2-3` weeks

Goal:
- prove that a Firecracker snapshot can restore a working browser fast enough to matter

Deliverables:
- Firecracker running on a Linux host with KVM
- minimal guest kernel plus rootfs containing `chromium-headless-shell`
- CDP verified inside the guest
- base snapshot taken with Chrome idle
- restored microVM that accepts Playwright over CDP
- measured restore time with a target under `500 ms`

Success criteria:
- `3/3` successful restore runs on the same host
- restored browser accepts Playwright `connectOverCDP`
- deterministic page correctness check passes after restore
- `p50 restore-to-CDP-ready < 500 ms`

Failure criteria:
- snapshot restore is unstable
- restored browser is not functionally correct
- restore time is not materially better than the existing cold launch path

## Phase 2: Node Agent And Session Lifecycle

Target duration:
- `2-3` weeks

Goal:
- replace cold browser launch with snapshot restore behind the existing session API

Deliverables:
- node agent that talks to the Firecracker REST API
- session request path:
  - restore from base snapshot
  - wait for CDP
  - hand back session endpoint
- session teardown path:
  - destroy microVM
  - discard session state
- basic admission control and memory accounting

Success criteria:
- existing control-plane API shape still works
- each session starts from a clean snapshot
- terminated sessions leave no stray microVMs
- hard caps on active microVM count and reserved guest memory are enforced

Current Phase 2 status:
- Firecracker mode is wired into the normal node agent and control plane
- the node agent can auto-create the base snapshot at startup when enabled
- session create:
  - restore snapshot
  - wait for CDP
  - return normal session endpoints
- session delete:
  - destroy microVM
  - free reserved guest memory
- scheduler now considers microVM count and reserved guest memory
- node-agent shutdown now tears down tracked Firecracker sessions
- startup reconciliation now clears stale Firecracker sockets, state dirs, namespaces, and orphaned processes from interrupted runs
- session records now include per-restore timing breakdowns:
  - network setup
  - Firecracker process and API socket bring-up
  - snapshot load call
  - CDP-ready wait
- Phase 2 validation succeeded on GCP nested virtualization:
  - control plane registered a Firecracker host successfully
  - session creation restored a microVM and returned a normal CDP endpoint
  - Playwright connected over CDP and loaded a page successfully
  - API-driven session deletion terminated the microVM and cleared reserved memory

Remaining Phase 2 gap:
- the current snapshot uses one fixed guest network identity
- that is sufficient for proof and single-session lifecycle validation
- it is not yet the final networking model for high concurrent multi-microVM density runs

## Phase 3: Benchmark Properly

Target duration:
- `1` week

Goal:
- compare Firecracker snapshot restore against the current container-backed managed path under the same soak workload

Deliverables:
- Firecracker profile in the shared benchmark harness
- soak runs at:
  - `c20`
  - `c30`
  - `c50`
- per-run capture of:
  - create or restore latency
  - navigation latency
  - success rate
  - active VM count
  - memory pressure over time

Primary comparison:
- Firecracker snapshot restore vs current warm-pool path
- Firecracker snapshot restore vs current cold-launch path

Success criteria:
- restored launches behave like warm launches instead of cold launches
- the high-concurrency burst no longer collapses into multi-second cold starts after the first few sessions
- stable concurrency at `c50` holds without launch-path degradation dominating the run

## Current Repo Status

Already implemented in this repo:
- Firecracker bootstrap and rootfs build scripts
- Firecracker proof harness
- Firecracker node-agent mode
- benchmark profile wiring

Live validation completed on Linux/KVM:
- actual snapshot and restore success
- Playwright-over-CDP reconnect after restore
- restore latency measurements
- stability under repeated runs
- shared soak benchmark now runs against concurrent restored microVMs

Latest proof result:
- environment:
  - GCP `n2-standard-8`
  - Ubuntu `22.04`
  - nested virtualization enabled
- browser:
  - `chromium-headless-shell` inside a Firecracker microVM
- cold boot:
  - `6905.9 ms`
- restore:
  - `3/3` successful restore runs
  - `avgRestoreMs = 130.51`
  - `p50RestoreMs = 130.10`
  - `p95RestoreMs = 133.76`
- correctness:
  - Playwright `connectOverCDP` succeeded after restore
  - deterministic page check passed after restore on all runs

This clears the Phase 1 gate. The next meaningful work is Phase 2 session-lifecycle integration and then Phase 3 density benchmarking against the current managed warm-pool path.

## Current Default

The baseline Firecracker profile is the current default direction for the repo.
Within that baseline Firecracker profile, the default browser runtime is still `chromium-headless-shell`.

Why:
- snapshot restore is proven and fast
- session lifecycle integration works through the normal control plane
- scaling through `c24` has already been validated on the baseline policy
- the latest clean `5`-run browserarena baseline rerun is still the best overall lifecycle result:
  - create `~523 ms`
  - connect `~107 ms`
  - goto `~1442 ms`
  - release `~3 ms`

Fluid-compute CPU allocation remains implemented, but it is currently experimental.
The latest `fluid5` comparison showed:
- baseline still wins on launch latency at `c24`
- dynamic policies produce only a small steady-state navigation improvement
- hybrid is closer than always-on dynamic scheduling, but still not strong enough to replace baseline

So for now:
- baseline Firecracker is the main runtime path
- `chromium-headless-shell` is the main browser runtime inside that path
- full Chromium is an experimental browser tier, not the default
- fluid-compute is a side experiment, not the default

Latest integrated benchmark status:
- verified on GCP `n2-standard-8` through `c24`
- verified on GCP `n2-custom-12-49152` through `c24`
- all verified runs achieved:
  - `100%` session create success
  - `100%` initial navigation success
  - `0` soak failures

Representative `c24` comparison:
- `n2-standard-8`
  - `avgCreateMs = 3508.72`
  - `avgNavigateMs = 8095.01`
  - `peakTrackedMemoryMb = 24576`
  - `peakMemoryPressurePct = 11`
- `n2-custom-12-49152`
  - `avgCreateMs = 2616.07`
  - `avgNavigateMs = 7062.94`
  - `peakTrackedMemoryMb = 24576`
  - `peakMemoryPressurePct = 7`

The exact side-by-side scaling analysis is in:
- [`firecracker-scaling-analysis.md`](./firecracker-scaling-analysis.md)
