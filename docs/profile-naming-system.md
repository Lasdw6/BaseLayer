# BaseLayer Profile Naming System

This file is the canonical profile registry and naming policy for BaseLayer benchmark/runtime profiles.

## Rules

- Canonical profile IDs use the format `BaseLayer-<Gen1Pokemon>-<details>`.
- Legacy `profile-*` IDs are retained as compatibility aliases in the benchmark parser, but they are no longer canonical.
- Historical result docs and artifact paths may continue to mention legacy IDs. New docs, commands, and profile additions should use the canonical names.
- The primary assigned profiles refer to the **fastest reliable configurations** of those families. Operational script defaults that temporarily force a slower diagnostic mode, such as sync delete, do **not** redefine the canonical profile.
- When a profile family is superseded but still worth keeping for traceability, archive it under `BaseLayerA-<Pokemon>-...` in docs. Do not reuse a live canonical name for two active profiles at once.

## Reserved Main Names

These are the top-level profile family names. The requested swaps are applied here:

| Reserved name | Current assignment | Notes |
|---|---|---|
| `BaseLayer-Mew-*` | overall best main profile | Swapped with the earlier Charizard draft slot. |
| `BaseLayer-Charizard-*` | managed-node primary family | Takes the earlier Mew draft slot. |
| `BaseLayer-Gengar-*` | best current experimental Chromium/Firecracker lane | Current winner is startup-prune. |
| `BaseLayer-Mewtwo-*` | full Chromium compatibility lane | Swapped with the earlier Dragonite draft slot. |
| `BaseLayer-Dragonite-*` | balanced aggressive experimental lane | Takes the earlier Mewtwo draft slot. |

## Main Assigned Profiles

| Canonical profile | Legacy ID | Status | Summary | Full spec |
|---|---|---|---|---|
| `BaseLayer-Mew-firecracker-headless-shell` | `profile-c-firecracker-snapshot` | main default | Firecracker + `chromium-headless-shell`, `1 vCPU`, `1024 MB`, **async delete**. This is the canonical fastest reliable Mew configuration; sync-delete runs are diagnostics, not the primary profile. | [current-best-profiles.md](./current-best-profiles.md), [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Charizard-managed-node` | `profile-b-optimized-node` | active | Browser-aware managed multi-session node baseline outside the Firecracker lane. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Gengar-kernel-startup-prune` | `profile-bz-firecracker-kernel-startup-prune` | experimental active | Best current same-host API result from the Kernel-inspired Firecracker sweep. | [current-best-profiles.md](./current-best-profiles.md), [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md) |
| `BaseLayer-Mewtwo-full-chromium` | `profile-o-firecracker-full-chromium` | experimental active | Full Chromium guest lane for compatibility-heavy workloads. | [current-best-profiles.md](./current-best-profiles.md), [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Dragonite-kernel-balanced` | `profile-ca-firecracker-kernel-balanced` | experimental active | Balanced Kernel-inspired launch bundle: startup pruning plus curated feature pruning. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md), [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |

## Supported Runnable Profiles

| Canonical profile | Legacy ID | Mode | Short description | Full spec |
|---|---|---|---|---|
| `BaseLayer-Bulbasaur-generic-container` | `profile-a-generic-container` | baseline | Generic container worker reference profile. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Charizard-managed-node` | `profile-b-optimized-node` | managed | Browser-aware node agent with warm-pool and admission logic. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Mew-firecracker-headless-shell` | `profile-c-firecracker-snapshot` | firecracker | Main Firecracker snapshot profile. | [BENCHMARKS.md](./BENCHMARKS.md), [current-best-profiles.md](./current-best-profiles.md) |
| `BaseLayer-Ivysaur-firecracker-vanilla` | `profile-d-firecracker-vanilla` | firecracker | Minimally tuned Firecracker/Chrome comparison profile. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Venusaur-managed-cold-node` | `profile-f-managed-cold-node` | managed | Warm-pool-disabled cold burst profile. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Squirtle-managed-dense-384mb` | `profile-g-managed-dense-384mb` | managed | Lower-memory managed density profile. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Wartortle-managed-large-shm` | `profile-h-managed-large-shm` | managed | Managed compatibility profile with larger `/dev/shm`. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Blastoise-firecracker-slim-512` | `profile-i-firecracker-slim-512` | firecracker | `512 MB` Firecracker memory experiment. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Caterpie-firecracker-slim-384` | `profile-j-firecracker-slim-384` | firecracker | `384 MB` lower-bound memory experiment. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Metapod-firecracker-one-vcpu` | `profile-k-firecracker-one-vcpu` | firecracker | One-vCPU Firecracker packing experiment. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Butterfree-firecracker-cdp-warm` | `profile-l-firecracker-cdp-warm` | firecracker | CDP-ready warm snapshot control. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Weedle-firecracker-context-warm` | `profile-m-firecracker-context-warm` | firecracker | Warmed Playwright context experiment. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Kakuna-firecracker-no-warm` | `profile-n-firecracker-no-warm` | firecracker | No warm-page snapshot control. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Mewtwo-full-chromium` | `profile-o-firecracker-full-chromium` | firecracker | Full Chromium guest. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md), [current-best-profiles.md](./current-best-profiles.md) |
| `BaseLayer-Beedrill-full-chromium-512` | `profile-p-firecracker-full-chromium-512` | firecracker | Full Chromium guest at `512 MB`. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Pidgey-network-validate` | `profile-q-firecracker-network-validate` | firecracker | Network-slot validation overhead profile. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Pidgeotto-fluid-hybrid` | `profile-r-firecracker-fluid-hybrid` | firecracker | Hybrid fluid-compute CPU policy. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md), [current-best-profiles.md](./current-best-profiles.md) |
| `BaseLayer-Pidgeot-fluid-always` | `profile-s-firecracker-fluid-always` | firecracker | Always-on fluid-compute CPU policy. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md), [current-best-profiles.md](./current-best-profiles.md) |
| `BaseLayer-Rattata-fast-slot-reuse` | `profile-x-firecracker-fast-slot-reuse` | firecracker | Faster clean-slot reuse experiment. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Raticate-density-512-1vcpu` | `profile-y-firecracker-density-512-1vcpu` | firecracker | `512 MB` + `1 vCPU` density lane. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Spearow-fluid-density` | `profile-z-firecracker-fluid-density` | firecracker | Density lane with hybrid fluid CPU policy. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md), [current-best-profiles.md](./current-best-profiles.md) |
| `BaseLayer-Fearow-density-navcap-12` | `profile-ba-firecracker-density-navcap-12` | firecracker | Density lane with active-navigation cap 12. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Ekans-density-navcap-16` | `profile-bb-firecracker-density-navcap-16` | firecracker | Density lane with active-navigation cap 16. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Arbok-density-navcap-20` | `profile-bc-firecracker-density-navcap-20` | firecracker | Density lane with active-navigation cap 20. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Pikachu-density-mem1536` | `profile-bd-firecracker-density-mem1536` | firecracker | Density lane with `1536 MB` guest RAM. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Raichu-density-mem1280` | `profile-bi-firecracker-density-mem1280` | firecracker | Density lane with `1280 MB` guest RAM. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Sandshrew-density-mem1792` | `profile-bj-firecracker-density-mem1792` | firecracker | Density lane with `1792 MB` guest RAM. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Sandslash-density-mem2048` | `profile-bk-firecracker-density-mem2048` | firecracker | Density lane with `2048 MB` guest RAM. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Nidoran-F-density-navcap16-mem1536` | `profile-be-firecracker-density-navcap16-mem1536` | firecracker | Density lane with nav-cap 16 and `1536 MB`. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Nidorina-density-navcap16-mem2048` | `profile-bl-firecracker-density-navcap16-mem2048` | firecracker | Density lane with nav-cap 16 and `2048 MB`. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Nidoqueen-fluid-density-navcap-16` | `profile-bf-firecracker-fluid-density-navcap-16` | firecracker | Fluid density lane with nav-cap 16. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Nidoran-M-fluid-density-cgroups` | `profile-bg-firecracker-fluid-density-cgroups` | firecracker | Fluid density lane with cgroup-backed CPU controls. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Nidorino-density-launch-cap-12` | `profile-bh-firecracker-density-launch-cap-12` | firecracker | Density lane with launch concurrency cap 12. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Nidoking-density-navcap-8` | `profile-bm-firecracker-density-navcap-8` | firecracker | Density lane with strict nav-cap 8. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Clefairy-2vcpu-navcap-12` | `profile-bn-firecracker-2vcpu-navcap-12` | firecracker | Two-vCPU density lane with nav-cap 12. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Clefable-2vcpu-navcap-16` | `profile-bo-firecracker-2vcpu-navcap-16` | firecracker | Two-vCPU density lane with nav-cap 16. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Vulpix-density-cdp-warm` | `profile-bp-firecracker-density-cdp-warm` | firecracker | Density lane with CDP-only warm snapshot. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Ninetales-density-context-warm` | `profile-bq-firecracker-density-context-warm` | firecracker | Density lane with warmed context snapshot. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Jigglypuff-density-target-warm` | `profile-br-firecracker-density-target-warm` | firecracker | Density lane with target-warm snapshot. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Wigglytuff-density-blank-warm` | `profile-bs-firecracker-density-blank-warm` | firecracker | Density lane with blank-page warm snapshot. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Zubat-density-cdp-warm-navcap-8` | `profile-bt-firecracker-density-cdp-warm-navcap-8` | firecracker | CDP-warm density lane with nav-cap 8. | [BENCHMARKS.md](./BENCHMARKS.md) |
| `BaseLayer-Oddish-kernel-goto` | `profile-bu-firecracker-kernel-goto` | firecracker | Broad Kernel-inspired launch-flag bundle. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md) |
| `BaseLayer-Gloom-kernel-goto-lite` | `profile-bx-firecracker-kernel-goto-lite` | firecracker | Narrower Kernel-inspired launch subset. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md) |
| `BaseLayer-Vileplume-kernel-feature-prune` | `profile-by-firecracker-kernel-feature-prune` | firecracker | Feature-prune-only Kernel-inspired bundle. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md) |
| `BaseLayer-Gengar-kernel-startup-prune` | `profile-bz-firecracker-kernel-startup-prune` | firecracker | Startup/service-prune Kernel-inspired winner. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md), [current-best-profiles.md](./current-best-profiles.md) |
| `BaseLayer-Machop-gengar-automation-navcap-16` | `profile-bz2-firecracker-gengar-automation-navcap-16` | firecracker | Gengar plus conservative automation/background switches and active-navigation cap 16. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md), [goto-optimization-deep-plan.md](./goto-optimization-deep-plan.md) |
| `BaseLayer-Machoke-gengar-network-calm-navcap-16` | `profile-bz3-firecracker-gengar-network-calm-navcap-16` | firecracker | Gengar plus automation switches, DNS prefetch disable, small predictor prune, and active-navigation cap 16. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md), [goto-optimization-deep-plan.md](./goto-optimization-deep-plan.md) |
| `BaseLayer-Paras-kernel-goto-ipv6off` | `profile-bv-firecracker-kernel-goto-ipv6off` | firecracker | Kernel-inspired bundle with guest IPv6 disabled. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md) |
| `BaseLayer-Dragonite-kernel-balanced` | `profile-ca-firecracker-kernel-balanced` | firecracker | Balanced Kernel-inspired startup + feature prune bundle. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md) |
| `BaseLayer-Parasect-kernel-goto-cdp-warm` | `profile-bw-firecracker-kernel-goto-cdp-warm` | firecracker | Kernel-inspired bundle stacked with CDP warm snapshot. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md) |
| `BaseLayer-Krabby-kernel-startup-prune-lite` | n/a | firecracker | Tighter follow-up to Gengar using only the lowest-risk startup/service pruning subset. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md) |
| `BaseLayer-Kingler-kernel-balanced-lite` | n/a | firecracker | Tighter follow-up to Dragonite with a smaller balanced feature-prune set. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md) |
| `BaseLayer-Horsea-async-gengar-merge` | n/a | firecracker | Async-parity merge candidate combining Mew runtime semantics with Gengar's rootfs. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md) |
| `BaseLayer-Seadra-async-dragonite-merge` | n/a | firecracker | Async-parity merge candidate combining Mew runtime semantics with Dragonite's rootfs. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md) |
| `BaseLayer-Goldeen-async-gloom-merge` | n/a | firecracker | Async-parity merge candidate combining Mew runtime semantics with Gloom's rootfs. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md) |
| `BaseLayer-Poliwag-async-manual-gengar` | n/a | firecracker | Manual async-parity integration baked into a dedicated Gengar-style rootfs, instead of a stacked merge profile. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md) |
| `BaseLayer-Poliwhirl-async-manual-dragonite` | n/a | firecracker | Manual async-parity integration baked into a dedicated Dragonite-style rootfs, instead of a stacked merge profile. | [kernel-inspired-firecracker-profiles.md](./kernel-inspired-firecracker-profiles.md) |
| `BaseLayer-Staryu-custom-shell-startup-network` | n/a | firecracker | Custom-built `chrome-headless-shell` baseline lane for build-level startup/network experiments. | [custom-headless-shell-build.md](./custom-headless-shell-build.md) |
| `BaseLayer-Starmie-async-custom-shell-merge` | n/a | firecracker | Manual async-parity custom-shell lane on the main Mew runtime semantics. | [custom-headless-shell-build.md](./custom-headless-shell-build.md) |
| `BaseLayer-Abra-custom-shell-baseline` | n/a | firecracker | Direct custom-shell baseline A/B lane. | [custom-headless-shell-build.md](./custom-headless-shell-build.md) |
| `BaseLayer-Kadabra-custom-shell-startup-prune` | n/a | firecracker | Custom-shell lane with startup-prune launch profile. | [custom-headless-shell-build.md](./custom-headless-shell-build.md) |
| `BaseLayer-Alakazam-custom-shell-async-manual` | n/a | firecracker | Custom-shell manual async-parity lane using a dedicated async-manual rootfs. | [custom-headless-shell-build.md](./custom-headless-shell-build.md) |

## Planned Profiles

| Canonical profile | Legacy ID | Status | Short description | Full spec |
|---|---|---|---|---|
| `BaseLayer-Venomoth-dedicated-vm` | `profile-e-dedicated-vm` | planned | Dedicated VM per browser session control profile. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Diglett-paused-microvm-pool` | `profile-t-paused-microvm-pool` | planned | Pre-spawned paused Firecracker VM pool. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Dugtrio-unikraft-standby` | `profile-u-unikraft-standby` | planned | Unikraft/unikernel standby comparison lane. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |
| `BaseLayer-Meowth-lightpanda-runtime` | `profile-v-lightpanda-runtime` | planned/experimental lane | Lightpanda runtime lane for compatibility-limited fast-path work. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md), [current-best-profiles.md](./current-best-profiles.md) |
| `BaseLayer-Persian-managed-ksm-cow` | `profile-w-managed-ksm-cow` | planned | Managed density lane with host KSM/CoW profile layers. | [experimental-benchmark-profiles.md](./experimental-benchmark-profiles.md) |

## Command Guidance

- Prefer the canonical `BaseLayer-*` profile IDs in `BENCH_PROFILE_IDS`.
- Legacy `profile-*` IDs still resolve, but they should be treated as deprecated aliases.
- When reporting benchmark results, write the canonical name first and optionally include the legacy ID once in parentheses if historical continuity matters.
