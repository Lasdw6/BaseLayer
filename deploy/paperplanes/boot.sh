#!/bin/bash
set -euo pipefail
mkdir -p /data/logs /data/baselayer /data/scry
service docker start
cat > /data/baselayer-supervisord.conf <<'CONF'
[unix_http_server]
file=/data/baselayer-supervisor.sock
chmod=0700
[supervisord]
nodaemon=true
user=root
logfile=/data/logs/baselayer-supervisord.log
pidfile=/data/baselayer-supervisord.pid
[rpcinterface:supervisor]
supervisor.rpcinterface_factory=supervisor.rpcinterface:make_main_rpcinterface
[supervisorctl]
serverurl=unix:///data/baselayer-supervisor.sock
[program:baselayer-api]
directory=/opt/baselayer
command=node dist/api/server.js
environment=CONTROL_PLANE_STATE_PATH="/data/baselayer/control-plane.json"
autorestart=true
stdout_logfile=/data/logs/baselayer-api.log
stderr_logfile=/data/logs/baselayer-api-error.log
[program:baselayer-agent]
directory=/opt/baselayer
command=node dist/node-agent/server.js
environment=NODE_AGENT_MODE="managed",MAX_SESSIONS="2",CONTROL_PLANE_URL="http://127.0.0.1:3000",RUNTIME_IMAGE="baselayer-runtime:local",SESSION_MEMORY_LIMIT_MB="768"
autorestart=true
startsecs=3
stdout_logfile=/data/logs/baselayer-agent.log
stderr_logfile=/data/logs/baselayer-agent-error.log
[program:scry-daemon]
command=/bin/bash /opt/baselayer-test/scry.sh
autorestart=true
startsecs=2
stdout_logfile=/data/logs/scry-daemon.log
stderr_logfile=/data/logs/scry-daemon-error.log
CONF
exec supervisord -c /data/baselayer-supervisord.conf
