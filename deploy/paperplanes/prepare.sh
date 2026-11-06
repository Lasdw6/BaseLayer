#!/bin/bash
set -euo pipefail
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io supervisor git curl ca-certificates build-essential pkg-config
mkdir -p /opt/scry /opt/baselayer-test /data/logs /data/baselayer
tar -xzf /tmp/scry-source.tar.gz -C /opt/scry
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.91.0
cd /opt/scry
/root/.cargo/bin/cargo build --release --locked -j 2 --config profile.release.lto=false --config profile.release.codegen-units=16
install -m 0755 target/release/scry /usr/local/bin/scry
git clone https://github.com/Lasdw6/BaseLayer.git /opt/baselayer
cd /opt/baselayer
git checkout 6019f0cd2e95e4ea0a8afcba4dd3823029930975
npm ci --no-audit --no-fund
npm run build
service docker start
docker build -f Dockerfile.runtime -t baselayer-runtime:local .
docker image inspect baselayer-runtime:local >/dev/null
service docker stop
