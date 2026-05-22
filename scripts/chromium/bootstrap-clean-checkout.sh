#!/usr/bin/env bash
set -Eeuo pipefail

# Clean, guarded Chromium checkout/bootstrap for paid benchmark hosts.
# This script is intentionally conservative: a partial Chromium checkout is worse than no checkout
# because gclient can leave nested repos with no HEAD and gn then fails one dependency at a time.

ROOT_DIR="${BASELAYER_CHROMIUM_WORK_DIR:-$HOME/chromium}"
DEPOT_TOOLS_DIR="${DEPOT_TOOLS_DIR:-$HOME/depot_tools}"
LOG_PATH="${BASELAYER_CHROMIUM_BOOTSTRAP_LOG:-$HOME/chromium-clean-bootstrap.log}"
MARKER_DONE="${BASELAYER_CHROMIUM_BOOTSTRAP_DONE:-$HOME/chromium-clean-bootstrap.done}"
MARKER_FAILED="${BASELAYER_CHROMIUM_BOOTSTRAP_FAILED:-$HOME/chromium-clean-bootstrap.failed}"
CLEAN="${BASELAYER_CHROMIUM_BOOTSTRAP_CLEAN:-1}"
FETCH_TIMEOUT_SEC="${BASELAYER_CHROMIUM_FETCH_TIMEOUT_SEC:-3600}"
SYNC_TIMEOUT_SEC="${BASELAYER_CHROMIUM_SYNC_TIMEOUT_SEC:-2400}"
HOOK_TIMEOUT_SEC="${BASELAYER_CHROMIUM_HOOK_TIMEOUT_SEC:-900}"
SYNC_JOBS="${BASELAYER_CHROMIUM_SYNC_JOBS:-16}"

stage="init"

fail() {
  local code="$1"
  echo "[chromium-bootstrap] FAILED stage=$stage code=$code" >&2
  printf 'failed stage=%s code=%s\n' "$stage" "$code" > "$MARKER_FAILED"
  exit "$code"
}

trap 'fail $?' ERR

mkdir -p "$(dirname "$LOG_PATH")" "$(dirname "$MARKER_DONE")" "$(dirname "$MARKER_FAILED")"
rm -f "$MARKER_DONE" "$MARKER_FAILED"
exec >"$LOG_PATH" 2>&1

echo "[chromium-bootstrap] started $(date -Is)"
echo "[chromium-bootstrap] root=$ROOT_DIR depot_tools=$DEPOT_TOOLS_DIR clean=$CLEAN"

export PATH="$DEPOT_TOOLS_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export GCLIENT_SUPPRESS_GIT_VERSION_WARNING="${GCLIENT_SUPPRESS_GIT_VERSION_WARNING:-1}"

stage="install-prereqs"
sudo env DEBIAN_FRONTEND=noninteractive apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  build-essential \
  ca-certificates \
  ccache \
  curl \
  file \
  git \
  jq \
  lsb-release \
  pkg-config \
  python3 \
  sudo \
  xz-utils

stage="stop-stale-processes"
pkill -f "[g]client" || true
pkill -f "[g]sutil" || true
pkill -f "[c]ipd" || true

stage="clean"
if [[ "$CLEAN" == "1" ]]; then
  rm -rf "$ROOT_DIR" "$DEPOT_TOOLS_DIR"
fi
mkdir -p "$ROOT_DIR"

stage="depot-tools"
if [[ ! -x "$DEPOT_TOOLS_DIR/fetch" ]]; then
  git clone --depth 1 https://chromium.googlesource.com/chromium/tools/depot_tools.git "$DEPOT_TOOLS_DIR"
fi
export PATH="$DEPOT_TOOLS_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

stage="fetch"
if [[ ! -f "$ROOT_DIR/src/BUILD.gn" ]]; then
  if [[ -e "$ROOT_DIR/.gclient" || -e "$ROOT_DIR/src" ]]; then
    echo "[chromium-bootstrap] refusing partial checkout before fetch: $ROOT_DIR" >&2
    exit 42
  fi
  cd "$ROOT_DIR"
  timeout "$FETCH_TIMEOUT_SEC" fetch --no-history chromium
fi

stage="sync"
cd "$ROOT_DIR"
timeout "$SYNC_TIMEOUT_SEC" gclient sync --no-history --jobs "$SYNC_JOBS"

stage="hooks"
timeout "$HOOK_TIMEOUT_SEC" gclient runhooks

stage="validate-tree"
test -f "$ROOT_DIR/src/BUILD.gn"
test -x "$ROOT_DIR/src/buildtools/linux64/gn"
test -d "$ROOT_DIR/src/third_party/blink"
test -d "$ROOT_DIR/src/v8"

bad_nested="$(
  cd "$ROOT_DIR/src"
  find third_party -maxdepth 4 -type d -name .git | while read -r git_dir; do
    dep_dir="$(dirname "$git_dir")"
    if ! (cd "$dep_dir" && git rev-parse --verify HEAD >/dev/null 2>&1); then
      echo "$dep_dir"
    fi
  done | head -50
)"
if [[ -n "$bad_nested" ]]; then
  echo "[chromium-bootstrap] nested repos without HEAD:" >&2
  echo "$bad_nested" >&2
  exit 43
fi

stage="install-build-deps"
sudo bash "$ROOT_DIR/src/build/install-build-deps.sh" --no-prompt --no-arm --no-chromeos-fonts || true

stage="gn-probe"
cd "$ROOT_DIR/src"
rm -rf out/baselayer-gn-probe
buildtools/linux64/gn gen out/baselayer-gn-probe --args='is_debug=false is_component_build=false symbol_level=0 blink_symbol_level=0 chrome_pgo_phase=0 use_remoteexec=false treat_warnings_as_errors=false'

stage="done"
printf 'ok\n' > "$MARKER_DONE"
echo "[chromium-bootstrap] done $(date -Is)"
