#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
ARTIFACT_DIR="${FIRECRACKER_ARTIFACT_DIR:-$ROOT/artifacts/firecracker}"
BROWSER_PROFILE="${FIRECRACKER_BROWSER_PROFILE:-optimized}"
ROOTFS_VARIANT_SUFFIX="${FIRECRACKER_ROOTFS_VARIANT_SUFFIX:-}"
if [ "$BROWSER_PROFILE" = "vanilla" ]; then
  ROOTFS_BASENAME="rootfs-vanilla"
elif [ "$BROWSER_PROFILE" = "chromium" ]; then
  ROOTFS_BASENAME="rootfs-chromium"
else
  ROOTFS_BASENAME="rootfs"
fi
if [ -n "$ROOTFS_VARIANT_SUFFIX" ]; then
  ROOTFS_BASENAME="$ROOTFS_BASENAME-$ROOTFS_VARIANT_SUFFIX"
fi
DEFAULT_ROOTFS_PATH="$ARTIFACT_DIR/$ROOTFS_BASENAME.ext4"
ROOTFS_PATH="${FIRECRACKER_ROOTFS_PATH:-$DEFAULT_ROOTFS_PATH}"
ROOTFS_BUILD_METRICS_PATH="${FIRECRACKER_ROOTFS_BUILD_METRICS_PATH:-$ROOTFS_PATH.metrics.json}"
ROOTFS_DEBUG_LOG_PATH="${FIRECRACKER_ROOTFS_DEBUG_LOG_PATH:-$ROOTFS_PATH.debug.log}"
ROOTFS_KEEP_FAILED_CHROOT="${FIRECRACKER_ROOTFS_KEEP_FAILED_CHROOT:-0}"
ROOTFS_SIZE_MB="${FIRECRACKER_ROOTFS_SIZE_MB:-4096}"
USE_HOST_PROXY="${FIRECRACKER_BROWSER_USE_HOST_PROXY:-0}"
HOST_PROXY_PORT="${FIRECRACKER_PROXY_PORT:-3128}"
HOST_UNAME_M="$(uname -m)"
case "$HOST_UNAME_M" in
  x86_64)
    ROOTFS_ARCH="amd64"
    ;;
  aarch64|arm64)
    ROOTFS_ARCH="arm64"
    ;;
  *)
    echo "Unsupported host architecture for rootfs build: $HOST_UNAME_M" >&2
    exit 1
    ;;
esac
DEFAULT_DEBOOTSTRAP_MIRROR="http://archive.ubuntu.com/ubuntu/"
DEFAULT_APT_SECURITY_MIRROR="http://security.ubuntu.com/ubuntu"
if [ "$ROOTFS_ARCH" = "arm64" ]; then
  DEFAULT_DEBOOTSTRAP_MIRROR="http://ports.ubuntu.com/ubuntu-ports/"
  DEFAULT_APT_SECURITY_MIRROR="http://ports.ubuntu.com/ubuntu-ports"
fi
DEBOOTSTRAP_MIRROR="${FIRECRACKER_DEBOOTSTRAP_MIRROR:-$DEFAULT_DEBOOTSTRAP_MIRROR}"
# Override when your primary mirror also serves security, or for offline mirrors.
APT_SECURITY_MIRROR="${FIRECRACKER_APT_SECURITY_MIRROR:-$DEFAULT_APT_SECURITY_MIRROR}"
DEBOOTSTRAP_FALLBACK_MIRRORS="${FIRECRACKER_DEBOOTSTRAP_FALLBACK_MIRRORS:-}"
UBUNTU_SUITE="${FIRECRACKER_UBUNTU_SUITE:-noble}"
INSTRUMENTATION_PROFILE="${FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE:-none}"
LAUNCH_PROFILE="${FIRECRACKER_CHROME_LAUNCH_PROFILE:-baseline}"
GUEST_DISABLE_IPV6="${FIRECRACKER_GUEST_DISABLE_IPV6:-0}"
PLAYWRIGHT_CACHE_DIR="${PLAYWRIGHT_CACHE_DIR:-$HOME/.cache/ms-playwright}"
# Limit find(1) depth so large Playwright caches do not scan the whole tree on every build.
PLAYWRIGHT_CACHE_FIND_MAXDEPTH="${PLAYWRIGHT_CACHE_FIND_MAXDEPTH:-12}"
# Optional minbase reuse: save tarball after font-cache on a full build; later runs extract and skip debootstrap/apt.
# Requires GNU tar (compression auto-detected via -a). Invalidate the tarball if mirror, suite, or package list changes.
FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR="${FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR:-}"
FIRECRACKER_ROOTFS_USE_CHROOT_CACHE="${FIRECRACKER_ROOTFS_USE_CHROOT_CACHE:-0}"
FIRECRACKER_ROOTFS_SAVE_CHROOT_CACHE="${FIRECRACKER_ROOTFS_SAVE_CHROOT_CACHE:-0}"
if [ -n "${SUDO_USER:-}" ]; then
  SUDO_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
else
  SUDO_HOME=""
fi
HEADLESS_SHELL_PATH="${FIRECRACKER_HEADLESS_SHELL_PATH:-}"
CHROMIUM_PATH="${FIRECRACKER_CHROMIUM_PATH:-}"
# Optional explicit override. When set, the browser-sync stage rsyncs this
# directory wholesale instead of guessing from the binary path. Required
# when the custom `headless_shell` binary lives in a subdir of its build
# out/ dir (e.g. `out/.../headless_shell/headless_shell`) with Chromium
# runtime resources (`icudtl.dat`, `*.pak`, etc.) at the parent.
BROWSER_ASSETS_DIR_OVERRIDE="${FIRECRACKER_BROWSER_ASSETS_DIR:-}"

# --- Rootfs cache manifest plumbing (used by save/restore paths) ---
# Bump when the cached chroot layout becomes incompatible with previous
# cache tarballs (e.g. package list changes, suite default changes).
CACHE_MANIFEST_SCHEMA_VERSION="1"
CACHE_MANIFEST_PATH_IN_CHROOT="/etc/baselayer-rootfs-cache.json"
# Each line is one dependency slot. For `*t64` glibc-2.38 transitions,
# the preferred (new) name is listed first and the legacy name second,
# separated by a space; `resolve_chroot_pkg` picks whichever is
# available inside the chroot. Keep this list sorted for hash stability.
PACKAGES_SPEC=$(cat <<'SPEC'
ca-certificates
fonts-dejavu-core
fonts-liberation
fonts-noto-color-emoji
fonts-noto-core
fontconfig
iproute2
libasound2t64 libasound2
libatk-bridge2.0-0t64 libatk-bridge2.0-0
libatk1.0-0t64 libatk1.0-0
libatspi2.0-0t64 libatspi2.0-0
libcairo2
libcups2t64 libcups2
libdbus-1-3
libdrm2
libgbm1
libglib2.0-0t64 libglib2.0-0
libgtk-3-0
libnspr4
libnss3
libpango-1.0-0
libx11-6
libx11-xcb1
libxcb1
libxcomposite1
libxdamage1
libxext6
libxfixes3
libxkbcommon0
libxrandr2
libxshmfence1
libxss1
netbase
socat
SPEC
)

compute_cache_packages_hash() {
  printf '%s\n' "schema=$CACHE_MANIFEST_SCHEMA_VERSION" "suite=$UBUNTU_SUITE" "arch=$ROOTFS_ARCH" \
    | cat - <(printf '%s\n' "$PACKAGES_SPEC") \
    | sha256sum \
    | awk '{print $1}'
}

now_ms() {
  if date +%s%3N >/dev/null 2>&1; then
    date +%s%3N
  else
    python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
  fi
}

TOTAL_START_MS="$(now_ms)"
CURRENT_STAGE="startup"
RUN_STATUS="failed"
HOST_APT_UPDATE_MS=0
HOST_APT_INSTALL_MS=0
DEBOOTSTRAP_MS=0
CHROOT_APT_UPDATE_MS=0
CHROOT_APT_INSTALL_MS=0
CHROOT_CACHE_RESTORE_MS=0
CHROOT_CACHE_SAVE_MS=0
FONT_CACHE_MS=0
BROWSER_SYNC_MS=0
SCRIPT_INSTALL_MS=0
EXT4_CREATE_MS=0
ROOTFS_COPY_MS=0
DEBOOTSTRAP_EXIT_CODE=0
LAST_ERROR_MESSAGE=""

write_metrics() {
  mkdir -p "$(dirname "$ROOTFS_BUILD_METRICS_PATH")"

  # Python reads os.environ only; export so payload fields are never silently empty.
  export NOW_MS="${NOW_MS:-$(now_ms)}"
  export ROOTFS_PATH ARTIFACT_DIR BROWSER_PROFILE LAUNCH_PROFILE INSTRUMENTATION_PROFILE
  export ROOTFS_VARIANT_SUFFIX GUEST_DISABLE_IPV6 DEBOOTSTRAP_MIRROR APT_SECURITY_MIRROR ROOTFS_BUILD_METRICS_PATH
  export ROOTFS_DEBUG_LOG_PATH
  export DEBOOTSTRAP_FALLBACK_MIRRORS
  export RUN_STATUS CURRENT_STAGE TOTAL_START_MS
  export HOST_APT_UPDATE_MS HOST_APT_INSTALL_MS DEBOOTSTRAP_MS CHROOT_APT_UPDATE_MS CHROOT_APT_INSTALL_MS
  export CHROOT_CACHE_RESTORE_MS CHROOT_CACHE_SAVE_MS
  export FONT_CACHE_MS BROWSER_SYNC_MS SCRIPT_INSTALL_MS EXT4_CREATE_MS ROOTFS_COPY_MS
  export FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR
  export DEBOOTSTRAP_EXIT_CODE LAST_ERROR_MESSAGE

  METRICS_PATH="$ROOTFS_BUILD_METRICS_PATH" python3 - <<'PY'
import json
import os
from datetime import datetime, timezone

def getenv_int(name: str) -> int:
    raw = os.environ.get(name, "0")
    try:
        return int(raw)
    except ValueError:
        return 0

payload = {
    "kind": "baselayer-firecracker-rootfs-build-metrics-v1",
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "status": os.environ.get("RUN_STATUS", "failed"),
    "failureStage": os.environ.get("CURRENT_STAGE", ""),
    "rootfsPath": os.environ.get("ROOTFS_PATH", ""),
    "artifactDir": os.environ.get("ARTIFACT_DIR", ""),
    "browserProfile": os.environ.get("BROWSER_PROFILE", ""),
    "launchProfile": os.environ.get("LAUNCH_PROFILE", ""),
    "instrumentationProfile": os.environ.get("INSTRUMENTATION_PROFILE", ""),
    "rootfsVariantSuffix": os.environ.get("ROOTFS_VARIANT_SUFFIX", ""),
    "guestDisableIpv6": os.environ.get("GUEST_DISABLE_IPV6", "0") == "1",
    "debootstrapMirror": os.environ.get("DEBOOTSTRAP_MIRROR", ""),
    "aptSecurityMirror": os.environ.get("APT_SECURITY_MIRROR", ""),
    "debootstrapFallbackMirrors": [m for m in os.environ.get("DEBOOTSTRAP_FALLBACK_MIRRORS", "").split() if m],
    "debugLogPath": os.environ.get("ROOTFS_DEBUG_LOG_PATH", ""),
    "debootstrapExitCode": getenv_int("DEBOOTSTRAP_EXIT_CODE"),
    "lastErrorMessage": os.environ.get("LAST_ERROR_MESSAGE", ""),
    "chrootCacheTar": os.environ.get("FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR", ""),
    "chrootCacheUsed": getenv_int("CHROOT_CACHE_RESTORE_MS") > 0,
    "chrootCacheSaved": getenv_int("CHROOT_CACHE_SAVE_MS") > 0,
    "timingsMs": {
        "hostAptUpdate": getenv_int("HOST_APT_UPDATE_MS"),
        "hostAptInstall": getenv_int("HOST_APT_INSTALL_MS"),
        "debootstrap": getenv_int("DEBOOTSTRAP_MS"),
        "chrootAptUpdate": getenv_int("CHROOT_APT_UPDATE_MS"),
        "chrootAptInstall": getenv_int("CHROOT_APT_INSTALL_MS"),
        "chrootCacheRestore": getenv_int("CHROOT_CACHE_RESTORE_MS"),
        "chrootCacheSave": getenv_int("CHROOT_CACHE_SAVE_MS"),
        "fontCache": getenv_int("FONT_CACHE_MS"),
        "browserSync": getenv_int("BROWSER_SYNC_MS"),
        "scriptInstall": getenv_int("SCRIPT_INSTALL_MS"),
        "ext4Create": getenv_int("EXT4_CREATE_MS"),
        "rootfsCopy": getenv_int("ROOTFS_COPY_MS"),
        "total": max(0, getenv_int("NOW_MS") - getenv_int("TOTAL_START_MS")),
    },
}

with open(os.environ["METRICS_PATH"], "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2)
PY
}

debootstrap_with_fallback() {
  local suite="$1"
  local target_dir="$2"
  local primary_mirror="$3"
  local attempted=()
  local fallback_list="$DEBOOTSTRAP_FALLBACK_MIRRORS"
  local default_archive="http://archive.ubuntu.com/ubuntu/"
  local mirror=""
  local debootstrap_log="$ROOTFS_DEBUG_LOG_PATH"
  local rc=0

  mkdir -p "$(dirname "$debootstrap_log")"
  : > "$debootstrap_log"

  if [ -n "$primary_mirror" ]; then
    attempted+=("$primary_mirror")
  fi
  if [ -n "$fallback_list" ]; then
    for mirror in $fallback_list; do
      attempted+=("$mirror")
    done
  fi
  case " ${attempted[*]} " in
    *" $default_archive "*) ;;
    *) attempted+=("$default_archive") ;;
  esac

  for mirror in "${attempted[@]}"; do
    CURRENT_STAGE="debootstrap"
    echo "[rootfs] debootstrap using mirror: $mirror"
    if sudo debootstrap --verbose --arch="$ROOTFS_ARCH" --variant=minbase "$suite" "$target_dir" "$mirror" >>"$debootstrap_log" 2>&1; then
      DEBOOTSTRAP_MIRROR="$mirror"
      DEBOOTSTRAP_EXIT_CODE=0
      LAST_ERROR_MESSAGE=""
      return 0
    fi

    rc=$?
    DEBOOTSTRAP_EXIT_CODE="$rc"
    LAST_ERROR_MESSAGE="debootstrap failed for mirror: $mirror"
    echo "[rootfs] debootstrap failed for mirror: $mirror" >&2
    echo "[rootfs] debootstrap exit code: $rc" >&2
    sudo rm -rf "$target_dir"
    sudo mkdir -p "$target_dir"
  done

  return 1
}

# Prefer stable Playwright layout globs (no tree walk); fall back to find for odd layouts.
pick_newest_path() {
  if [ "$#" -eq 0 ]; then
    return 1
  fi
  printf '%s\n' "$@" | sort | tail -n 1
}

resolve_headless_shell_in_cache() {
  local cache_dir="$1"
  local maxdepth="$2"
  local candidates=()
  local f
  shopt -s nullglob
  for f in \
    "$cache_dir"/chromium_headless_shell-*/chrome-linux/headless_shell \
    "$cache_dir"/chromium_headless_shell-*/chrome-linux64/headless_shell \
    "$cache_dir"/chromium_headless_shell-*/chrome-linux-arm64/headless_shell \
    "$cache_dir"/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell \
    "$cache_dir"/chromium_headless_shell-*/chrome-headless-shell-linux-arm64/chrome-headless-shell
  do
    if [ -f "$f" ]; then
      candidates+=("$f")
    fi
  done
  shopt -u nullglob
  if [ "${#candidates[@]}" -gt 0 ]; then
    pick_newest_path "${candidates[@]}"
    return 0
  fi
  find "$cache_dir" -maxdepth "$maxdepth" \
    \( -path '*/chrome-linux/headless_shell' -o \
       -path '*/chrome-linux64/headless_shell' -o \
       -path '*/chrome-linux-arm64/headless_shell' -o \
       -path '*/chrome-headless-shell-linux64/chrome-headless-shell' -o \
       -path '*/chrome-headless-shell-linux-arm64/chrome-headless-shell' \) \
    -type f 2>/dev/null \
    | sort | tail -n 1
}

resolve_chromium_in_cache() {
  local cache_dir="$1"
  local maxdepth="$2"
  local candidates=()
  local f
  shopt -s nullglob
  for f in \
    "$cache_dir"/chromium-*/chrome-linux/chrome \
    "$cache_dir"/chromium-*/chrome-linux64/chrome \
    "$cache_dir"/chromium-*/chrome-linux-arm64/chrome
  do
    if [ -f "$f" ]; then
      candidates+=("$f")
    fi
  done
  shopt -u nullglob
  if [ "${#candidates[@]}" -gt 0 ]; then
    pick_newest_path "${candidates[@]}"
    return 0
  fi
  find "$cache_dir" -maxdepth "$maxdepth" \( \
    -path '*/chrome-linux/chrome' -o \
    -path '*/chrome-linux64/chrome' -o \
    -path '*/chrome-linux-arm64/chrome' \
  \) -type f 2>/dev/null | sort | tail -n 1
}

if [ -z "$HEADLESS_SHELL_PATH" ]; then
  for CACHE_DIR in \
    "$PLAYWRIGHT_CACHE_DIR" \
    "$SUDO_HOME/.cache/ms-playwright" \
    "${SUDO_USER:+/home/$SUDO_USER/.cache/ms-playwright}"
  do
    if [ -n "$CACHE_DIR" ] && [ -d "$CACHE_DIR" ]; then
      HEADLESS_SHELL_PATH="$(resolve_headless_shell_in_cache "$CACHE_DIR" "$PLAYWRIGHT_CACHE_FIND_MAXDEPTH")"
      if [ -n "$HEADLESS_SHELL_PATH" ]; then
        break
      fi
    fi
  done
fi
if [ -z "$CHROMIUM_PATH" ]; then
  for CACHE_DIR in \
    "$PLAYWRIGHT_CACHE_DIR" \
    "$SUDO_HOME/.cache/ms-playwright" \
    "${SUDO_USER:+/home/$SUDO_USER/.cache/ms-playwright}"
  do
    if [ -n "$CACHE_DIR" ] && [ -d "$CACHE_DIR" ]; then
      CHROMIUM_PATH="$(resolve_chromium_in_cache "$CACHE_DIR" "$PLAYWRIGHT_CACHE_FIND_MAXDEPTH")"
      if [ -n "$CHROMIUM_PATH" ]; then
        break
      fi
    fi
  done
fi
CHROOT_DIR="$(mktemp -d)"
MOUNT_DIR="$(mktemp -d)"

cleanup() {
  sudo umount -l "$CHROOT_DIR/dev/pts" 2>/dev/null || true
  sudo umount -l "$CHROOT_DIR/dev" 2>/dev/null || true
  sudo umount -l "$CHROOT_DIR/proc" 2>/dev/null || true
  sudo umount -l "$CHROOT_DIR/sys" 2>/dev/null || true
  sudo umount -l "$MOUNT_DIR" 2>/dev/null || true
  if [ "$RUN_STATUS" = "success" ] || [ "$ROOTFS_KEEP_FAILED_CHROOT" != "1" ]; then
    sudo rm -rf "$CHROOT_DIR" "$MOUNT_DIR"
  else
    echo "[rootfs] preserving failed chroot at $CHROOT_DIR" >&2
    sudo rm -rf "$MOUNT_DIR"
  fi
  NOW_MS="$(now_ms)"
  write_metrics
}
trap cleanup EXIT

if [ "$BROWSER_PROFILE" = "chromium" ]; then
  if [ -z "$CHROMIUM_PATH" ] || [ ! -f "$CHROMIUM_PATH" ]; then
    echo "Could not find Playwright Chromium. Run 'npx playwright-core install chromium' first." >&2
    exit 1
  fi
else
  if [ -z "$HEADLESS_SHELL_PATH" ] || [ ! -f "$HEADLESS_SHELL_PATH" ]; then
    echo "Could not find chrome-headless-shell. Run 'npx playwright-core install chromium-headless-shell' first." >&2
    exit 1
  fi
fi

EXTRA_FLAGS="${FIRECRACKER_CHROME_EXTRA_FLAGS:-}"
NETLOG_PATH="${FIRECRACKER_CHROME_LOG_NET_LOG:-}"
TRACE_STARTUP_FILE="${FIRECRACKER_CHROME_TRACE_STARTUP_FILE:-}"
TRACE_STARTUP_DURATION="${FIRECRACKER_CHROME_TRACE_STARTUP_DURATION:-10}"
TRACE_STARTUP_CATEGORIES="${FIRECRACKER_CHROME_TRACE_STARTUP_CATEGORIES:-startup,benchmark,loading,netlog,renderer.scheduler,blink,cc,v8,toplevel}"
VMODULE_SPEC="${FIRECRACKER_CHROME_VMODULE:-}"
PROFILE_EXTRA_FLAGS=""
PROFILE_DISABLE_FEATURES=""

case "$INSTRUMENTATION_PROFILE" in
  none)
    ;;
  netlog-lite)
    if [ -z "$NETLOG_PATH" ]; then
      NETLOG_PATH="/var/log/chrome-netlog.json"
    fi
    ;;
  startup-lite)
    if [ -z "$NETLOG_PATH" ]; then
      NETLOG_PATH="/var/log/chrome-netlog.json"
    fi
    if [ -z "$TRACE_STARTUP_FILE" ]; then
      TRACE_STARTUP_FILE="/var/log/chrome-startup.json"
    fi
    TRACE_STARTUP_DURATION="${FIRECRACKER_CHROME_TRACE_STARTUP_DURATION:-5}"
    TRACE_STARTUP_CATEGORIES="${FIRECRACKER_CHROME_TRACE_STARTUP_CATEGORIES:-startup,loading,blink,renderer.scheduler,toplevel}"
    ;;
  debug-heavy)
    if [ -z "$NETLOG_PATH" ]; then
      NETLOG_PATH="/var/log/chrome-netlog.json"
    fi
    if [ -z "$TRACE_STARTUP_FILE" ]; then
      TRACE_STARTUP_FILE="/var/log/chrome-startup.json"
    fi
    TRACE_STARTUP_DURATION="${FIRECRACKER_CHROME_TRACE_STARTUP_DURATION:-12}"
    TRACE_STARTUP_CATEGORIES="${FIRECRACKER_CHROME_TRACE_STARTUP_CATEGORIES:-startup,benchmark,loading,netlog,renderer.scheduler,blink,cc,v8,toplevel}"
    VMODULE_SPEC="${FIRECRACKER_CHROME_VMODULE:-host_resolver_manager=1,net_log=1,loading_predictor_config=1}"
    ;;
  *)
    echo "Unknown FIRECRACKER_CHROME_INSTRUMENTATION_PROFILE: $INSTRUMENTATION_PROFILE" >&2
    exit 1
    ;;
esac

case "$LAUNCH_PROFILE" in
  baseline)
    ;;
  kernel-goto)
    PROFILE_EXTRA_FLAGS="--accept-lang=en-US,en \
--disable-back-forward-cache \
--disable-blink-features=AutomationControlled \
--disable-client-side-phishing-detection \
--disable-component-extensions-with-background-pages \
--disable-field-trial-config \
--disable-gcm-registration \
--disable-hang-monitor \
--disable-ipc-flooding-protection \
--disable-notifications \
--disable-popup-blocking \
--disable-prompt-on-repost \
--disable-search-engine-choice-screen \
--enable-use-zoom-for-dsf=false \
--force-color-profile=srgb \
--metrics-recording-only \
--mute-audio \
--password-store=basic"
    ;;
  kernel-goto-lite)
    PROFILE_EXTRA_FLAGS="--disable-back-forward-cache \
--disable-client-side-phishing-detection \
--disable-component-extensions-with-background-pages \
--disable-field-trial-config \
--disable-gcm-registration \
--disable-search-engine-choice-screen"
    ;;
  kernel-feature-prune)
    PROFILE_DISABLE_FEATURES="AcceptCHFrame,CertificateTransparencyComponentUpdater,DeferRendererTasksAfterInput,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,ImprovedCookieControls,LazyFrameLoading,LensOverlay,PaintHolding,ThirdPartyStoragePartitioning,Translate"
    ;;
  kernel-startup-prune)
    PROFILE_EXTRA_FLAGS="--accept-lang=en-US,en \
--disable-client-side-phishing-detection \
--disable-component-extensions-with-background-pages \
--disable-field-trial-config \
--disable-gcm-registration \
--disable-search-engine-choice-screen \
--metrics-recording-only \
--mute-audio \
--no-default-browser-check \
--no-first-run \
--no-service-autorun \
--password-store=basic"
    ;;
  kernel-startup-prune-automation)
    PROFILE_EXTRA_FLAGS="--accept-lang=en-US,en \
--disable-background-networking \
--disable-background-timer-throttling \
--disable-backgrounding-occluded-windows \
--disable-client-side-phishing-detection \
--disable-component-extensions-with-background-pages \
--disable-field-trial-config \
--disable-gcm-registration \
--disable-renderer-backgrounding \
--disable-search-engine-choice-screen \
--metrics-recording-only \
--mute-audio \
--no-default-browser-check \
--no-first-run \
--no-service-autorun \
--password-store=basic"
    ;;
  kernel-startup-prune-network-calm)
    PROFILE_EXTRA_FLAGS="--accept-lang=en-US,en \
--disable-background-networking \
--disable-background-timer-throttling \
--disable-backgrounding-occluded-windows \
--disable-client-side-phishing-detection \
--disable-component-extensions-with-background-pages \
--disable-field-trial-config \
--disable-gcm-registration \
--disable-renderer-backgrounding \
--disable-search-engine-choice-screen \
--dns-prefetch-disable \
--metrics-recording-only \
--mute-audio \
--no-default-browser-check \
--no-first-run \
--no-service-autorun \
--password-store=basic"
    PROFILE_DISABLE_FEATURES="OptimizationHints,SpeculationRulesPrefetchProxy,Translate"
    ;;
  kernel-startup-prune-lite)
    PROFILE_EXTRA_FLAGS="--accept-lang=en-US,en \
--disable-client-side-phishing-detection \
--disable-field-trial-config \
--disable-search-engine-choice-screen \
--metrics-recording-only \
--no-default-browser-check \
--no-first-run \
--no-service-autorun \
--password-store=basic"
    ;;
  kernel-balanced)
    PROFILE_EXTRA_FLAGS="--accept-lang=en-US,en \
--disable-back-forward-cache \
--disable-client-side-phishing-detection \
--disable-component-extensions-with-background-pages \
--disable-field-trial-config \
--disable-gcm-registration \
--disable-search-engine-choice-screen \
--metrics-recording-only \
--mute-audio \
--no-default-browser-check \
--no-first-run \
--no-service-autorun \
--password-store=basic"
    PROFILE_DISABLE_FEATURES="AcceptCHFrame,CertificateTransparencyComponentUpdater,DeferRendererTasksAfterInput,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,ImprovedCookieControls,LazyFrameLoading,LensOverlay,PaintHolding,ThirdPartyStoragePartitioning,Translate"
    ;;
  kernel-balanced-lite)
    PROFILE_EXTRA_FLAGS="--accept-lang=en-US,en \
--disable-client-side-phishing-detection \
--disable-field-trial-config \
--disable-search-engine-choice-screen \
--metrics-recording-only \
--mute-audio \
--no-default-browser-check \
--no-first-run \
--no-service-autorun \
--password-store=basic"
    PROFILE_DISABLE_FEATURES="CertificateTransparencyComponentUpdater,GlobalMediaControls,HttpsUpgrades,Translate"
    ;;
  async-parity-manual-gengar)
    PROFILE_EXTRA_FLAGS="--accept-lang=en-US,en \
--disable-back-forward-cache \
--disable-client-side-phishing-detection \
--disable-field-trial-config \
--disable-search-engine-choice-screen \
--no-default-browser-check \
--no-first-run \
--no-service-autorun \
--password-store=basic"
    ;;
  async-parity-manual-dragonite)
    PROFILE_EXTRA_FLAGS="--accept-lang=en-US,en \
--disable-back-forward-cache \
--disable-client-side-phishing-detection \
--disable-field-trial-config \
--disable-search-engine-choice-screen \
--no-default-browser-check \
--no-first-run \
--no-service-autorun \
--password-store=basic"
    PROFILE_DISABLE_FEATURES="CertificateTransparencyComponentUpdater,GlobalMediaControls,HttpsUpgrades,Translate"
    ;;
  async-parity-manual-custom-shell)
    PROFILE_EXTRA_FLAGS="--accept-lang=en-US,en \
--disable-field-trial-config \
--disable-search-engine-choice-screen \
--no-default-browser-check \
--no-first-run \
--no-service-autorun \
--password-store=basic"
    PROFILE_DISABLE_FEATURES="CertificateTransparencyComponentUpdater,GlobalMediaControls"
    ;;
  *)
    echo "Unknown FIRECRACKER_CHROME_LAUNCH_PROFILE: $LAUNCH_PROFILE" >&2
    exit 1
    ;;
esac

if [ "$BROWSER_PROFILE" = "chromium" ]; then
  COMBINED_DISABLE_FEATURES="Translate,OptimizationHints,MediaRouter"
else
  COMBINED_DISABLE_FEATURES="VizDisplayCompositor,Vulkan"
fi

if [ -n "$PROFILE_DISABLE_FEATURES" ]; then
  COMBINED_DISABLE_FEATURES="$COMBINED_DISABLE_FEATURES,$PROFILE_DISABLE_FEATURES"
fi

CURRENT_STAGE="host-apt-update"
HOST_APT_UPDATE_START_MS="$(now_ms)"
if [ "${FIRECRACKER_ROOTFS_SKIP_HOST_APT:-0}" = "1" ]; then
  echo "[rootfs] skipping host apt-get update (FIRECRACKER_ROOTFS_SKIP_HOST_APT=1)"
else
  sudo apt-get update
fi
HOST_APT_UPDATE_MS="$(( $(now_ms) - HOST_APT_UPDATE_START_MS ))"

CURRENT_STAGE="host-apt-install"
HOST_APT_INSTALL_START_MS="$(now_ms)"
if [ "${FIRECRACKER_ROOTFS_SKIP_HOST_APT:-0}" = "1" ]; then
  echo "[rootfs] skipping host apt-get install (FIRECRACKER_ROOTFS_SKIP_HOST_APT=1)"
  for cmd in debootstrap mkfs.ext4 rsync; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "FIRECRACKER_ROOTFS_SKIP_HOST_APT=1 requires $cmd on PATH; install debootstrap e2fsprogs rsync first." >&2
      exit 1
    fi
  done
else
  sudo apt-get install -y debootstrap e2fsprogs rsync
fi
HOST_APT_INSTALL_MS="$(( $(now_ms) - HOST_APT_INSTALL_START_MS ))"

mkdir -p "$ARTIFACT_DIR"
if [ -n "${FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR:-}" ]; then
  mkdir -p "$(dirname "$FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR")"
fi

mount_chroot_binds() {
  sudo mount --bind /dev "$CHROOT_DIR/dev"
  sudo mkdir -p "$CHROOT_DIR/dev/pts"
  sudo mount --bind /dev/pts "$CHROOT_DIR/dev/pts"
  sudo mount --bind /proc "$CHROOT_DIR/proc"
  sudo mount --bind /sys "$CHROOT_DIR/sys"
}

write_resolv_conf() {
  cat <<'EOF' | sudo tee "$CHROOT_DIR/etc/resolv.conf" >/dev/null
nameserver 1.1.1.1
nameserver 8.8.8.8
options timeout:2 attempts:2
EOF
}

write_apt_sources() {
  cat <<EOF | sudo tee "$CHROOT_DIR/etc/apt/sources.list" >/dev/null
deb $DEBOOTSTRAP_MIRROR $UBUNTU_SUITE main universe
deb $DEBOOTSTRAP_MIRROR ${UBUNTU_SUITE}-updates main universe
deb $DEBOOTSTRAP_MIRROR ${UBUNTU_SUITE}-backports main universe
deb $APT_SECURITY_MIRROR ${UBUNTU_SUITE}-security main universe
EOF
}

emit_flag_block() {
  local raw="${1:-}"
  local normalized=""
  local flag=""
  if [ -z "$raw" ]; then
    return 0
  fi
  normalized="$raw"
  normalized="${normalized//\\n/ }"
  normalized="${normalized//$'\r'/ }"
  normalized="${normalized//$'\n'/ }"
  for flag in $normalized; do
    if [ "$flag" = "\\" ]; then
      continue
    fi
    printf "  %s \\\n" "$flag"
  done
}

resolve_chroot_pkg() {
  local pkg=""
  for pkg in "$@"; do
    if sudo chroot "$CHROOT_DIR" apt-cache show "$pkg" >/dev/null 2>&1; then
      echo "$pkg"
      return 0
    fi
  done
  return 1
}

if [ "${FIRECRACKER_ROOTFS_USE_CHROOT_CACHE:-0}" = "1" ]; then
  if [ -z "${FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR:-}" ] || [ ! -f "$FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR" ]; then
    echo "FIRECRACKER_ROOTFS_USE_CHROOT_CACHE=1 requires an existing FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR file." >&2
    echo "Build once with FIRECRACKER_ROOTFS_SAVE_CHROOT_CACHE=1 to create it, or point to a compatible minbase tarball." >&2
    exit 1
  fi
  CURRENT_STAGE="chroot-cache-restore"
  CHROOT_CACHE_RESTORE_START_MS="$(now_ms)"
  # GNU tar: -a infers compression from the filename (.tar.gz, .tar.xz, .tar).
  sudo tar -xaf "$FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR" -C "$CHROOT_DIR"
  # Reject mismatched cache tarballs up front. Without this a cache
  # built for jammy/amd64 can silently deploy on top of a noble build,
  # or a cache built with a different package set can skip packages
  # the runtime now requires, leading to hard-to-diagnose guest
  # failures at VM boot time.
  CACHE_MANIFEST_FILE="$CHROOT_DIR$CACHE_MANIFEST_PATH_IN_CHROOT"
  if [ ! -f "$CACHE_MANIFEST_FILE" ]; then
    LAST_ERROR_MESSAGE="chroot cache tarball lacks $CACHE_MANIFEST_PATH_IN_CHROOT manifest; rebuild with FIRECRACKER_ROOTFS_SAVE_CHROOT_CACHE=1"
    echo "$LAST_ERROR_MESSAGE" >&2
    exit 1
  fi
  EXPECTED_PACKAGES_HASH="$(compute_cache_packages_hash)"
  if ! CACHE_MANIFEST_FILE="$CACHE_MANIFEST_FILE" \
       EXPECTED_SUITE="$UBUNTU_SUITE" \
       EXPECTED_ARCH="$ROOTFS_ARCH" \
       EXPECTED_SCHEMA="$CACHE_MANIFEST_SCHEMA_VERSION" \
       EXPECTED_PACKAGES_HASH="$EXPECTED_PACKAGES_HASH" \
       python3 - <<'PY'
import json, os, sys

path = os.environ["CACHE_MANIFEST_FILE"]
try:
    with open(path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
except Exception as exc:
    print(f"[rootfs] cache manifest unreadable: {exc}", file=sys.stderr)
    sys.exit(1)

checks = [
    ("schemaVersion", os.environ["EXPECTED_SCHEMA"]),
    ("suite", os.environ["EXPECTED_SUITE"]),
    ("arch", os.environ["EXPECTED_ARCH"]),
    ("packagesHash", os.environ["EXPECTED_PACKAGES_HASH"]),
]
mismatched = [
    (name, manifest.get(name), expected)
    for name, expected in checks
    if str(manifest.get(name, "")) != str(expected)
]
if mismatched:
    for name, got, expected in mismatched:
        print(f"[rootfs] cache manifest mismatch: {name} got={got!r} expected={expected!r}", file=sys.stderr)
    sys.exit(1)
PY
  then
    LAST_ERROR_MESSAGE="chroot cache manifest did not match current inputs; rebuild the cache"
    exit 1
  fi
  CHROOT_CACHE_RESTORE_MS="$(( $(now_ms) - CHROOT_CACHE_RESTORE_START_MS ))"
  write_resolv_conf
  write_apt_sources
  mount_chroot_binds
  DEBOOTSTRAP_MS=0
  CHROOT_APT_UPDATE_MS=0
  CHROOT_APT_INSTALL_MS=0
  FONT_CACHE_MS=0
  # Cache restore skipped debootstrap and apt entirely; blank mirror
  # fields so metrics don't misattribute to a mirror that was never
  # contacted on this run.
  DEBOOTSTRAP_MIRROR=""
  APT_SECURITY_MIRROR=""
else
  CURRENT_STAGE="debootstrap"
  DEBOOTSTRAP_START_MS="$(now_ms)"
  debootstrap_with_fallback "$UBUNTU_SUITE" "$CHROOT_DIR" "$DEBOOTSTRAP_MIRROR"
  DEBOOTSTRAP_MS="$(( $(now_ms) - DEBOOTSTRAP_START_MS ))"
  write_resolv_conf
  write_apt_sources
  mount_chroot_binds

  CURRENT_STAGE="chroot-apt-update"
  CHROOT_APT_UPDATE_START_MS="$(now_ms)"
  sudo chroot "$CHROOT_DIR" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get update
  CHROOT_APT_UPDATE_MS="$(( $(now_ms) - CHROOT_APT_UPDATE_START_MS ))"

  CURRENT_STAGE="chroot-apt-install"
  CHROOT_APT_INSTALL_START_MS="$(now_ms)"
  PACKAGES_TO_INSTALL=()
  while IFS= read -r _pkg_line; do
    [ -z "$_pkg_line" ] && continue
    # shellcheck disable=SC2086
    if ! _resolved="$(resolve_chroot_pkg $_pkg_line)"; then
      LAST_ERROR_MESSAGE="could not resolve any alternative for package slot: $_pkg_line"
      exit 1
    fi
    PACKAGES_TO_INSTALL+=("$_resolved")
  done <<EOF
$PACKAGES_SPEC
EOF
  sudo chroot "$CHROOT_DIR" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    "${PACKAGES_TO_INSTALL[@]}"
  CHROOT_APT_INSTALL_MS="$(( $(now_ms) - CHROOT_APT_INSTALL_START_MS ))"

  CURRENT_STAGE="font-cache"
  FONT_CACHE_START_MS="$(now_ms)"
  # Do NOT swallow failures: if fc-cache cannot write, we ship a rootfs
  # whose per-boot font scan will stall the browser cold-start path.
  # Route output to the debug log so it is inspectable without noise.
  mkdir -p "$(dirname "$ROOTFS_DEBUG_LOG_PATH")"
  if ! sudo chroot "$CHROOT_DIR" fc-cache -f >>"$ROOTFS_DEBUG_LOG_PATH" 2>&1; then
    LAST_ERROR_MESSAGE="fc-cache failed inside chroot; see $ROOTFS_DEBUG_LOG_PATH"
    exit 1
  fi
  # Bake a read-only seed of the fontconfig cache so the init script can
  # copy it into the tmpfs-mounted XDG_CACHE_HOME at every boot. Without
  # this, $XDG_CACHE_HOME/fontconfig starts empty on each VM and
  # fontconfig falls back to re-validating the system cache, which is a
  # documented cold-start cost on browser startup.
  sudo mkdir -p "$CHROOT_DIR/var/lib/baselayer/fontconfig-seed"
  if [ -d "$CHROOT_DIR/var/cache/fontconfig" ]; then
    sudo rsync -a --delete "$CHROOT_DIR/var/cache/fontconfig/" \
      "$CHROOT_DIR/var/lib/baselayer/fontconfig-seed/"
  fi
  FONT_CACHE_MS="$(( $(now_ms) - FONT_CACHE_START_MS ))"

  if [ "${FIRECRACKER_ROOTFS_SAVE_CHROOT_CACHE:-0}" = "1" ] && [ -n "${FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR:-}" ]; then
    CURRENT_STAGE="chroot-cache-save"
    CHROOT_CACHE_SAVE_START_MS="$(now_ms)"
    # Write a manifest of what this cache actually contains so
    # FIRECRACKER_ROOTFS_USE_CHROOT_CACHE=1 can reject stale tarballs
    # on later builds.
    CACHE_PACKAGES_HASH="$(compute_cache_packages_hash)"
    CACHE_CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    CACHE_MANIFEST_FILE="$CHROOT_DIR$CACHE_MANIFEST_PATH_IN_CHROOT"
    sudo mkdir -p "$(dirname "$CACHE_MANIFEST_FILE")"
    CACHE_MANIFEST_FILE="$CACHE_MANIFEST_FILE" \
    MANIFEST_SCHEMA="$CACHE_MANIFEST_SCHEMA_VERSION" \
    MANIFEST_SUITE="$UBUNTU_SUITE" \
    MANIFEST_ARCH="$ROOTFS_ARCH" \
    MANIFEST_MIRROR="$DEBOOTSTRAP_MIRROR" \
    MANIFEST_SECURITY_MIRROR="$APT_SECURITY_MIRROR" \
    MANIFEST_PACKAGES_HASH="$CACHE_PACKAGES_HASH" \
    MANIFEST_CREATED_AT="$CACHE_CREATED_AT" \
    MANIFEST_PACKAGES_SPEC="$PACKAGES_SPEC" \
    sudo -E python3 - <<'PY'
import json, os

payload = {
    "kind": "baselayer-rootfs-cache-manifest",
    "schemaVersion": int(os.environ["MANIFEST_SCHEMA"]),
    "suite": os.environ["MANIFEST_SUITE"],
    "arch": os.environ["MANIFEST_ARCH"],
    "debootstrapMirror": os.environ["MANIFEST_MIRROR"],
    "aptSecurityMirror": os.environ["MANIFEST_SECURITY_MIRROR"],
    "packagesHash": os.environ["MANIFEST_PACKAGES_HASH"],
    "packagesSpec": [
        line for line in os.environ["MANIFEST_PACKAGES_SPEC"].splitlines() if line
    ],
    "createdAt": os.environ["MANIFEST_CREATED_AT"],
}
with open(os.environ["CACHE_MANIFEST_FILE"], "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2)
PY
    sudo umount -l "$CHROOT_DIR/dev/pts" 2>/dev/null || true
    sudo umount -l "$CHROOT_DIR/dev" 2>/dev/null || true
    sudo umount -l "$CHROOT_DIR/proc" 2>/dev/null || true
    sudo umount -l "$CHROOT_DIR/sys" 2>/dev/null || true
    sudo tar -caf "$FIRECRACKER_ROOTFS_CHROOT_CACHE_TAR" -C "$CHROOT_DIR" .
    CHROOT_CACHE_SAVE_MS="$(( $(now_ms) - CHROOT_CACHE_SAVE_START_MS ))"
    mount_chroot_binds
  fi
fi

_dir_has_chromium_resources() {
  local dir="$1"
  # Full Chromium layouts include icudtl.dat + snapshot blobs. Recent
  # Playwright chromium-headless-shell layouts instead ship a smaller runtime
  # with headless-specific pak files and no icudtl.dat/snapshot_blob.bin.
  if [ -f "$dir/icudtl.dat" ] && { [ -f "$dir/snapshot_blob.bin" ] || [ -f "$dir/v8_context_snapshot.bin" ]; }; then
    :
  elif { [ -f "$dir/chrome-headless-shell" ] || [ -f "$dir/headless_shell" ]; } &&
    [ -f "$dir/headless_lib_data.pak" ] &&
    [ -f "$dir/headless_command_resources.pak" ]; then
    :
  else
    return 1
  fi
  shopt -s nullglob
  set -- "$dir"/*.pak
  shopt -u nullglob
  [ -f "${1:-}" ] || return 1
  return 0
}

_dir_looks_like_chromium_out() {
  local dir="$1"
  [ -d "$dir/obj" ] && return 0
  [ -f "$dir/args.gn" ] && return 0
  [ -f "$dir/build.ninja" ] && return 0
  return 1
}

# Resolves the host-side directory that should be rsynced into the rootfs
# and the relative path to the browser binary inside it. Handles both the
# stock Playwright layout (binary sits next to its resources) and custom
# Chromium builds where the binary is nested one level under its out/ dir
# while resources live at the parent.
# Args:   $1 = browser binary path on host
# Out:    BROWSER_ASSETS_DIR, BROWSER_BIN_GUEST_REL, BROWSER_ASSETS_MODE
#         BROWSER_ASSETS_MODE is either "full" (safe to rsync the whole
#         dir; stock Playwright layout or caller override) or "filtered"
#         (parent is a Chromium `out/` dir, so a whitelist rsync is
#         required to avoid shipping build intermediates).
resolve_browser_assets() {
  local bin="$1"
  local bin_dir parent_dir
  bin_dir="$(dirname "$bin")"

  if [ -n "$BROWSER_ASSETS_DIR_OVERRIDE" ]; then
    if [ ! -d "$BROWSER_ASSETS_DIR_OVERRIDE" ]; then
      LAST_ERROR_MESSAGE="FIRECRACKER_BROWSER_ASSETS_DIR does not exist: $BROWSER_ASSETS_DIR_OVERRIDE"
      echo "$LAST_ERROR_MESSAGE" >&2
      return 1
    fi
    case "$bin/" in
      "$BROWSER_ASSETS_DIR_OVERRIDE"/*) ;;
      *)
        LAST_ERROR_MESSAGE="browser binary ($bin) is not inside FIRECRACKER_BROWSER_ASSETS_DIR ($BROWSER_ASSETS_DIR_OVERRIDE)"
        echo "$LAST_ERROR_MESSAGE" >&2
        return 1
        ;;
    esac
    BROWSER_ASSETS_DIR="$BROWSER_ASSETS_DIR_OVERRIDE"
    BROWSER_BIN_GUEST_REL="${bin#"$BROWSER_ASSETS_DIR_OVERRIDE/"}"
    BROWSER_ASSETS_MODE="full"
    return 0
  fi

  if _dir_has_chromium_resources "$bin_dir"; then
    BROWSER_ASSETS_DIR="$bin_dir"
    BROWSER_BIN_GUEST_REL="$(basename "$bin")"
    if _dir_looks_like_chromium_out "$bin_dir"; then
      # Source-built Chromium often puts the runtime files beside the binary
      # inside the full out/ directory, which also contains obj/, ninja files,
      # and other intermediates that do not belong in the guest rootfs.
      BROWSER_ASSETS_MODE="filtered"
      echo "[rootfs] assets dir resolved to Chromium out/ dir ($bin_dir); using filtered rsync for top-level binary $(basename "$bin")" >&2
    else
      BROWSER_ASSETS_MODE="full"
    fi
    return 0
  fi

  parent_dir="$(dirname "$bin_dir")"
  if [ "$parent_dir" != "$bin_dir" ] && _dir_has_chromium_resources "$parent_dir"; then
    BROWSER_ASSETS_DIR="$parent_dir"
    BROWSER_BIN_GUEST_REL="$(basename "$bin_dir")/$(basename "$bin")"
    # Walking up means we're very likely sitting on a Chromium `out/`
    # dir containing gigabytes of build intermediates (*.o, *.ninja,
    # toolchain/, clang_x64/, gen/). Ship only the runtime whitelist.
    BROWSER_ASSETS_MODE="filtered"
    echo "[rootfs] assets dir resolved to parent of binary ($parent_dir); using filtered rsync, binary nested at $BROWSER_BIN_GUEST_REL" >&2
    return 0
  fi

  LAST_ERROR_MESSAGE="could not locate Chromium runtime resources (icudtl.dat, *.pak, snapshot_blob.bin) near $bin; set FIRECRACKER_BROWSER_ASSETS_DIR explicitly"
  echo "$LAST_ERROR_MESSAGE" >&2
  return 1
}

# Rsync options used when BROWSER_ASSETS_MODE=filtered. Covers the
# Chromium headless runtime set: data blobs, resource paks, locale
# paks, swiftshader/ANGLE libs (present only when the build includes
# them), and the top-level binaries. Include the specific binary path
# from the resolver so a nested `headless_shell/headless_shell` layout
# is preserved verbatim.
_filtered_rsync_browser_assets() {
  local src="$1"
  local dest="$2"
  local bin_rel="$3"
  sudo rsync -a \
    --prune-empty-dirs \
    --include='*/' \
    --include='icudtl.dat' \
    --include='snapshot_blob.bin' \
    --include='v8_context_snapshot.bin' \
    --include='*.pak' \
    --include='locales/***' \
    --include='resources/***' \
    --include='swiftshader/***' \
    --include='vk_swiftshader/***' \
    --include='vk_swiftshader_icd.json' \
    --include='libEGL.so' \
    --include='libGLESv2.so' \
    --include='libvulkan.so.1' \
    --include='libvk_swiftshader.so' \
    --include="$bin_rel" \
    --exclude='*' \
    "$src/" "$dest/"
}

CURRENT_STAGE="browser-sync"
BROWSER_SYNC_START_MS="$(now_ms)"
if [ "$BROWSER_PROFILE" = "chromium" ]; then
  resolve_browser_assets "$CHROMIUM_PATH"
  BROWSER_GUEST_ROOT="/opt/chromium"
else
  resolve_browser_assets "$HEADLESS_SHELL_PATH"
  BROWSER_GUEST_ROOT="/opt/chrome-headless-shell"
fi
sudo mkdir -p "$CHROOT_DIR$BROWSER_GUEST_ROOT"
if [ "$BROWSER_ASSETS_MODE" = "filtered" ]; then
  _filtered_rsync_browser_assets \
    "$BROWSER_ASSETS_DIR" \
    "$CHROOT_DIR$BROWSER_GUEST_ROOT" \
    "$BROWSER_BIN_GUEST_REL"
else
  sudo rsync -a "$BROWSER_ASSETS_DIR/" "$CHROOT_DIR$BROWSER_GUEST_ROOT/"
fi
BROWSER_BIN_GUEST_PATH="$BROWSER_GUEST_ROOT/$BROWSER_BIN_GUEST_REL"
if [ ! -f "$CHROOT_DIR$BROWSER_BIN_GUEST_PATH" ]; then
  LAST_ERROR_MESSAGE="rsynced browser assets but binary is missing at $BROWSER_BIN_GUEST_PATH (mode=$BROWSER_ASSETS_MODE, src=$BROWSER_ASSETS_DIR)"
  echo "$LAST_ERROR_MESSAGE" >&2
  exit 1
fi
BROWSER_SYNC_MS="$(( $(now_ms) - BROWSER_SYNC_START_MS ))"

CURRENT_STAGE="script-install"
SCRIPT_INSTALL_START_MS="$(now_ms)"
{
cat <<'EOF'
#!/bin/sh
set -eu
mkdir -p /tmp/chrome-profile
mkdir -p /tmp/chrome-profile/cache /tmp/chrome-profile/code-cache /tmp/chrome-profile/media-cache
mkdir -p /tmp/runtime
mkdir -p /tmp/.cache/fontconfig /var/cache/fontconfig
export HOME=/tmp
export XDG_CACHE_HOME=/tmp/.cache
export XDG_RUNTIME_DIR=/tmp/runtime
chmod 700 /tmp/runtime
EOF

if [ "$BROWSER_PROFILE" = "chromium" ]; then
cat <<'EOF'
exec __BROWSER_BIN_GUEST_PATH__ \
  --headless=new \
  --accept-lang=en-US,en \
  --disable-background-networking \
  --disable-dev-shm-usage \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-client-side-phishing-detection \
  --disable-component-extensions-with-background-pages \
  --disable-component-update \
  --disable-default-apps \
  --disable-renderer-backgrounding \
  --disable-breakpad \
  --disable-crash-reporter \
  --disable-crashpad \
  --disable-features=__COMBINED_DISABLE_FEATURES__ \
  --disable-gpu \
  --hide-scrollbars \
  --metrics-recording-only \
  --mute-audio \
  --no-default-browser-check \
  --no-first-run \
  --no-sandbox \
  --no-service-autorun \
  --no-zygote \
  --ozone-platform=headless \
  --password-store=basic \
  --disk-cache-dir=/tmp/chrome-profile/cache \
  --media-cache-dir=/tmp/chrome-profile/media-cache \
  --remote-allow-origins='*' \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9223 \
EOF
else
cat <<'EOF'
exec __BROWSER_BIN_GUEST_PATH__ \
  --headless=new \
  --accept-lang=en-US,en \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-gpu \
  --disable-gpu-compositing \
  --disable-gpu-sandbox \
  --disable-dev-shm-usage \
  --disable-crash-reporter \
  --disable-crashpad-for-testing \
  --disable-features=__COMBINED_DISABLE_FEATURES__ \
  --disable-renderer-backgrounding \
  --disk-cache-dir=/tmp/chrome-profile/cache \
  --media-cache-dir=/tmp/chrome-profile/media-cache \
  --metrics-recording-only \
  --mute-audio \
  --no-default-browser-check \
  --no-first-run \
  --no-sandbox \
  --no-service-autorun \
  --no-zygote \
  --password-store=basic \
  --remote-allow-origins='*' \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9223 \
EOF

if [ "$BROWSER_PROFILE" != "vanilla" ]; then
cat <<'EOF'
  --disable-software-rasterizer \
  --disable-setuid-sandbox \
  --in-process-gpu \
EOF
fi
fi

if [ "$USE_HOST_PROXY" = "1" ]; then
  printf "  --proxy-server=http://172.22.0.1:%s \\\n" "$HOST_PROXY_PORT"
  printf "  --proxy-bypass-list='127.0.0.1;localhost;172.22.0.1;*.local' \\\n"
fi

if [ -n "$NETLOG_PATH" ]; then
  printf "  --log-net-log=%s \\\n" "$NETLOG_PATH"
fi

if [ -n "$TRACE_STARTUP_FILE" ]; then
  printf "  --trace-startup \\\n"
  printf "  --trace-startup-file=%s \\\n" "$TRACE_STARTUP_FILE"
  printf "  --trace-startup-duration=%s \\\n" "$TRACE_STARTUP_DURATION"
  printf "  --trace-startup-categories=%s \\\n" "$TRACE_STARTUP_CATEGORIES"
fi

if [ -n "$VMODULE_SPEC" ]; then
  printf "  --vmodule=%s \\\n" "$VMODULE_SPEC"
fi

emit_flag_block "$EXTRA_FLAGS"
emit_flag_block "$PROFILE_EXTRA_FLAGS"

cat <<'EOF'
  --user-data-dir=/tmp/chrome-profile \
  about:blank
EOF
} | sed -e "s#__COMBINED_DISABLE_FEATURES__#$COMBINED_DISABLE_FEATURES#g" \
      -e "s#__BROWSER_BIN_GUEST_PATH__#$BROWSER_BIN_GUEST_PATH#g" \
  | sudo tee "$CHROOT_DIR/usr/local/bin/start-browser" >/dev/null
sudo chmod +x "$CHROOT_DIR/usr/local/bin/start-browser"

cat <<'EOF' | sudo tee "$CHROOT_DIR/usr/local/bin/start-cdp-proxy" >/dev/null
#!/bin/sh
set -eu
exec socat TCP-LISTEN:9222,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:9223
EOF
sudo chmod +x "$CHROOT_DIR/usr/local/bin/start-cdp-proxy"

cat <<'EOF' | sudo tee "$CHROOT_DIR/usr/local/bin/browser-launcher" >/dev/null
#!/bin/sh
set -eu

PROFILE_DIR=/tmp/chrome-profile
LOCKS="
$PROFILE_DIR/SingletonLock
$PROFILE_DIR/SingletonSocket
$PROFILE_DIR/SingletonCookie
"

mkdir -p "$PROFILE_DIR"
for path in $LOCKS; do
  rm -f "$path" 2>/dev/null || true
done

cleanup_old_browser() {
  if ! ss -ltnH '( sport = :9223 )' 2>/dev/null | grep -q 9223; then
    return 0
  fi

  pkill -f "__BROWSER_BIN_GUEST_PATH__" 2>/dev/null || true
  pkill -f "remote-debugging-port=9223" 2>/dev/null || true
}

wait_for_port_free() {
  attempts="${1:-50}"
  while [ "$attempts" -gt 0 ]; do
    if ! ss -ltnH '( sport = :9223 )' 2>/dev/null | grep -q 9223; then
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 0.1
  done
  return 1
}

cleanup_old_browser || true
wait_for_port_free || true
exec /usr/local/bin/start-browser
EOF
sudo chmod +x "$CHROOT_DIR/usr/local/bin/browser-launcher"

cat <<'EOF' | sudo tee "$CHROOT_DIR/init" >/dev/null
#!/bin/sh
set -eu
echo "init: start" >/dev/console
mountpoint -q /proc || mount -t proc proc /proc
mountpoint -q /sys || mount -t sysfs sysfs /sys
mountpoint -q /dev || mount -t devtmpfs devtmpfs /dev
mkdir -p /tmp /var/log /dev/shm /run
mount -t tmpfs tmpfs /tmp
mount -t tmpfs tmpfs /var/log
mount -t tmpfs tmpfs /dev/shm
mkdir -p /var/cache/fontconfig
# Seed $XDG_CACHE_HOME/fontconfig from the baked system cache so the
# first browser launch does not re-scan /usr/share/fonts. This runs
# before the browser-launcher subshell so the cache is ready by the
# time Chromium imports fontconfig.
mkdir -p /tmp/.cache
if [ -d /var/lib/baselayer/fontconfig-seed ]; then
  cp -a /var/lib/baselayer/fontconfig-seed /tmp/.cache/fontconfig
fi
ip link set lo up
ip link set eth0 up || true
echo "init: browser-launch" >/dev/console
(
EOF

if [ "$GUEST_DISABLE_IPV6" = "1" ]; then
cat <<'EOF' | sudo tee -a "$CHROOT_DIR/init" >/dev/null
echo 1 > /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || true
echo 1 > /proc/sys/net/ipv6/conf/default/disable_ipv6 2>/dev/null || true
EOF
fi

cat <<'EOF' | sudo tee -a "$CHROOT_DIR/init" >/dev/null
  /usr/local/bin/browser-launcher 2>&1 | tee -a /var/log/browser.log >/dev/console
) &
(
  /usr/local/bin/start-cdp-proxy 2>&1 | tee -a /var/log/cdp-proxy.log >/dev/console
) &
(
  sleep 2
  echo "init: ss" >/dev/console
  ss -ltnp >/dev/console 2>&1 || true
) &
while true; do
  sleep 3600
done
EOF
sudo chmod +x "$CHROOT_DIR/init"
SCRIPT_INSTALL_MS="$(( $(now_ms) - SCRIPT_INSTALL_START_MS ))"

sudo umount -l "$CHROOT_DIR/dev/pts"
sudo umount -l "$CHROOT_DIR/dev"
sudo umount -l "$CHROOT_DIR/proc"
sudo umount -l "$CHROOT_DIR/sys"

CURRENT_STAGE="ext4-create"
EXT4_CREATE_START_MS="$(now_ms)"
truncate -s "${ROOTFS_SIZE_MB}M" "$ROOTFS_PATH"
mkfs.ext4 -F "$ROOTFS_PATH" >/dev/null
EXT4_CREATE_MS="$(( $(now_ms) - EXT4_CREATE_START_MS ))"

CURRENT_STAGE="rootfs-copy"
ROOTFS_COPY_START_MS="$(now_ms)"
sudo mount -o loop "$ROOTFS_PATH" "$MOUNT_DIR"
sudo rsync -a "$CHROOT_DIR/" "$MOUNT_DIR/"
sudo umount "$MOUNT_DIR"
ROOTFS_COPY_MS="$(( $(now_ms) - ROOTFS_COPY_START_MS ))"

echo "Built Firecracker rootfs at $ROOTFS_PATH"
RUN_STATUS="success"
CURRENT_STAGE=""
