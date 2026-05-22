#!/usr/bin/env bash
# Same engine as ssh-run.mjs — bounded scp/rsync.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/ssh-run.mjs" "$@"
