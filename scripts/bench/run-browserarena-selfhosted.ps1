param(
  [ValidateSet("runner", "local")]
  [string]$Mode = "runner",

  [string]$AwsProfile = "baselayer",
  [string]$Region = "us-east-1",
  [string]$MetalInstanceType = "m5zn.metal",
  [string]$RunnerInstanceType = "t3.micro",

  [string]$BaseLayerRepo = "https://github.com/Lasdw6/BaseLayer.git",
  [string]$BaseLayerRef = "main",
  [string]$BrowserArenaRepo = "https://github.com/nottelabs/browserarena.git",
  [string]$BrowserArenaRef = "main",
  [string]$BrowserArenaPath = "",

  [string]$Target = "https://example.com",
  [string]$Concurrency = "1,10",
  [int]$Runs = 100,
  [int]$Repeats = 1,
  [string]$RuntimeProfile = "BaseLayer-Mew-firecracker-headless-shell",

  [string]$RunnerMetadataPath = "",
  [switch]$ReuseRunner,
  [switch]$KeepMetal,
  [switch]$KeepRunner,
  [switch]$SkipMetalBootstrap,
  [switch]$NoOpenSshToWorld,

  [int]$SshTimeoutSec = 30,
  [int]$SetupTimeoutSec = 7200,
  [int]$BenchTimeoutSec = 1800,
  [string]$OutDir = ".tmp/browserarena-selfhosted"
)

$ErrorActionPreference = "Stop"

# One-shot self-hosted BrowserArena harness for BaseLayer.
#
# Modes:
#   runner: provision/use a t3.micro runner, provision fresh metal, run BrowserArena over SSH.
#   local:  provision fresh metal, run BrowserArena from a local checkout passed via -BrowserArenaPath.
#
# The BaseLayer metal host is always set up from -BaseLayerRepo/-BaseLayerRef so the
# benchmark exercises the current repo scripts rather than a hidden hand-built host.

function Resolve-RepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

function New-RunDirectory {
  param([string]$Root)
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  $dir = Join-Path $Root $stamp
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  return (Resolve-Path $dir).Path
}

function Invoke-Logged {
  param(
    [string]$Label,
    [string]$Command,
    [string]$WorkDir = (Resolve-RepoRoot),
    [int]$TimeoutSec = 300
  )

  Write-Host "==> $Label"
  $stdoutPath = [System.IO.Path]::GetTempFileName()
  $stderrPath = [System.IO.Path]::GetTempFileName()
  $process = Start-Process powershell -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    $Command
  ) -WorkingDirectory $WorkDir -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru

  if (-not $process.WaitForExit($TimeoutSec * 1000)) {
    try {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    } catch {
      # ignore cleanup races
    }
    Get-Content $stdoutPath -ErrorAction SilentlyContinue | Write-Host
    Get-Content $stderrPath -ErrorAction SilentlyContinue | Write-Host
    Remove-Item -Force -ErrorAction SilentlyContinue $stdoutPath, $stderrPath
    throw "Timed out after ${TimeoutSec}s: $Label"
  }

  $stdout = @(Get-Content $stdoutPath -ErrorAction SilentlyContinue)
  $stderr = @(Get-Content $stderrPath -ErrorAction SilentlyContinue)
  Remove-Item -Force -ErrorAction SilentlyContinue $stdoutPath, $stderrPath

  if ($stdout.Count -gt 0) {
    $stdout | Write-Host
  }
  if ($stderr.Count -gt 0) {
    $stderr | Write-Host
  }
  if ($process.ExitCode -ne 0) {
    throw "Command failed: $Label"
  }
  return $stdout + $stderr
}

function Invoke-Ssh {
  param(
    [pscustomobject]$HostMeta,
    [string]$RemoteCommand,
    [string]$LogPath,
    [int]$TimeoutSec = 30
  )

  $root = Resolve-RepoRoot
  $json = [System.IO.Path]::ChangeExtension($LogPath, ".json")
  $normalizedRemoteCommand = $RemoteCommand -replace "`r`n", "`n"
  $encodedRemoteCommand = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($normalizedRemoteCommand))
  $remoteShell = "printf %s $encodedRemoteCommand ``| base64 -d ``| bash"
  $ssh = @(
    "node scripts/ssh-run.mjs",
    "--timeout-sec=$TimeoutSec",
    "--log=`"$LogPath`"",
    "--json-result=`"$json`"",
    "--",
    "ssh -n -T",
    "-o StrictHostKeyChecking=no",
    "-o UserKnownHostsFile=/dev/null",
    "-o LogLevel=ERROR",
    "-o IdentitiesOnly=yes",
    "-i `"$($HostMeta.keyPath)`"",
    "`"ubuntu@$($HostMeta.publicIp)`"",
    "`"$remoteShell`""
  ) -join " "
  try {
    Invoke-Logged -Label "ssh $($HostMeta.publicIp)" -Command $ssh -WorkDir $root -TimeoutSec ($TimeoutSec + 20) | Out-Null
  } catch {
    if (Test-Path -LiteralPath $json) {
      $result = Get-Content $json | ConvertFrom-Json
      if ($result.exitCode -eq 0) {
        return
      }
    }
    throw
  }
}

function Invoke-ScpFrom {
  param(
    [pscustomobject]$HostMeta,
    [string]$RemotePath,
    [string]$LocalPath,
    [string]$LogPath,
    [int]$TimeoutSec = 120
  )

  $root = Resolve-RepoRoot
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LocalPath) | Out-Null
  $json = [System.IO.Path]::ChangeExtension($LogPath, ".json")
  $scp = @(
    "node scripts/ssh-run.mjs",
    "--timeout-sec=$TimeoutSec",
    "--log=`"$LogPath`"",
    "--json-result=`"$json`"",
    "--",
    "scp.exe -q",
    "-o StrictHostKeyChecking=no",
    "-o UserKnownHostsFile=/dev/null",
    "-o LogLevel=ERROR",
    "-o IdentitiesOnly=yes",
    "-i `"$($HostMeta.keyPath)`"",
    "`"ubuntu@$($HostMeta.publicIp):$RemotePath`"",
    "`"$LocalPath`""
  ) -join " "
  try {
    Invoke-Logged -Label "scp $RemotePath" -Command $scp -WorkDir $root -TimeoutSec ($TimeoutSec + 20) | Out-Null
  } catch {
    if (Test-Path -LiteralPath $json) {
      $result = Get-Content $json | ConvertFrom-Json
      if ($result.exitCode -eq 0) {
        return
      }
    }
    throw
  }
}

function Invoke-ScpTo {
  param(
    [pscustomobject]$HostMeta,
    [string]$LocalPath,
    [string]$RemotePath,
    [string]$LogPath,
    [int]$TimeoutSec = 120
  )

  $root = Resolve-RepoRoot
  $json = [System.IO.Path]::ChangeExtension($LogPath, ".json")
  $scp = @(
    "node scripts/ssh-run.mjs",
    "--timeout-sec=$TimeoutSec",
    "--log=`"$LogPath`"",
    "--json-result=`"$json`"",
    "--",
    "scp.exe -q",
    "-o StrictHostKeyChecking=no",
    "-o UserKnownHostsFile=/dev/null",
    "-o LogLevel=ERROR",
    "-o IdentitiesOnly=yes",
    "-i `"$($HostMeta.keyPath)`"",
    "`"$LocalPath`"",
    "`"ubuntu@$($HostMeta.publicIp):$RemotePath`""
  ) -join " "
  try {
    Invoke-Logged -Label "scp $LocalPath" -Command $scp -WorkDir $root -TimeoutSec ($TimeoutSec + 20) | Out-Null
  } catch {
    if (Test-Path -LiteralPath $json) {
      $result = Get-Content $json | ConvertFrom-Json
      if ($result.exitCode -eq 0) {
        return
      }
    }
    throw
  }
}

function Wait-ForSsh {
  param(
    [pscustomobject]$HostMeta,
    [string]$LogDir,
    [int]$TimeoutSec = 600
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $attempt = 0
  while ((Get-Date) -lt $deadline) {
    $attempt += 1
    try {
      Invoke-Ssh -HostMeta $HostMeta -RemoteCommand "echo ssh-ready" -LogPath (Join-Path $LogDir "ssh-ready-$attempt.log") -TimeoutSec $SshTimeoutSec
      return
    } catch {
      Start-Sleep -Seconds 10
    }
  }
  throw "Timed out waiting for SSH on $($HostMeta.publicIp)."
}

function Wait-ForBaseLayer {
  param(
    [pscustomobject]$Metal,
    [string]$LogDir,
    [int]$TimeoutSec = 900
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $attempt = 0
  while ((Get-Date) -lt $deadline) {
    $attempt += 1
    $remote = "bash -lc 'curl -fsS http://127.0.0.1:3000/health; echo; curl -fsS http://127.0.0.1:4000/health; echo'"
    try {
      Invoke-Ssh -HostMeta $Metal -RemoteCommand $remote -LogPath (Join-Path $LogDir "baselayer-health-$attempt.log") -TimeoutSec $SshTimeoutSec
      $log = Get-Content (Join-Path $LogDir "baselayer-health-$attempt.log") -ErrorAction SilentlyContinue | Out-String
      if ($log -match '"hosts":1' -and $log -match '"ok":true') {
        return
      }
    } catch {
      # keep polling
    }
    Start-Sleep -Seconds 10
  }
  throw "Timed out waiting for BaseLayer health on $($Metal.publicIp)."
}

function Wait-ForWarmPool {
  param(
    [pscustomobject]$Metal,
    [string]$LogDir,
    [int]$ExpectedDepth = 30,
    [int]$TimeoutSec = 1200
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $attempt = 0
  while ((Get-Date) -lt $deadline) {
    $attempt += 1
    $remote = "bash -lc 'curl -fsS http://127.0.0.1:4000/health; echo'"
    try {
      Invoke-Ssh -HostMeta $Metal -RemoteCommand $remote -LogPath (Join-Path $LogDir "warm-pool-$attempt.log") -TimeoutSec $SshTimeoutSec
      $log = Get-Content (Join-Path $LogDir "warm-pool-$attempt.log") -ErrorAction SilentlyContinue | Out-String
      $healthLine = ($log -split "`n" | Where-Object { $_ -match '^\{"ok":true,' } | Select-Object -Last 1)
      if ($healthLine) {
        $health = $healthLine | ConvertFrom-Json
      }
      if ($health -and $health.warmPoolDepth -ge $ExpectedDepth -and $health.warmPoolTarget -ge $ExpectedDepth) {
        return
      }
    } catch {
      # keep polling
    }
    Start-Sleep -Seconds 15
  }
  throw "Timed out waiting for warm pool depth $ExpectedDepth on $($Metal.publicIp)."
}

function Provision-Runner {
  param([string]$RunDir)

  if ($ReuseRunner) {
    if (-not $RunnerMetadataPath) {
      throw "-ReuseRunner requires -RunnerMetadataPath."
    }
    return Get-Content $RunnerMetadataPath | ConvertFrom-Json
  }

  $metaPath = if ($RunnerMetadataPath) { $RunnerMetadataPath } else { Join-Path $RunDir "runner.json" }
  $cmd = "& `"$PSScriptRoot\aws-provision-runner.ps1`" -Profile `"$AwsProfile`" -Region `"$Region`" -InstanceType `"$RunnerInstanceType`" -NamePrefix `"baselayer-browserarena-runner`" -MetadataPath `"$metaPath`""
  try {
    Invoke-Logged -Label "provision runner" -Command $cmd -TimeoutSec 900 | Out-Null
  } catch {
    if (-not (Test-Path -LiteralPath $metaPath)) {
      throw
    }
    Write-Host "provision runner returned nonzero after writing metadata; continuing"
  }
  return Get-Content $metaPath | ConvertFrom-Json
}

function Provision-Metal {
  param(
    [string]$RunDir,
    [string]$ProviderCidr
  )

  $metaPath = Join-Path $RunDir "metal.json"
  $openSsh = if ($NoOpenSshToWorld) { "" } else { "-OpenSshToWorld" }
  $cmd = "& `"$PSScriptRoot\aws-provision-baremetal.ps1`" -Profile `"$AwsProfile`" -Region `"$Region`" -InstanceType `"$MetalInstanceType`" -NamePrefix `"baselayer-browserarena-metal`" -VolumeSizeGb 100 -RunningTimeoutSec 600 -MetadataPath `"$metaPath`" $openSsh -OpenProviderPorts -ProviderAccessCidr `"$ProviderCidr`""
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try {
      Invoke-Logged -Label "provision metal" -Command $cmd -TimeoutSec 1200 | Out-Null
      return Get-Content $metaPath | ConvertFrom-Json
    } catch {
      $message = $_.Exception.Message
      if (Test-Path -LiteralPath $metaPath) {
        Write-Host "provision metal returned nonzero after writing metadata; continuing"
        return Get-Content $metaPath | ConvertFrom-Json
      }

      if ($message -match "VcpuLimitExceeded" -and $attempt -lt 4) {
        $sleepSec = 900
        Write-Host "metal provisioning hit regional vCPU quota while previous bare-metal capacity is releasing; retrying in ${sleepSec}s (attempt $attempt/4)"
        Start-Sleep -Seconds $sleepSec
        continue
      }

      throw
    }
  }

  throw "Failed to provision metal."
}

function Get-RunnerAccessCidr {
  param([pscustomobject]$Runner)
  if ($Mode -eq "runner") {
    return "$($Runner.publicIp)/32"
  }
  try {
    return ((Invoke-RestMethod -Uri "https://checkip.amazonaws.com/" -TimeoutSec 10).Trim() + "/32")
  } catch {
    return "0.0.0.0/0"
  }
}

function Setup-Runner {
  param(
    [pscustomobject]$Runner,
    [string]$LogDir
  )

  if ($BrowserArenaPath) {
    $resolvedBrowserArenaPath = (Resolve-Path $BrowserArenaPath).Path
    $providerFile = Join-Path $resolvedBrowserArenaPath "src/providers/baselayer.ts"
    if (-not (Test-Path -LiteralPath $providerFile)) {
      throw "BrowserArena checkout at $resolvedBrowserArenaPath does not include src/providers/baselayer.ts."
    }

    $archivePath = Join-Path $LogDir "browserarena-runner-src.tgz"
    $tarCommand = "tar --exclude=.git --exclude=node_modules --exclude=results --exclude=logs -czf `"$archivePath`" -C `"$resolvedBrowserArenaPath`" ."
    try {
      Invoke-Logged -Label "package local BrowserArena checkout" -Command $tarCommand -TimeoutSec 300 | Out-Null
    } catch {
      if (-not (Test-Path -LiteralPath $archivePath)) {
        throw
      }
      Write-Host "package local BrowserArena checkout returned nonzero after writing archive; continuing"
    }

    Invoke-Ssh -HostMeta $Runner -RemoteCommand "bash -lc 'rm -rf /home/ubuntu/browserarena /home/ubuntu/browserarena-src.tgz; mkdir -p /home/ubuntu/browserarena'" -LogPath (Join-Path $LogDir "prepare-runner-upload.log") -TimeoutSec $SshTimeoutSec
    Invoke-ScpTo -HostMeta $Runner -LocalPath $archivePath -RemotePath "/home/ubuntu/browserarena-src.tgz" -LogPath (Join-Path $LogDir "upload-browserarena.log") -TimeoutSec 300

    $remote = @"
bash -lc 'set -euo pipefail
apt_update_retry() {
  local attempt
  for attempt in 1 2 3; do
    if sudo apt-get update -y; then
      return 0
    fi
    sudo rm -rf /var/lib/apt/lists/*
    sudo mkdir -p /var/lib/apt/lists/partial
    sleep `$((attempt * 5))
  done
  sudo apt-get update -y
}
apt_update_retry
sudo apt-get install -y git ca-certificates curl
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
rm -rf /home/ubuntu/browserarena
mkdir -p /home/ubuntu/browserarena
tar -xzf /home/ubuntu/browserarena-src.tgz -C /home/ubuntu/browserarena
cd /home/ubuntu/browserarena
npm ci
test -f src/providers/baselayer.ts || { echo "Uploaded BrowserArena checkout does not include src/providers/baselayer.ts."; exit 20; }
'
"@
    Invoke-Ssh -HostMeta $Runner -RemoteCommand $remote -LogPath (Join-Path $LogDir "setup-runner.log") -TimeoutSec $SetupTimeoutSec
    return
  }

  $remote = @"
bash -lc 'set -euo pipefail
apt_update_retry() {
  local attempt
  for attempt in 1 2 3; do
    if sudo apt-get update -y; then
      return 0
    fi
    sudo rm -rf /var/lib/apt/lists/*
    sudo mkdir -p /var/lib/apt/lists/partial
    sleep `$((attempt * 5))
  done
  sudo apt-get update -y
}
apt_update_retry
sudo apt-get install -y git ca-certificates curl
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
rm -rf /home/ubuntu/browserarena
git clone --depth 1 --branch "$BrowserArenaRef" "$BrowserArenaRepo" /home/ubuntu/browserarena
cd /home/ubuntu/browserarena
npm ci
if [ ! -f src/providers/baselayer.ts ]; then
  rm -rf /tmp/baselayer-browserarena-provider
  git clone --depth 1 --branch "$BaseLayerRef" "$BaseLayerRepo" /tmp/baselayer-browserarena-provider
  cp /tmp/baselayer-browserarena-provider/scripts/bench/browserarena-provider/baselayer.ts src/providers/baselayer.ts
  node <<NODE
const fs = require("fs");

function replaceOnce(path, search, replacement) {
  const before = fs.readFileSync(path, "utf8");
  if (before.includes(replacement)) return;
  if (!before.includes(search)) {
    throw new Error("Could not patch " + path + ": missing needle");
  }
  fs.writeFileSync(path, before.replace(search, replacement));
}

replaceOnce(
  "src/providers/index.ts",
  "import { BrowserUseProvider } from \"./browser-use.js\";",
  "import { BrowserUseProvider } from \"./browser-use.js\";\nimport { BaseLayerProvider } from \"./baselayer.js\";",
);
replaceOnce(
  "src/providers/index.ts",
  "  if (key === \"browser-use\" || key === \"browseruse\" || key === \"bu\")\n    return [\"BROWSER_USE_API_KEY\"];",
  "  if (key === \"browser-use\" || key === \"browseruse\" || key === \"bu\")\n    return [\"BROWSER_USE_API_KEY\"];\n  if (key === \"baselayer\" || key === \"base-layer\") return [\"BASELAYER_API_URL\"];",
);
replaceOnce(
  "src/providers/index.ts",
  "  if (key === \"browser-use\" || key === \"browseruse\" || key === \"bu\")\n    return new BrowserUseProvider();",
  "  if (key === \"browser-use\" || key === \"browseruse\" || key === \"bu\")\n    return new BrowserUseProvider();\n  if (key === \"baselayer\" || key === \"base-layer\") return new BaseLayerProvider();",
);
replaceOnce(
  "src/types.ts",
  "  | \"BROWSER_USE\";",
  "  | \"BROWSER_USE\"\n  | \"BASELAYER\";",
);
NODE
fi
test -f src/providers/baselayer.ts || { echo "BrowserArena checkout does not include src/providers/baselayer.ts and patching failed."; exit 20; }
'
"@
  Invoke-Ssh -HostMeta $Runner -RemoteCommand $remote -LogPath (Join-Path $LogDir "setup-runner.log") -TimeoutSec $SetupTimeoutSec
}

function Setup-Metal {
  param(
    [pscustomobject]$Metal,
    [string]$LogDir
  )

  $clone = @"
bash -lc 'set -euo pipefail
apt_update_retry() {
  local attempt
  for attempt in 1 2 3; do
    if sudo apt-get update -y; then
      return 0
    fi
    sudo rm -rf /var/lib/apt/lists/*
    sudo mkdir -p /var/lib/apt/lists/partial
    sleep `$((attempt * 5))
  done
  sudo apt-get update -y
}
apt_update_retry
sudo apt-get install -y git ca-certificates curl
rm -rf /home/ubuntu/baselayer
git clone --depth 1 --branch "$BaseLayerRef" "$BaseLayerRepo" /home/ubuntu/baselayer
sudo chown -R ubuntu:ubuntu /home/ubuntu/baselayer
'
"@
  Invoke-Ssh -HostMeta $Metal -RemoteCommand $clone -LogPath (Join-Path $LogDir "clone-baselayer.log") -TimeoutSec 900

  if (-not $SkipMetalBootstrap) {
    $bootstrap = "bash -lc 'cd /home/ubuntu/baselayer && sudo -E bash scripts/bench/bootstrap-baremetal-provider-host.sh'"
    Invoke-Ssh -HostMeta $Metal -RemoteCommand $bootstrap -LogPath (Join-Path $LogDir "bootstrap-metal.log") -TimeoutSec $SetupTimeoutSec
  }
}

function Start-BaseLayer {
  param(
    [pscustomobject]$Metal,
    [string]$LogDir
  )

  $publicIp = $Metal.publicIp
  $remote = @"
bash -lc 'set -euo pipefail
cd /home/ubuntu/baselayer
sudo pkill -9 node || true
sudo pkill -9 firecracker || true
sudo pkill -9 socat || true
sudo rm -rf /run/user/0/baselayer-fc /run/user/1000/baselayer-fc /tmp/baselayer-* data/state.json data/sessions data/artifacts 2>/dev/null || true
sudo chown -R ubuntu:ubuntu data artifacts 2>/dev/null || true
mkdir -p data
printf "[]\n" > data/provider-hosts-empty.json
nohup sudo -E env \
  CONTROL_PLANE_PROVIDER_HOST_CONFIG_PATH=/home/ubuntu/baselayer/data/provider-hosts-empty.json \
  CONTROL_PLANE_ENFORCE_HOST_ALLOWLIST=0 \
  CONTROL_PLANE_ASYNC_SESSION_DELETE=1 \
  CONTROL_PLANE_TERMINATED_SESSION_RETENTION=25 \
  CONTROL_PLANE_SCHEDULER_ADMISSION_WAIT_MS=30000 \
  CONTROL_PLANE_SCHEDULER_ADMISSION_POLL_MS=250 \
  CONTROL_PLANE_HOST_DELETE_RESERVATION_TTL_MS=3000 \
  CONTROL_PLANE_REMOTE_CREATE_TIMEOUT_MS=180000 \
  CONTROL_PLANE_REMOTE_CREATE_RETRIES=0 \
  MAX_SESSIONS=20 \
  FIRECRACKER_MAX_MICROVM_COUNT=44 \
  FIRECRACKER_NETWORK_POOL_SIZE=44 \
  WARM_POOL_SIZE=30 \
  WARM_POOL_RESERVE=4 \
  WARM_POOL_FILL_CONCURRENCY=4 \
  NODE_AGENT_LAUNCH_ADMISSION_WAIT_MS=175000 \
  NODE_AGENT_LAUNCH_ADMISSION_POLL_MS=100 \
  FIRECRACKER_LAUNCH_CONCURRENCY=4 \
  FIRECRACKER_COLD_RESTORE_CONCURRENCY=2 \
  FIRECRACKER_WARM_CLAIM_TIMEOUT_MS=3000 \
  FIRECRACKER_WARM_WAIT_MS=175000 \
  FIRECRACKER_WARM_FALLBACK_TO_COLD=0 \
  BASELAYER_SUPPORTED_RUNTIME_PROFILES="$RuntimeProfile" \
  BASELAYER_RESET_STATE_ON_START=1 \
  BASELAYER_DISABLE_IRQBALANCE=1 \
  bash ./scripts/bench/aws-start-public-baselayer.sh /home/ubuntu/baselayer "$publicIp" \
  > /home/ubuntu/baselayer/baselayer-selfhosted.log 2>&1 < /dev/null &
echo baselayer-started
'
"@
  Invoke-Ssh -HostMeta $Metal -RemoteCommand $remote -LogPath (Join-Path $LogDir "start-baselayer.log") -TimeoutSec 60
}

function Run-Benchmark-OnRunner {
  param(
    [pscustomobject]$Runner,
    [pscustomobject]$Metal,
    [string]$LogDir
  )

  $api = "http://$($Metal.publicIp):3000"
  $remote = @"
bash -lc 'set -euo pipefail
cd /home/ubuntu/browserarena
DATE="`$(date -u +%F)"
rm -rf "results/hello-browser/baselayer/`$DATE"
BASELAYER_API_URL="$api" BASELAYER_BASE_URL="$api" BASELAYER_RUNTIME_PROFILE="$RuntimeProfile" npm run bench -- \
  --benchmark=hello-browser \
  --provider=baselayer \
  --concurrency=$Concurrency \
  --runs=$Runs \
  --url="$Target"
echo "RESULT_DATE=`$DATE"
'
"@
  Invoke-Ssh -HostMeta $Runner -RemoteCommand $remote -LogPath (Join-Path $LogDir "browserarena-runner.log") -TimeoutSec $BenchTimeoutSec
}

function Run-Benchmark-Local {
  param(
    [pscustomobject]$Metal,
    [string]$LogDir
  )

  if (-not $BrowserArenaPath) {
    throw "Mode=local requires -BrowserArenaPath pointing to a BrowserArena checkout with the BaseLayer provider."
  }
  $path = (Resolve-Path $BrowserArenaPath).Path
  $providerFile = Join-Path $path "src/providers/baselayer.ts"
  if (-not (Test-Path -LiteralPath $providerFile)) {
    throw "BrowserArena checkout at $path does not include src/providers/baselayer.ts."
  }
  $api = "http://$($Metal.publicIp):3000"
  $cmd = @"
`$env:BASELAYER_API_URL="$api";
`$env:BASELAYER_BASE_URL="$api";
`$env:BASELAYER_RUNTIME_PROFILE="$RuntimeProfile";
npm run bench -- --benchmark=hello-browser --provider=baselayer --concurrency=$Concurrency --runs=$Runs --url="$Target"
"@
  Invoke-Logged -Label "local BrowserArena benchmark" -Command $cmd -WorkDir $path -TimeoutSec $BenchTimeoutSec | Tee-Object -FilePath (Join-Path $LogDir "browserarena-local.log") | Out-Null
}

function Pull-RunnerArtifacts {
  param(
    [pscustomobject]$Runner,
    [string]$LogDir,
    [string]$ArtifactDir
  )

  $dateLog = Join-Path $LogDir "browserarena-runner.log"
  $date = ((Get-Content $dateLog -ErrorAction SilentlyContinue | Select-String "RESULT_DATE=" | Select-Object -Last 1).ToString() -replace ".*RESULT_DATE=", "").Trim()
  if (-not $date) {
    $date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
  }
  foreach ($c in ($Concurrency -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    $remote = "/home/ubuntu/browserarena/results/hello-browser/baselayer/$date/c$c/results.jsonl"
    $local = Join-Path $ArtifactDir "c$c-results.jsonl"
    Invoke-ScpFrom -HostMeta $Runner -RemotePath $remote -LocalPath $local -LogPath (Join-Path $LogDir "pull-c$c.log") -TimeoutSec 180
  }
}

function Pull-MetalDiagnostics {
  param(
    [pscustomobject]$Metal,
    [string]$LogDir
  )

  if (-not $Metal) {
    return
  }

  $diagDir = Join-Path $LogDir "metal-diagnostics"
  New-Item -ItemType Directory -Force -Path $diagDir | Out-Null

  $remote = @'
bash -lc 'set +e
cd /home/ubuntu/baselayer 2>/dev/null || exit 0
mkdir -p /tmp/baselayer-selfhosted-diagnostics
cp /home/ubuntu/baselayer/baselayer-selfhosted.log /tmp/baselayer-selfhosted-diagnostics/baselayer-selfhosted.log 2>/dev/null || true
cp /home/ubuntu/baselayer/data/state.json /tmp/baselayer-selfhosted-diagnostics/state.json 2>/dev/null || true
curl -fsS http://127.0.0.1:3000/health > /tmp/baselayer-selfhosted-diagnostics/control-plane-health.json 2>/dev/null || true
curl -fsS http://127.0.0.1:4000/health > /tmp/baselayer-selfhosted-diagnostics/node-agent-health.json 2>/dev/null || true
tar -C /tmp -czf /tmp/baselayer-selfhosted-diagnostics.tgz baselayer-selfhosted-diagnostics
'
'@

  try {
    Invoke-Ssh -HostMeta $Metal -RemoteCommand $remote -LogPath (Join-Path $LogDir "collect-metal-diagnostics.log") -TimeoutSec 30
    Invoke-ScpFrom -HostMeta $Metal -RemotePath "/tmp/baselayer-selfhosted-diagnostics.tgz" -LocalPath (Join-Path $diagDir "baselayer-selfhosted-diagnostics.tgz") -LogPath (Join-Path $LogDir "pull-metal-diagnostics.log") -TimeoutSec 120
  } catch {
    Write-Warning "Could not pull metal diagnostics: $($_.Exception.Message)"
  }
}

function Copy-LocalArtifacts {
  param([string]$ArtifactDir)

  $date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
  $path = (Resolve-Path $BrowserArenaPath).Path
  foreach ($c in ($Concurrency -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    $src = Join-Path $path "results/hello-browser/baselayer/$date/c$c/results.jsonl"
    if (-not (Test-Path -LiteralPath $src)) {
      throw "Missing local BrowserArena artifact: $src"
    }
    Copy-Item -LiteralPath $src -Destination (Join-Path $ArtifactDir "c$c-results.jsonl") -Force
  }
}

function Write-Summary {
  param([string]$ArtifactDir)

  $summaryScript = @'
const fs = require("fs");
const path = require("path");
const dir = process.argv[2];
const med = (xs) => {
  xs = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
};
const rows = [];
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith("-results.jsonl")).sort()) {
  const records = fs.readFileSync(path.join(dir, file), "utf8").trim().split(/\n+/).filter(Boolean).map(JSON.parse);
  const ok = records.filter((r) => r.success);
  const create = med(ok.map((r) => r.session_creation_ms));
  const connect = med(ok.map((r) => r.session_connect_ms));
  const goto = med(ok.map((r) => r.page_goto_ms));
  const release = med(ok.map((r) => r.session_release_ms));
  const medianTotal = med(ok.map((r) => r.session_creation_ms + r.session_connect_ms + r.page_goto_ms + r.session_release_ms));
  rows.push({
    file,
    success: `${ok.length}/${records.length}`,
    median_total_ms: Number(medianTotal?.toFixed(1)),
    stage_sum_ms: Number((create + connect + goto + release).toFixed(1)),
    create_ms: Number(create?.toFixed(1)),
    connect_ms: Number(connect?.toFixed(1)),
    goto_ms: Number(goto?.toFixed(1)),
    release_ms: Number(release?.toFixed(1)),
  });
}
fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(rows, null, 2) + "\n");
console.log(JSON.stringify(rows, null, 2));
'@
  $summaryPath = Join-Path $ArtifactDir "summarize.cjs"
  $summaryScript | Set-Content -LiteralPath $summaryPath -Encoding ASCII
  node $summaryPath $ArtifactDir | Tee-Object -FilePath (Join-Path $ArtifactDir "summary.txt")
}

function Stop-Instance {
  param([pscustomobject]$Meta, [string]$Label)
  if (-not $Meta -or -not $Meta.instanceId) {
    return
  }
  Write-Host "==> terminating $Label $($Meta.instanceId)"
  aws.exe ec2 terminate-instances --profile $AwsProfile --region $Meta.region --instance-ids $Meta.instanceId --query "TerminatingInstances[0].CurrentState.Name" --output text | Write-Host
  Write-Host "==> waiting for $Label $($Meta.instanceId) to terminate"
  aws.exe ec2 wait instance-terminated --profile $AwsProfile --region $Meta.region --instance-ids $Meta.instanceId
}

$repoRoot = Resolve-RepoRoot
$runRoot = New-RunDirectory -Root (Join-Path $repoRoot $OutDir)
$manifest = [ordered]@{
  mode = $Mode
  awsProfile = $AwsProfile
  region = $Region
  baseLayerRepo = $BaseLayerRepo
  baseLayerRef = $BaseLayerRef
  browserArenaRepo = $BrowserArenaRepo
  browserArenaRef = $BrowserArenaRef
  target = $Target
  concurrency = $Concurrency
  runs = $Runs
  repeats = $Repeats
  runtimeProfile = $RuntimeProfile
  startedAt = (Get-Date).ToUniversalTime().ToString("o")
  repeatsData = @()
}

if ($Repeats -le 0) {
  $manifest.finishedAt = (Get-Date).ToUniversalTime().ToString("o")
  $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $runRoot "manifest.json") -Encoding UTF8
  Write-Host "selfhosted-run-dir=$runRoot"
  exit 0
}

$runner = $null
try {
  if ($Mode -eq "runner") {
    $runner = Provision-Runner -RunDir $runRoot
    Wait-ForSsh -HostMeta $runner -LogDir $runRoot
    Setup-Runner -Runner $runner -LogDir $runRoot
  }

  for ($i = 1; $i -le $Repeats; $i++) {
    $repeatDir = Join-Path $runRoot "repeat-$i"
    $logDir = Join-Path $repeatDir "logs"
    $artifactDir = Join-Path $repeatDir "artifacts"
    New-Item -ItemType Directory -Force -Path $logDir, $artifactDir | Out-Null

    $providerCidr = if ($Mode -eq "runner") { Get-RunnerAccessCidr -Runner $runner } else { Get-RunnerAccessCidr -Runner $null }
    $metal = $null
    try {
      $metal = Provision-Metal -RunDir $repeatDir -ProviderCidr $providerCidr
      Wait-ForSsh -HostMeta $metal -LogDir $logDir
      Setup-Metal -Metal $metal -LogDir $logDir
      Start-BaseLayer -Metal $metal -LogDir $logDir
      Wait-ForBaseLayer -Metal $metal -LogDir $logDir
      Wait-ForWarmPool -Metal $metal -LogDir $logDir

      if ($Mode -eq "runner") {
        Run-Benchmark-OnRunner -Runner $runner -Metal $metal -LogDir $logDir
        Pull-RunnerArtifacts -Runner $runner -LogDir $logDir -ArtifactDir $artifactDir
      } else {
        Run-Benchmark-Local -Metal $metal -LogDir $logDir
        Copy-LocalArtifacts -ArtifactDir $artifactDir
      }

      Write-Summary -ArtifactDir $artifactDir
      $manifest.repeatsData += [ordered]@{
        repeat = $i
        metal = $metal
        artifacts = $artifactDir
      }
    } finally {
      Pull-MetalDiagnostics -Metal $metal -LogDir $logDir
      if ($metal -and -not $KeepMetal) {
        Stop-Instance -Meta $metal -Label "metal"
      }
    }
  }
} finally {
  $manifest.finishedAt = (Get-Date).ToUniversalTime().ToString("o")
  $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $runRoot "manifest.json") -Encoding UTF8
  if ($runner -and -not $KeepRunner -and -not $ReuseRunner) {
    Stop-Instance -Meta $runner -Label "runner"
  }
  Write-Host "selfhosted-run-dir=$runRoot"
}
