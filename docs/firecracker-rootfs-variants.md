# Firecracker Rootfs Variants

Use image variants to separate benchmark-safe runs from diagnostic runs. Do not rebuild one ad hoc image with heavy tracing and then compare it directly against prior benchmark numbers.

## Output Naming

`scripts/firecracker/build-headless-shell-rootfs.sh` now supports:

- `FIRECRACKER_ROOTFS_VARIANT_SUFFIX`
- `FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE`

Examples:

- baseline headless-shell: `artifacts/firecracker/rootfs.ext4`
- kernel-inspired goto variant: `artifacts/firecracker/rootfs-kernel-goto.ext4`
- kernel-inspired goto-lite variant: `artifacts/firecracker/rootfs-kernel-goto-lite.ext4`
- kernel feature-prune variant: `artifacts/firecracker/rootfs-kernel-feature-prune.ext4`
- kernel startup-prune variant: `artifacts/firecracker/rootfs-kernel-startup-prune.ext4`
- kernel startup-prune + automation/background switches: `artifacts/firecracker/rootfs-kernel-startup-prune-automation.ext4`
- kernel startup-prune + network-calm switches: `artifacts/firecracker/rootfs-kernel-startup-prune-network-calm.ext4`
- kernel balanced variant: `artifacts/firecracker/rootfs-kernel-balanced.ext4`
- kernel-inspired goto + guest IPv6-off variant: `artifacts/firecracker/rootfs-kernel-goto-ipv6off.ext4`
- low-overhead netlog image: `artifacts/firecracker/rootfs-netlog.ext4`
- startup-trace image: `artifacts/firecracker/rootfs-startup.ext4`
- full Chromium image still uses `rootfs-chromium*.ext4`

Additional builder inputs:

- `FIRECRACKER_CHROME_LAUNCH_PROFILE`
  - `baseline`
  - `kernel-goto`
  - `kernel-goto-lite`
  - `kernel-feature-prune`
  - `kernel-startup-prune`
  - `kernel-startup-prune-automation`
  - `kernel-startup-prune-network-calm`
  - `kernel-balanced`
- `FIRECRACKER_GUEST_DISABLE_IPV6`
  - `0`
  - `1`
- `FIRECRACKER_ROOTFS_BUILD_METRICS_PATH`
  - optional per-rootfs metrics output path
- `FIRECRACKER_APT_SECURITY_MIRROR` (default `http://security.ubuntu.com/ubuntu`)
  - security suite line in the guest `sources.list`; set to match `FIRECRACKER_DEBOOTSTRAP_MIRROR` when using a full mirror, or for offline/airgapped layouts
- `PLAYWRIGHT_CACHE_FIND_MAXDEPTH` (default `12`)
  - bounds `find` depth when locating Playwright `chrome-headless-shell` / Chromium under `~/.cache/ms-playwright`, so large caches do not trigger a full-tree scan every build (the builder tries Playwright’s stable directory globs first, then `find`)
- `FIRECRACKER_ROOTFS_SKIP_HOST_APT` (default `0`; set to `1` to skip)
  - skips `apt-get update` and `apt-get install` for `debootstrap`, `e2fsprogs`, and `rsync` on the host. Use only when those tools are already installed (for example repeated variant batches on the same CI runner). The script verifies `debootstrap`, `mkfs.ext4`, and `rsync` exist before continuing.

## Minbase chroot cache (large speedup for variant batches)

Repeated `debootstrap` + chroot `apt` is the dominant cost when building many `.ext4` images. The rootfs script can **save** a tarball of the minbase tree (Ubuntu noble minbase plus the fixed package set and font cache) **before** copying the browser in, then **restore** it on later runs instead of bootstrapping again.

- `FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR` — path to the tarball (for example `artifacts/firecracker/cache/noble-minbase-chroot.tar.gz`). Parent directories are created as needed.
- `FIRECRACKER_ROOTFS_SAVE_CHROOT_CACHE=1` — on a **full** build (not using cache), after `font-cache` and before `browser-sync`, unmount bind mounts, write the tarball with GNU `tar -caf` (compression inferred from the extension), then remount. **Requires GNU tar.**
- `FIRECRACKER_ROOTFS_USE_CHROOT_CACHE=1` — if the tarball exists, extract it into the temp chroot and **skip** `debootstrap`, chroot `apt` update/install, and `font-cache`. Then continue with `browser-sync` as usual.

**Invalidation:** delete the tarball if you change `DEBOOTSTRAP_MIRROR`, `FIRECRACKER_APT_SECURITY_MIRROR`, Ubuntu suite, or the chroot package list in the script.

`scripts/bench/build-firecracker-rootfs-variants.sh` enables this by default: the **first** variant run creates `artifacts/firecracker/cache/noble-minbase-chroot.tar.gz` (unless disabled); runs **2…N** set `FIRECRACKER_ROOTFS_USE_CHROOT_CACHE=1` and `FIRECRACKER_ROOTFS_SKIP_HOST_APT=1`. Override the path with `FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR`.

- `FIRECRACKER_ROOTFS_VARIANTS_DISABLE_CHROOT_CACHE=1` — run every variant as a **full** debootstrap (no save, no reuse). Use when debugging the bootstrap path or after changing mirror/packages.

## Instrumentation Profiles

- `none`
  - benchmark-safe default
  - no extra tracing/netlog flags baked into the guest launcher

- `netlog-lite`
  - bakes in `--log-net-log=/var/log/chrome-netlog.json`
  - use for low-overhead network attribution runs

- `startup-lite`
  - bakes in netlog plus a short startup trace
  - use for c1 diagnostics only unless proven safe at density

- `debug-heavy`
  - bakes in netlog, longer startup trace, and `--vmodule`
  - diagnostic only; do not use for benchmark claims

## Recommended Usage

- Real benchmark / leaderboard-parity runs:
  - use `rootfs.ext4`

- Low-overhead network investigation:
  - use `rootfs-netlog.ext4`
  - prefer c1 first, then optionally c24

- Startup/renderer investigation:
  - use `rootfs-startup.ext4`
  - prefer c1 only

## Build Helper

Build the baseline plus the two safe diagnostic variants:

```bash
bash scripts/bench/build-firecracker-rootfs-variants.sh
```

This produces:

- `artifacts/firecracker/rootfs.ext4`
- `artifacts/firecracker/rootfs-kernel-goto.ext4`
- `artifacts/firecracker/rootfs-kernel-goto-lite.ext4`
- `artifacts/firecracker/rootfs-kernel-feature-prune.ext4`
- `artifacts/firecracker/rootfs-kernel-startup-prune.ext4`
- `artifacts/firecracker/rootfs-kernel-startup-prune-automation.ext4`
- `artifacts/firecracker/rootfs-kernel-startup-prune-network-calm.ext4`
- `artifacts/firecracker/rootfs-kernel-balanced.ext4`
- `artifacts/firecracker/rootfs-kernel-goto-ipv6off.ext4`
- `artifacts/firecracker/rootfs-netlog.ext4`
- `artifacts/firecracker/rootfs-startup.ext4`
- per-rootfs metrics JSON files under `artifacts/firecracker/rootfs-build-metrics/`
- aggregate metrics index at `artifacts/firecracker/rootfs-build-metrics/index.json`

## Build Metrics

Each rootfs build emits a structured JSON summary (default `artifacts/firecracker/<rootfs>.ext4.metrics.json`, or `FIRECRACKER_ROOTFS_BUILD_METRICS_PATH`):

- `kind`: `baselayer-firecracker-rootfs-build-metrics-v1`
- `generatedAt`: UTC ISO-8601 timestamp
- `status`, `failureStage`
- `rootfsPath`, `artifactDir`, `browserProfile`, `launchProfile`, `instrumentationProfile`, `rootfsVariantSuffix`, `guestDisableIpv6`, `debootstrapMirror`
- `chrootCacheTar`, `chrootCacheUsed`, `chrootCacheSaved` — tarball path and whether restore/save timings were non-zero
- `timingsMs`: millisecond durations for `hostAptUpdate`, `hostAptInstall`, `debootstrap`, `chrootAptUpdate`, `chrootAptInstall`, `chrootCacheRestore`, `chrootCacheSave`, `fontCache`, `browserSync`, `scriptInstall`, `ext4Create`, `rootfsCopy`, `total`

The `EXIT` trap writes metrics even on failure so partial timings remain useful.

## Variant metrics index

`scripts/bench/build-firecracker-rootfs-variants.sh` writes `artifacts/firecracker/rootfs-build-metrics/index.json` with:

- `kind`: `baselayer-rootfs-variants-index-v1`
- `generatedAt`
- `metricsDir` (absolute path)
- `metricsFiles`: list of per-variant JSON filenames (includes custom-shell entries when `FIRECRACKER_HEADLESS_SHELL_PATH_CUSTOM` was set for that run)
