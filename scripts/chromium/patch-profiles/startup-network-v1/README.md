# startup-network-v1

This patch profile is the first custom-Chromium build lane for BaseLayer.

Intent:

- make a dedicated `chrome-headless-shell` build instead of relying only on runtime flags
- keep build-time stripping focused on headless-only operation
- provide a stable place for future Chromium source patches related to:
  - startup-default pruning
  - generic network-default behavior
  - headless-only subsystem disablement

## Applied patches

| File | Purpose |
|------|---------|
| `001-baselayer-headless-shell-h.patch` | Inserts a marker comment in `headless/public/headless_shell.h` after the `content_main.h` include so builds using this profile are provably patched (and the profile README is referenced from source). |

`build-custom-headless-shell.sh` applies every `*.patch` in this directory with `git apply` (after `git apply --check`). On success, `baselayer-build-metrics.json` includes **`patchStatus`** (`git-apply`), ordered **`patchFiles`**, and **`chromiumRevision`**.

## GN / build configuration

The active optimization in this profile is still primarily the dedicated GN/build configuration from `scripts/chromium/gn/headless-minimal-v1.args.gn` (or whichever `BASELAYER_CHROMIUM_GN_PROFILE` you set).

## Validation

Chromium revisions drift; revalidate `git apply` against the exact `src` revision on your benchmark host before treating a patch as production-safe. The hunks in `001-baselayer-headless-shell-h.patch` are aligned with `main` as of when the patch was authored (see `headless/public/headless_shell.h` on [Chromium](https://chromium.googlesource.com/chromium/src/+/main/headless/public/headless_shell.h)).

From the `os-browser` repo root, without mutating the checkout:

`bash scripts/chromium/verify-patch-profile-apply.sh /path/to/chromium/src`

## Roadmap (real optimizations vs marker)

Runtime flags and rootfs/launch settings stay outside Chromium. To ship **real** startup/network/profile optimizations in this profile, add small reversible `NNN-description.patch` files (see naming in your internal plan) that change headless startup code paths—for example under `headless/app/`, `headless/lib/`, and related `headless_browser_main_parts`—then re-run `git apply --check` on the **exact** checkout you build. `build-custom-headless-shell.sh` records **`patchFiles`** (ordered basenames) and **`chromiumRevision`** in `baselayer-build-metrics.json` so benchmark runs can be tied to a revision + patch set.
