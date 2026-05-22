#!/usr/bin/env bash
# Thin wrapper: bounded SSH (same as node scripts/ssh-run.mjs).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/ssh-run.mjs" "$@"
