# Experimental Benchmark Profiles

Date: 2026-04-11

These profiles are scaffolds for VM and bare-metal benchmark runs. They are intentionally named so a benchmark artifact records the architecture being tested, instead of burying the idea in ad hoc environment variables.

Canonical profile IDs now live in [profile-naming-system.md](./profile-naming-system.md). The older `profile-*` IDs are still accepted as legacy aliases, but new commands should use the `BaseLayer-*` names.

For the prioritized list of which experimental profiles to actually rerun next (and why), see the **Suggested Next Optimizations** section of [current-best-profiles.md](./current-best-profiles.md). In particular: the cgroup `subtree_control` propagation fix on 2026-04-16 unblocks meaningful retests of `BaseLayer-Pidgeotto-fluid-hybrid`, `BaseLayer-Pidgeot-fluid-always`, and `BaseLayer-Spearow-fluid-density`, which were previously rejected on the renice-only fallback path.

Use them with:

```bash
export BENCH_PROFILE_IDS="BaseLayer-Blastoise-firecracker-slim-512"
npm run bench:latency
```

For Firecracker profiles, also set the normal Linux/KVM inputs:

```bash
export BENCH_ENABLE_FIRECRACKER="1"
export FIRECRACKER_KERNEL_PATH="$PWD/artifacts/firecracker/vmlinux"
export FIRECRACKER_ROOTFS_PATH="$PWD/artifacts/firecracker/rootfs.ext4"
export FIRECRACKER_ALLOW_AUTO_SNAPSHOT="1"
```

Each new Firecracker variant uses its own snapshot name and `data/firecracker/*-<profile>` directories by default, so lower-memory and alternate-rootfs snapshots do not accidentally reuse the default snapshot.

## Runnable Profiles


| Profile                                         | Mode        | Purpose                                                                                              |
| ----------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `BaseLayer-Venusaur-managed-cold-node`          | managed     | Disable warm pool to isolate cold burst behavior and warm-pool benefit.                              |
| `BaseLayer-Squirtle-managed-dense-384mb`        | managed     | Tighter memory, `/dev/shm`, and renderer budgets for higher density.                                 |
| `BaseLayer-Wartortle-managed-large-shm`         | managed     | Larger `/dev/shm` and renderer budget for heavier compatibility pages.                               |
| `BaseLayer-Blastoise-firecracker-slim-512`      | firecracker | Headless-shell microVM at `512 MB` to test hardened-tier economics.                                  |
| `BaseLayer-Caterpie-firecracker-slim-384`       | firecracker | Headless-shell microVM at `384 MB` to find the lower memory bound.                                   |
| `BaseLayer-Metapod-firecracker-one-vcpu`        | firecracker | Headless-shell microVM at `1 vCPU` to test CPU packing and navigation tails.                         |
| `BaseLayer-Butterfree-firecracker-cdp-warm`     | firecracker | Snapshot at CDP-ready only; control for page/context warmup.                                         |
| `BaseLayer-Weedle-firecracker-context-warm`     | firecracker | Snapshot with a warmed Playwright context; test connect/goto tradeoff.                               |
| `BaseLayer-Kakuna-firecracker-no-warm`          | firecracker | Disable warm-page work; isolate warm snapshot overhead.                                              |
| `BaseLayer-Vulpix-density-cdp-warm`             | firecracker | One-vCPU CDP-warm density lane; latest same-host page-ready winner over `BaseLayer-Mew` through `c24`. |
| `BaseLayer-Jigglypuff-density-target-warm`      | firecracker | One-vCPU page-ready lane with only a pre-created DevTools target.                                    |
| `BaseLayer-Wigglytuff-density-blank-warm`       | firecracker | One-vCPU page-ready lane with a created context and blank page, but no synthetic navigation.         |
| `BaseLayer-Zubat-density-cdp-warm-navcap-8`     | firecracker | CDP-warm plus conservative navigation admission to separate snapshot benefit from renderer contention. |
| `BaseLayer-Mewtwo-full-chromium`                | firecracker | Full Chromium guest via `artifacts/firecracker/rootfs-chromium.ext4`.                                |
| `BaseLayer-Beedrill-full-chromium-512`          | firecracker | Full Chromium guest at `512 MB`; compatibility under tighter memory.                                 |
| `BaseLayer-Pidgey-network-validate`             | firecracker | Enable network-slot validation on claim; measure safety overhead.                                    |
| `BaseLayer-Pidgeotto-fluid-hybrid`              | firecracker | Dynamic CPU policy in `hybrid` mode.                                                                 |
| `BaseLayer-Pidgeot-fluid-always`                | firecracker | Dynamic CPU policy in `always` mode.                                                                 |
| `BaseLayer-Rattata-fast-slot-reuse`             | firecracker | Skip helper cleanup grace on clean slots to isolate create-path slot reuse overhead.                 |
| `BaseLayer-Raticate-density-512-1vcpu`          | firecracker | Combine 512MB guests, 1 vCPU, and fast slot reuse for density.                                       |
| `BaseLayer-Spearow-fluid-density`               | firecracker | Combine 512MB/1vCPU, fast slot reuse, and hybrid fluid CPU policy.                                   |
| `BaseLayer-Oddish-kernel-goto`                  | firecracker | Kernel-inspired guest Chromium/headless-shell launch preset baked into a dedicated rootfs.           |
| `BaseLayer-Gloom-kernel-goto-lite`              | firecracker | Narrower Kernel-inspired guest launch subset intended to keep the BU gain with fewer extras.         |
| `BaseLayer-Vileplume-kernel-feature-prune`      | firecracker | Kernel-derived disable-features bundle only, without the broader startup bundle.                     |
| `BaseLayer-Gengar-kernel-startup-prune`         | firecracker | Kernel-style startup/service pruning while keeping feature flags close to baseline.                  |
| `BaseLayer-Paras-kernel-goto-ipv6off`           | firecracker | Same as Oddish, but disables IPv6 inside the guest image.                                            |
| `BaseLayer-Dragonite-kernel-balanced`           | firecracker | Balanced combined bundle: startup pruning plus curated Kernel-derived feature pruning.               |
| `BaseLayer-Parasect-kernel-goto-cdp-warm`       | firecracker | Kernel-inspired guest launch preset stacked with the CDP-only warm snapshot.                         |
| `BaseLayer-Krabby-kernel-startup-prune-lite`    | firecracker | Tighter follow-up to Gengar with only the lowest-risk startup/service pruning.                       |
| `BaseLayer-Kingler-kernel-balanced-lite`        | firecracker | Tighter follow-up to Dragonite with a reduced feature-prune set.                                     |
| `BaseLayer-Horsea-async-gengar-merge`           | firecracker | Async-parity candidate: Mew runtime shape merged with Gengar rootfs.                                 |
| `BaseLayer-Seadra-async-dragonite-merge`        | firecracker | Async-parity candidate: Mew runtime shape merged with Dragonite rootfs.                              |
| `BaseLayer-Goldeen-async-gloom-merge`           | firecracker | Async-parity candidate: Mew runtime shape merged with Gloom rootfs.                                  |
| `BaseLayer-Poliwag-async-manual-gengar`         | firecracker | Manual async-parity integration using a dedicated Gengar-style rootfs instead of a stacked merge.    |
| `BaseLayer-Poliwhirl-async-manual-dragonite`    | firecracker | Manual async-parity integration using a dedicated Dragonite-style rootfs instead of a stacked merge. |
| `BaseLayer-Staryu-custom-shell-startup-network` | firecracker | Custom-built `chrome-headless-shell` baseline lane for build-level startup/network experiments.      |
| `BaseLayer-Starmie-async-custom-shell-merge`    | firecracker | Manual async-parity custom-shell lane using the main Mew runtime semantics.                          |
| `BaseLayer-Abra-custom-shell-baseline`          | firecracker | Direct custom-shell baseline A/B lane.                                                               |
| `BaseLayer-Kadabra-custom-shell-startup-prune`  | firecracker | Custom-shell startup-prune launch-profile lane.                                                      |
| `BaseLayer-Alakazam-custom-shell-async-manual`  | firecracker | Custom-shell manual async-parity lane using a dedicated async-manual rootfs.                         |
| `BaseLayer-Ditto-custom-shell-kernel-balanced`  | firecracker | Combined lane: custom headless-shell binary + kernel-balanced guest (`rootfs-custom-shell-kernel-balanced.ext4`). |


## Planned Architecture Profiles

These are represented in the profile registry but are not executable yet:


| Profile                                 | Purpose                                           | Missing Work                                        |
| --------------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `BaseLayer-Venomoth-dedicated-vm`       | Dedicated VM per browser session control.         | Dedicated VM orchestration.                         |
| `BaseLayer-Diglett-paused-microvm-pool` | Pre-spawned paused Firecracker VMs.               | Reusable paused-microVM pool in the orchestrator.   |
| `BaseLayer-Dugtrio-unikraft-standby`    | Kernel-style unikernel standby comparison.        | Unikraft package and lifecycle integration.         |
| `BaseLayer-Meowth-lightpanda-runtime`   | Lightpanda-backed session runtime.                | Node-agent session lifecycle integration.           |
| `BaseLayer-Persian-managed-ksm-cow`     | Managed density with host KSM/CoW profile layers. | Host setup and profile-layer clone/discard support. |


## Suggested Runs

Managed density:

```bash
BENCH_PROFILE_IDS="BaseLayer-Charizard-managed-node,BaseLayer-Venusaur-managed-cold-node,BaseLayer-Squirtle-managed-dense-384mb,BaseLayer-Wartortle-managed-large-shm" \
BENCH_MAX_SESSIONS="150" \
BENCH_CONCURRENCY_VALUES="25,50,75,100,125,150" \
npm run bench:density
```

Firecracker memory and vCPU:

```bash
BENCH_ENABLE_FIRECRACKER=1 \
BENCH_PROFILE_IDS="BaseLayer-Mew-firecracker-headless-shell,BaseLayer-Blastoise-firecracker-slim-512,BaseLayer-Caterpie-firecracker-slim-384,BaseLayer-Metapod-firecracker-one-vcpu" \
BENCH_FIRECRACKER_MAX_SESSIONS="32" \
BENCH_FIRECRACKER_MAX_MICROVM_COUNT="32" \
BENCH_CONCURRENCY_VALUES="8,16,24,32" \
npm run bench:density
```

Firecracker warm-level:

```bash
BENCH_ENABLE_FIRECRACKER=1 \
BENCH_PROFILE_IDS="BaseLayer-Mew-firecracker-headless-shell,BaseLayer-Butterfree-firecracker-cdp-warm,BaseLayer-Weedle-firecracker-context-warm,BaseLayer-Kakuna-firecracker-no-warm" \
npm run bench:latency
```

Full Chromium compatibility:

```bash
FIRECRACKER_BROWSER_PROFILE=chromium sudo bash ./scripts/firecracker/build-headless-shell-rootfs.sh
BENCH_ENABLE_FIRECRACKER=1 \
BENCH_PROFILE_IDS="BaseLayer-Mew-firecracker-headless-shell,BaseLayer-Mewtwo-full-chromium,BaseLayer-Beedrill-full-chromium-512" \
BENCH_FIRECRACKER_MAX_SESSIONS="1" \
BENCH_FIRECRACKER_MAX_MICROVM_COUNT="1" \
npm run bench:latency
```

Fluid CPU retest:

```bash
BENCH_ENABLE_FIRECRACKER=1 \
BENCH_PROFILE_IDS="BaseLayer-Mew-firecracker-headless-shell,BaseLayer-Pidgeotto-fluid-hybrid,BaseLayer-Pidgeot-fluid-always" \
BENCH_FIRECRACKER_MAX_SESSIONS="24" \
BENCH_FIRECRACKER_MAX_MICROVM_COUNT="24" \
BENCH_CONCURRENCY_VALUES="12,24" \
npm run bench:density
```

Create-path and density retest:

```bash
BENCH_ENABLE_FIRECRACKER=1 \
BENCH_PROFILE_IDS="BaseLayer-Mew-firecracker-headless-shell,BaseLayer-Rattata-fast-slot-reuse,BaseLayer-Raticate-density-512-1vcpu,BaseLayer-Spearow-fluid-density" \
BENCH_FIRECRACKER_MAX_SESSIONS="24" \
BENCH_FIRECRACKER_MAX_MICROVM_COUNT="24" \
BENCH_CONCURRENCY_VALUES="1,16,24" \
npm run bench:density
```

Expected read:

- `BaseLayer-Rattata-fast-slot-reuse` should mainly improve create/launch time. If it does not, the create bottleneck is not the fixed helper cleanup grace.
- `BaseLayer-Raticate-density-512-1vcpu` should improve packing, but it may worsen navigation tails if the page workload is CPU-bound.
- `BaseLayer-Spearow-fluid-density` is only worth keeping if it beats `BaseLayer-Raticate` on navigation tail without materially worsening create.

Bursty agent-session retest:

```bash
BENCH_ENABLE_FIRECRACKER=1 \
BENCH_WORKLOAD_MODE="bursty" \
BENCH_BURST_COUNT="4" \
BENCH_BURST_ROUNDS="2" \
BENCH_BURST_IDLE_MS="5000" \
BENCH_BURST_STAGGER_MS="250" \
BENCH_PROFILE_IDS="BaseLayer-Raticate-density-512-1vcpu,BaseLayer-Spearow-fluid-density" \
BENCH_FIRECRACKER_MAX_SESSIONS="48" \
BENCH_FIRECRACKER_MAX_MICROVM_COUNT="48" \
BENCH_CONCURRENCY_VALUES="16,24,32,48" \
npm run bench:density
```

Manual async and custom-shell screening:

```bash
BENCH_ENABLE_FIRECRACKER=1 \
BENCH_PROFILE_IDS="BaseLayer-Mew-firecracker-headless-shell,BaseLayer-Poliwag-async-manual-gengar,BaseLayer-Poliwhirl-async-manual-dragonite,BaseLayer-Abra-custom-shell-baseline,BaseLayer-Kadabra-custom-shell-startup-prune,BaseLayer-Alakazam-custom-shell-async-manual" \
BENCH_CONCURRENCY_VALUES="1,16,24" \
npm run bench:density
```
