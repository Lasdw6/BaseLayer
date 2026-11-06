#!/bin/bash
set -euo pipefail
# Start after sandbox creation so the run gets this sandbox's identity.
while [ ! -f /data/scry.env ]; do sleep 1; done
set -a
source /data/scry.env
set +a
exec /usr/local/bin/scry run --dir /data/scry --workspace /opt/baselayer
