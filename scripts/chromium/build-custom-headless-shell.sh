#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
CHROMIUM_SRC_DIR="${BASELAYER_CHROMIUM_SRC_DIR:-}"
PATCH_PROFILE="${BASELAYER_CHROMIUM_PATCH_PROFILE:-startup-network-v1}"
GN_PROFILE="${BASELAYER_CHROMIUM_GN_PROFILE:-headless-minimal-v1}"
OUT_DIR="${BASELAYER_CHROMIUM_OUT_DIR:-}"
DEPOT_TOOLS_DIR="${DEPOT_TOOLS_DIR:-}"
EXTRA_GN_ARGS="${BASELAYER_CHROMIUM_EXTRA_GN_ARGS:-}"
EXTRA_GN_ARGS_FILE="${BASELAYER_CHROMIUM_EXTRA_GN_ARGS_FILE:-}"
BUILD_METRICS_PATH="${BASELAYER_CHROMIUM_BUILD_METRICS_PATH:-}"
PGO_PHASE="${BASELAYER_CHROMIUM_PGO_PHASE:-}"
PGO_DATA_PATH="${BASELAYER_CHROMIUM_PGO_DATA_PATH:-}"
PGO_ENABLE_RESOURCE_ALLOWLIST_GENERATION="${BASELAYER_CHROMIUM_PGO_ENABLE_RESOURCE_ALLOWLIST_GENERATION:-}"
# Upstream has renamed this target at least once. Keep it configurable so a
# future rename does not require editing the script in-tree on the build host.
NINJA_TARGET="${BASELAYER_CHROMIUM_NINJA_TARGET:-headless_shell}"
# Tree-cleanup knob for repeatable patch applies. When 1, `git reset --hard`
# + `git clean -fdx` run before applying any patch. Off by default because a
# stale dirty tree usually means the operator was mid-edit and we should not
# silently discard work.
PATCH_RESET_TREE="${BASELAYER_CHROMIUM_PATCH_RESET_TREE:-0}"

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
PATCH_MS=0
ARGS_WRITE_MS=0
GN_GEN_MS=0
AUTONINJA_MS=0
BINARY_DISCOVERY_MS=0
PATCH_STATUS="skipped"
PATCH_PROFILE_FOUND="0"
BIN_PATH=""
# Newline-separated basenames: marker for metrics (apply.sh or ordered *.patch list).
PATCH_FILES_BASENAMES=""
# Full `git rev-parse HEAD` of CHROMIUM_SRC_DIR when it is a git checkout.
CHROMIUM_GIT_REVISION=""

write_metrics() {
  local metrics_path="$BUILD_METRICS_PATH"
  if [[ -z "$metrics_path" && -n "$OUT_DIR" ]]; then
    metrics_path="$OUT_DIR/baselayer-build-metrics.json"
  fi

  if [[ -z "$metrics_path" ]]; then
    return
  fi

  mkdir -p "$(dirname "$metrics_path")"

  # Python reads os.environ only; export so payload fields are never silently empty.
  export NOW_MS="${NOW_MS:-$(now_ms)}"
  export CHROMIUM_SRC_DIR PATCH_PROFILE GN_PROFILE OUT_DIR EXTRA_GN_ARGS_FILE
  export PGO_PHASE PGO_DATA_PATH PGO_ENABLE_RESOURCE_ALLOWLIST_GENERATION
  export RUN_STATUS CURRENT_STAGE PATCH_STATUS PATCH_PROFILE_FOUND BIN_PATH
  export PATCH_FILES_BASENAMES CHROMIUM_GIT_REVISION
  export PATCH_MS ARGS_WRITE_MS GN_GEN_MS AUTONINJA_MS BINARY_DISCOVERY_MS TOTAL_START_MS

  METRICS_PATH="$metrics_path" python3 - <<'PY'
import json
import os
from datetime import datetime, timezone

def getenv_int(name: str) -> int:
    raw = os.environ.get(name, "0")
    try:
        return int(raw)
    except ValueError:
        return 0

_patch_raw = os.environ.get("PATCH_FILES_BASENAMES", "")
_patch_files = [line for line in _patch_raw.split("\n") if line.strip()]

_chromium_rev = os.environ.get("CHROMIUM_GIT_REVISION", "").strip()

payload = {
    "kind": "baselayer-chromium-build-metrics-v1",
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "status": os.environ.get("RUN_STATUS", "failed"),
    "failureStage": os.environ.get("CURRENT_STAGE", ""),
    "chromiumSrcDir": os.environ.get("CHROMIUM_SRC_DIR", ""),
    "chromiumRevision": _chromium_rev if _chromium_rev else None,
    "patchProfile": os.environ.get("PATCH_PROFILE", ""),
    "patchProfileFound": os.environ.get("PATCH_PROFILE_FOUND", "0") == "1",
    "patchStatus": os.environ.get("PATCH_STATUS", "skipped"),
    "patchFiles": _patch_files,
    "gnProfile": os.environ.get("GN_PROFILE", ""),
    "outDir": os.environ.get("OUT_DIR", ""),
    "binaryPath": os.environ.get("BIN_PATH", ""),
    "extraGnArgsFile": os.environ.get("EXTRA_GN_ARGS_FILE", ""),
    "pgo": {
        "phase": os.environ.get("PGO_PHASE", ""),
        "dataPath": os.environ.get("PGO_DATA_PATH", ""),
        "enableResourceAllowlistGeneration": os.environ.get(
            "PGO_ENABLE_RESOURCE_ALLOWLIST_GENERATION", ""
        ),
    },
    "timingsMs": {
        "patch": getenv_int("PATCH_MS"),
        "argsWrite": getenv_int("ARGS_WRITE_MS"),
        "gnGen": getenv_int("GN_GEN_MS"),
        "autoninja": getenv_int("AUTONINJA_MS"),
        "binaryDiscovery": getenv_int("BINARY_DISCOVERY_MS"),
        "total": max(0, getenv_int("NOW_MS") - getenv_int("TOTAL_START_MS")),
    },
}

with open(os.environ["METRICS_PATH"], "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2)
PY
}

trap 'NOW_MS="$(now_ms)"; write_metrics' EXIT

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required on PATH for build metrics emission" >&2
  exit 1
fi

if [[ -z "$CHROMIUM_SRC_DIR" ]]; then
  echo "BASELAYER_CHROMIUM_SRC_DIR is required" >&2
  exit 1
fi

if [[ ! -f "$CHROMIUM_SRC_DIR/BUILD.gn" ]]; then
  echo "Chromium source checkout not found at $CHROMIUM_SRC_DIR" >&2
  exit 1
fi

if git -C "$CHROMIUM_SRC_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  CHROMIUM_GIT_REVISION="$(git -C "$CHROMIUM_SRC_DIR" rev-parse HEAD 2>/dev/null || true)"
fi

if [[ -n "$DEPOT_TOOLS_DIR" && -d "$DEPOT_TOOLS_DIR" ]]; then
  export PATH="$DEPOT_TOOLS_DIR:$PATH"
fi

if ! command -v gn >/dev/null 2>&1; then
  echo "gn is required on PATH (set DEPOT_TOOLS_DIR or install depot_tools)" >&2
  exit 1
fi

if ! command -v autoninja >/dev/null 2>&1; then
  echo "autoninja is required on PATH (set DEPOT_TOOLS_DIR or install depot_tools)" >&2
  exit 1
fi

DEFAULT_OUT_SUFFIX="${GN_PROFILE}"
if [[ -n "$PATCH_PROFILE" ]]; then
  DEFAULT_OUT_SUFFIX="${DEFAULT_OUT_SUFFIX}-${PATCH_PROFILE}"
fi
OUT_DIR="${OUT_DIR:-$CHROMIUM_SRC_DIR/out/baselayer-headless-shell-${DEFAULT_OUT_SUFFIX}}"
PATCH_DIR="$ROOT/scripts/chromium/patch-profiles/$PATCH_PROFILE"
ARGS_FILE="$ROOT/scripts/chromium/gn/$GN_PROFILE.args.gn"
if [[ -z "$BUILD_METRICS_PATH" ]]; then
  BUILD_METRICS_PATH="$OUT_DIR/baselayer-build-metrics.json"
fi

if [[ ! -f "$ARGS_FILE" ]]; then
  echo "Unknown GN profile: $GN_PROFILE" >&2
  exit 1
fi

CURRENT_STAGE="patch-profile"
PATCH_START_MS="$(now_ms)"
if [[ -d "$PATCH_DIR" ]]; then
  PATCH_PROFILE_FOUND="1"
  echo "[chromium] patch profile: $PATCH_PROFILE"
  if [[ -x "$PATCH_DIR/apply.sh" ]]; then
    PATCH_STATUS="apply-sh"
    PATCH_FILES_BASENAMES="apply.sh"
    # Run inside the source dir so apply.sh does not need to replicate the
    # cwd logic every time.
    (cd "$CHROMIUM_SRC_DIR" && "$PATCH_DIR/apply.sh" "$CHROMIUM_SRC_DIR")
  elif compgen -G "$PATCH_DIR/*.patch" >/dev/null; then
    PATCH_STATUS="git-apply"
    PATCH_FILES_BASENAMES=""
    for patch in "$PATCH_DIR"/*.patch; do
      PATCH_FILES_BASENAMES="${PATCH_FILES_BASENAMES}${PATCH_FILES_BASENAMES:+$'\n'}$(basename "$patch")"
    done
    (
      cd "$CHROMIUM_SRC_DIR"
      if [[ "$PATCH_RESET_TREE" = "1" ]]; then
        echo "[chromium] resetting tree before patch apply (BASELAYER_CHROMIUM_PATCH_RESET_TREE=1)"
        git reset --hard >/dev/null
        git clean -fdx >/dev/null
      fi
      # Preflight: check every patch applies cleanly before mutating the
      # tree. This avoids a half-applied state that requires manual
      # recovery on a multi-gigabyte checkout.
      for patch in "$PATCH_DIR"/*.patch; do
        if ! git apply --check "$patch"; then
          echo "[chromium] patch does not apply cleanly: $(basename "$patch")" >&2
          echo "[chromium] set BASELAYER_CHROMIUM_PATCH_RESET_TREE=1 to reset the tree before retrying." >&2
          exit 1
        fi
      done
      for patch in "$PATCH_DIR"/*.patch; do
        echo "[chromium] applying $(basename "$patch")"
        git apply "$patch"
      done
    )
  else
    PATCH_STATUS="empty"
    echo "[chromium] patch profile has no apply.sh or .patch files, skipping"
  fi
else
  PATCH_STATUS="missing"
  echo "[chromium] patch profile not found, skipping source patch step: $PATCH_PROFILE"
fi
PATCH_MS="$(( $(now_ms) - PATCH_START_MS ))"

CURRENT_STAGE="args-write"
ARGS_START_MS="$(now_ms)"
mkdir -p "$OUT_DIR"
cp "$ARGS_FILE" "$OUT_DIR/args.gn"

if [[ -n "$PGO_PHASE" ]]; then
  if [[ ! "$PGO_PHASE" =~ ^[012]$ ]]; then
    echo "BASELAYER_CHROMIUM_PGO_PHASE must be 0, 1, or 2; got '$PGO_PHASE'" >&2
    exit 1
  fi
  if [[ "$PGO_PHASE" = "2" && -z "$PGO_DATA_PATH" ]]; then
    echo "BASELAYER_CHROMIUM_PGO_DATA_PATH is required when BASELAYER_CHROMIUM_PGO_PHASE=2" >&2
    exit 1
  fi
  export PGO_PHASE PGO_DATA_PATH PGO_ENABLE_RESOURCE_ALLOWLIST_GENERATION
  python3 - "$OUT_DIR/args.gn" <<'PY'
import os
import re
import sys

args_path = sys.argv[1]
text = open(args_path, encoding="utf-8").read()

def set_gn_arg(body: str, name: str, value: str) -> str:
    line = f"{name} = {value}"
    pattern = re.compile(rf"^{re.escape(name)}\s*=.*$", re.MULTILINE)
    if pattern.search(body):
        return pattern.sub(line, body)
    if body and not body.endswith("\n"):
        body += "\n"
    return body + line + "\n"

text = set_gn_arg(text, "chrome_pgo_phase", os.environ["PGO_PHASE"])

pgo_data_path = os.environ.get("PGO_DATA_PATH", "")
if pgo_data_path:
    text = set_gn_arg(text, "pgo_data_path", f'"{pgo_data_path}"')

allowlist = os.environ.get("PGO_ENABLE_RESOURCE_ALLOWLIST_GENERATION", "")
if allowlist:
    if allowlist not in {"true", "false"}:
        raise SystemExit(
            "BASELAYER_CHROMIUM_PGO_ENABLE_RESOURCE_ALLOWLIST_GENERATION must be true or false"
        )
    text = set_gn_arg(text, "enable_resource_allowlist_generation", allowlist)

with open(args_path, "w", encoding="utf-8", newline="\n") as f:
    f.write(text)
PY
fi

if [[ -n "$EXTRA_GN_ARGS_FILE" ]]; then
  if [[ ! -f "$EXTRA_GN_ARGS_FILE" ]]; then
    echo "Extra GN args file not found: $EXTRA_GN_ARGS_FILE" >&2
    exit 1
  fi
  {
    echo
    echo "# BaseLayer extra GN args from file"
    cat "$EXTRA_GN_ARGS_FILE"
  } >> "$OUT_DIR/args.gn"
fi

if [[ -n "$EXTRA_GN_ARGS" ]]; then
  {
    echo
    echo "# BaseLayer extra GN args from env"
    printf "%s\n" "$EXTRA_GN_ARGS"
  } >> "$OUT_DIR/args.gn"
fi
ARGS_WRITE_MS="$(( $(now_ms) - ARGS_START_MS ))"

echo "[chromium] generating out dir: $OUT_DIR"
CURRENT_STAGE="gn-gen"
GN_START_MS="$(now_ms)"
(
  cd "$CHROMIUM_SRC_DIR"
  gn gen "$OUT_DIR"
)
GN_GEN_MS="$(( $(now_ms) - GN_START_MS ))"

CURRENT_STAGE="autoninja"
AUTONINJA_START_MS="$(now_ms)"
echo "[chromium] autoninja target: $NINJA_TARGET"
(
  cd "$CHROMIUM_SRC_DIR"
  autoninja -C "$OUT_DIR" "$NINJA_TARGET"
)
AUTONINJA_MS="$(( $(now_ms) - AUTONINJA_START_MS ))"

CURRENT_STAGE="binary-discovery"
BINARY_DISCOVERY_START_MS="$(now_ms)"
BIN_PATH="$OUT_DIR/headless_shell"
if [[ ! -f "$BIN_PATH" ]]; then
  BIN_PATH="$OUT_DIR/chrome-headless-shell"
fi

if [[ ! -f "$BIN_PATH" ]]; then
  BIN_PATH="$OUT_DIR/headless_shell/headless_shell"
fi

if [[ ! -f "$BIN_PATH" ]]; then
  BIN_PATH="$OUT_DIR/chrome-headless-shell/chrome-headless-shell"
fi

if [[ ! -f "$BIN_PATH" ]]; then
  echo "Custom chrome-headless-shell build completed, but binary path could not be found under $OUT_DIR" >&2
  exit 1
fi
BINARY_DISCOVERY_MS="$(( $(now_ms) - BINARY_DISCOVERY_START_MS ))"

# `headless_use_embedded_resources = false` means the binary expects these
# sibling files at runtime. A rootfs rsync that silently drops them
# produces a shell that crashes on launch inside Firecracker, which is
# painful to debug. Fail loudly here. Skip the check only when the
# resolved args file opts into embedded resources.
EMBEDDED_RESOURCES_OPT_IN=0
if grep -Eq '^[[:space:]]*headless_use_embedded_resources[[:space:]]*=[[:space:]]*true[[:space:]]*(#.*)?$' "$OUT_DIR/args.gn"; then
  EMBEDDED_RESOURCES_OPT_IN=1
fi

# Blobs may sit next to the binary or in the parent out/ dir (nested
# headless_shell/headless_shell layout); mirror rootfs resolve_browser_assets.
_chromium_runtime_dir_complete() {
  local d="$1"
  [[ -f "$d/icudtl.dat" && -f "$d/snapshot_blob.bin" && -f "$d/v8_context_snapshot.bin" ]] || return 1
  compgen -G "$d/*.pak" >/dev/null || return 1
  return 0
}

BIN_DIR="$(dirname "$BIN_PATH")"
RESOURCE_DIR="$BIN_DIR"
if ! _chromium_runtime_dir_complete "$RESOURCE_DIR"; then
  _parent="$(dirname "$BIN_DIR")"
  if [[ "$_parent" != "$BIN_DIR" ]] && _chromium_runtime_dir_complete "$_parent"; then
    RESOURCE_DIR="$_parent"
  fi
fi
unset _parent

MISSING_RESOURCES=()
for resource in icudtl.dat snapshot_blob.bin v8_context_snapshot.bin; do
  if [[ ! -f "$RESOURCE_DIR/$resource" ]]; then
    MISSING_RESOURCES+=("$resource")
  fi
done
if ! compgen -G "$RESOURCE_DIR/*.pak" >/dev/null; then
  MISSING_RESOURCES+=("*.pak")
fi
if [[ "${#MISSING_RESOURCES[@]}" -gt 0 ]]; then
  if [[ "$EMBEDDED_RESOURCES_OPT_IN" = "1" ]]; then
    echo "[chromium] note: args.gn sets headless_use_embedded_resources=true; skipping missing-resource check." >&2
  else
    echo "[chromium] ERROR: missing expected runtime resources under $RESOURCE_DIR (binary $BIN_PATH):" >&2
    printf "  %s\n" "${MISSING_RESOURCES[@]}" >&2
    echo "[chromium] The rootfs rsync would produce a broken shell. Re-build, or set headless_use_embedded_resources = true in your args.gn if you intend to ship an embedded-resource binary." >&2
    exit 1
  fi
fi

echo "[chromium] built custom headless shell:"
echo "$BIN_PATH"
RUN_STATUS="success"
