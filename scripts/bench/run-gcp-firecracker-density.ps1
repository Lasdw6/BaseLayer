param(
  [string]$InstanceName = "baselayer-firecracker-bench",
  [string]$RunName = "firecracker-density",
  [string]$Zone = "us-central1-a",
  [string]$MachineType = "n2-standard-8",
  [string]$RemoteHomePath = "",
  [string]$DiskSize = "80GB",
  [string]$ConcurrencyValues = "4,8,12,16,20,24",
  [int]$MaxConcurrency = 24,
  [int]$SoakSeconds = 5,
  [double]$ActiveSessionRatio = 0.5,
  [int]$ActiveRoundsPerSession = 2,
  [int]$ActivePauseMs = 250,
  [int]$WarmupIterations = 1,
  [int]$WarmupSoakSeconds = 2,
  [int]$WarmupActiveRounds = 1,
  [int]$SessionTimeoutSec = 300,
  [int]$SessionIdleTimeoutSec = 300,
  [int]$SessionActionTimeoutMs = 120000,
  [int]$MaxSessions = 24,
  [int]$PollIntervalSec = 15,
  [int]$TimeoutMinutes = 180,
  [string]$ArtifactCopyName = "",
  [string[]]$ExtraEnv = @(),
  [switch]$DetachOnly,
  [switch]$ValidateNetworkSlotsOnClaim,
  [switch]$SkipCreateInstance,
  [switch]$SkipSync,
  [switch]$SkipBootstrap,
  [switch]$SkipBuild,
  [switch]$PullResults,
  [switch]$DeleteWhenDone
)

$ErrorActionPreference = "Stop"
$env:CLOUDSDK_PREFER_WINDOWS_NATIVE_SSH = "true"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\\..")).Path
$archivePath = Join-Path $repoRoot "$InstanceName-sync.tar.gz"
$remoteHome = if ([string]::IsNullOrWhiteSpace($RemoteHomePath)) { "~" } else { $RemoteHomePath }
$remoteRoot = "$remoteHome/baselayer"
$safeRunName = ($RunName -replace '[^a-zA-Z0-9_-]', '-')
$remoteRunner = "$remoteHome/baselayer-bench-$safeRunName.sh"
$remoteStatusDir = "$remoteHome/baselayer-bench-status-$safeRunName"
$remotePidFile = "$remoteStatusDir/pid"
$remoteDoneFile = "$remoteStatusDir/done"
$remoteFailedFile = "$remoteStatusDir/failed"
$remoteLogFile = "$remoteStatusDir/bench.log"
$remoteExitCodeFile = "$remoteStatusDir/exit-code"

function Invoke-Gcloud {
  param([string[]]$CommandArgs)
  if (-not $CommandArgs -or $CommandArgs.Count -eq 0) {
    throw "Invoke-Gcloud called with no args."
  }
  Write-Host ">>> gcloud $($CommandArgs -join ' ')"
  & gcloud @CommandArgs
  if ($LASTEXITCODE -ne 0) {
    throw "gcloud failed with exit code $LASTEXITCODE"
  }
}

function Invoke-GcloudCapture {
  param([string[]]$CommandArgs)
  if (-not $CommandArgs -or $CommandArgs.Count -eq 0) {
    throw "Invoke-GcloudCapture called with no args."
  }
  Write-Host ">>> gcloud $($CommandArgs -join ' ')"
  $output = & gcloud @CommandArgs
  if ($LASTEXITCODE -ne 0) {
    throw "gcloud failed with exit code $LASTEXITCODE"
  }
  return $output
}

function Get-SshArgs {
  return @()
}

function Get-ScpArgs {
  return @()
}

function Write-RemoteScript {
  param([string]$Content)

  $tmpScript = Join-Path $repoRoot ".tmp-gcp\$InstanceName-bench-run.sh"
  New-Item -ItemType Directory -Force -Path (Split-Path $tmpScript) | Out-Null
  Set-Content -Path $tmpScript -Value $Content -NoNewline
  $scpArgs = @("compute","scp","--zone=$Zone") + (Get-ScpArgs) + @($tmpScript, "${InstanceName}:$remoteRunner")
  Invoke-Gcloud -CommandArgs $scpArgs
}

function Get-RemoteStatus {
  $statusCommand = @"
bash -lc 'set -euo pipefail
if [ -f "$remoteDoneFile" ]; then
  echo done
elif [ -f "$remoteFailedFile" ]; then
  echo failed
elif [ -f "$remotePidFile" ]; then
  pid=`$(cat "$remotePidFile" 2>/dev/null || true)
  if [ -n "`$pid" ] && kill -0 "`$pid" 2>/dev/null; then
    echo running
  else
    echo unknown
  fi
else
  echo missing
fi'
"@
  $sshArgs = @("compute","ssh",$InstanceName,"--zone=$Zone") + (Get-SshArgs) + @("--command=$statusCommand")
  return ((Invoke-GcloudCapture -CommandArgs $sshArgs) -join "`n").Trim()
}

function Get-RemoteTail {
  $tailCommand = @"
bash -lc 'if [ -f "$remoteLogFile" ]; then tail -n 40 "$remoteLogFile"; fi'
"@
  $sshArgs = @("compute","ssh",$InstanceName,"--zone=$Zone") + (Get-SshArgs) + @("--command=$tailCommand")
  return (Invoke-GcloudCapture -CommandArgs $sshArgs) -join "`n"
}

function Wait-ForRemoteCompletion {
  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  while ((Get-Date) -lt $deadline) {
    $status = Get-RemoteStatus
    if ($status -eq "done") {
      Write-Host "Remote benchmark completed."
      return
    }
    if ($status -eq "failed") {
      Write-Warning "Remote benchmark failed. Recent log output:"
      $tail = Get-RemoteTail
      if ($tail) {
        Write-Host $tail
      }
      throw "Remote benchmark failed."
    }

    Start-Sleep -Seconds $PollIntervalSec
  }

  Write-Warning "Timed out waiting for benchmark completion. Recent log output:"
  $tail = Get-RemoteTail
  if ($tail) {
    Write-Host $tail
  }
  throw "Timed out waiting for remote benchmark completion."
}

try {
  if (-not $SkipSync) {
    if (Test-Path $archivePath) {
      Remove-Item $archivePath -Force
    }

    Push-Location $repoRoot
    try {
      tar --exclude=node_modules --exclude=dist --exclude=data --exclude=artifacts --exclude=.git --exclude=.tmp-gcp --exclude=.tmp-gcp* --exclude=.tmp-* --exclude=*-sync.tar.gz --exclude=$([IO.Path]::GetFileName($archivePath)) -czf $archivePath .
    } finally {
      Pop-Location
    }
  }

  if (-not $SkipCreateInstance) {
    Invoke-Gcloud -CommandArgs @(
      "compute","instances","create",$InstanceName,
      "--zone=$Zone",
      "--machine-type=$MachineType",
      "--image-family=ubuntu-2204-lts",
      "--image-project=ubuntu-os-cloud",
      "--boot-disk-size=$DiskSize",
      "--min-cpu-platform=Intel Cascade Lake",
      "--metadata=enable-oslogin=FALSE",
      "--enable-nested-virtualization"
    )
  }
  if (-not $SkipSync) {
    Invoke-Gcloud -CommandArgs (@("compute","scp","--zone=$Zone") + (Get-ScpArgs) + @($archivePath, "${InstanceName}:$remoteHome/$InstanceName-sync.tar.gz"))
    Invoke-Gcloud -CommandArgs (@("compute","ssh",$InstanceName,"--zone=$Zone") + (Get-SshArgs) + @("--command=mkdir -p $remoteRoot && tar -xzf $remoteHome/$InstanceName-sync.tar.gz -C $remoteRoot"))
  }
  if (-not $SkipBootstrap) {
    Invoke-Gcloud -CommandArgs (@("compute","ssh",$InstanceName,"--zone=$Zone") + (Get-SshArgs) + @("--command=cd $remoteRoot && curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"))
    Invoke-Gcloud -CommandArgs (@("compute","ssh",$InstanceName,"--zone=$Zone") + (Get-SshArgs) + @("--command=cd $remoteRoot && PATH=/usr/bin:`$PATH bash ./scripts/bench/bootstrap-firecracker-linux.sh"))
    Invoke-Gcloud -CommandArgs (@("compute","ssh",$InstanceName,"--zone=$Zone") + (Get-SshArgs) + @("--command=cd $remoteRoot && PATH=/usr/bin:`$PATH bash ./scripts/firecracker/build-headless-shell-rootfs.sh"))
  }
  if (-not $SkipBuild) {
    Invoke-Gcloud -CommandArgs (@("compute","ssh",$InstanceName,"--zone=$Zone") + (Get-SshArgs) + @("--command=cd $remoteRoot && /usr/bin/npm run build && /usr/bin/npm test"))
  }

  $validateSlotsValue = if ($ValidateNetworkSlotsOnClaim) { "1" } else { "0" }
  $extraEnvLines = @()
  foreach ($entry in $ExtraEnv) {
    if ([string]::IsNullOrWhiteSpace($entry)) {
      continue
    }
    $extraEnvLines += "export $entry"
  }
  $extraEnvBlock = ($extraEnvLines -join "`n")
  $artifactCopyBlock = ""
  if (-not [string]::IsNullOrWhiteSpace($ArtifactCopyName)) {
    $artifactCopyBlock = "cp data/benchmarks/density-profile-c-firecracker-snapshot-c$MaxConcurrency.json data/benchmarks/$ArtifactCopyName"
  }
  $remoteScript = @"
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$remoteStatusDir"
rm -f "$remoteDoneFile" "$remoteFailedFile" "$remoteExitCodeFile"
echo `$$ > "$remotePidFile"
exec > >(tee "$remoteLogFile") 2>&1
trap 'code=`$?; echo `$code > "$remoteExitCodeFile"; if [ `$code -eq 0 ]; then touch "$remoteDoneFile"; else touch "$remoteFailedFile"; fi; rm -f "$remotePidFile"; exit `$code' EXIT
pkill -f "tsx src/bench/density.ts" || true
pkill -f "src/node-agent/server.ts" || true
pkill -f "src/api/server.ts" || true
cd "$remoteRoot"
export BENCH_ENABLE_FIRECRACKER=1
export BENCH_PROFILE_IDS=profile-c-firecracker-snapshot
export FIRECRACKER_KERNEL_PATH=$remoteRoot/artifacts/firecracker/vmlinux
export FIRECRACKER_ROOTFS_PATH=$remoteRoot/artifacts/firecracker/rootfs.ext4
export FIRECRACKER_SNAPSHOT_DIR=$remoteRoot/data/firecracker/snapshots
export FIRECRACKER_ALLOW_AUTO_SNAPSHOT=1
export BENCH_SITE_PUBLIC_HOST=172.22.0.1
export BENCH_MAX_CONCURRENCY=$MaxConcurrency
export BENCH_CONCURRENCY_VALUES=$ConcurrencyValues
export BENCH_SUCCESS_THRESHOLD=1
export BENCH_WARMUP_ITERATIONS=$WarmupIterations
export BENCH_WARMUP_SOAK_SECONDS=$WarmupSoakSeconds
export BENCH_WARMUP_ACTIVE_ROUNDS=$WarmupActiveRounds
export BENCH_SOAK_SECONDS=$SoakSeconds
export BENCH_ACTIVE_SESSION_RATIO=$ActiveSessionRatio
export BENCH_ACTIVE_ROUNDS_PER_SESSION=$ActiveRoundsPerSession
export BENCH_ACTIVE_PAUSE_MS=$ActivePauseMs
export BENCH_SESSION_TIMEOUT_SEC=$SessionTimeoutSec
export BENCH_SESSION_IDLE_TIMEOUT_SEC=$SessionIdleTimeoutSec
export BENCH_SESSION_ACTION_TIMEOUT_MS=$SessionActionTimeoutMs
export BENCH_FIRECRACKER_MAX_SESSIONS=$MaxSessions
export BENCH_FIRECRACKER_MAX_MICROVM_COUNT=$MaxSessions
export FIRECRACKER_NETWORK_SLOT_VALIDATE_ON_CLAIM=$validateSlotsValue
$extraEnvBlock
./node_modules/.bin/tsx src/bench/density.ts
$artifactCopyBlock
"@
  Write-RemoteScript -Content $remoteScript
  Invoke-Gcloud -CommandArgs (@("compute","ssh",$InstanceName,"--zone=$Zone") + (Get-SshArgs) + @("--command=chmod +x $remoteRunner && nohup bash $remoteRunner >/dev/null 2>&1 < /dev/null &"))

  if (-not $DetachOnly) {
    Wait-ForRemoteCompletion
  }

  if ($PullResults) {
    $resultsDir = Join-Path $repoRoot "data\\benchmarks\\$InstanceName"
    if (-not (Test-Path $resultsDir)) {
      New-Item -ItemType Directory -Path $resultsDir | Out-Null
    }
    Invoke-Gcloud -CommandArgs (@("compute","scp","--zone=$Zone","--recurse") + (Get-ScpArgs) + @("${InstanceName}:$remoteRoot/data/benchmarks", $resultsDir))
    Invoke-Gcloud -CommandArgs (@("compute","scp","--zone=$Zone") + (Get-ScpArgs) + @("${InstanceName}:$remoteLogFile", "$resultsDir\$safeRunName.log"))
  }
} finally {
  if ($DeleteWhenDone) {
    try {
      Invoke-Gcloud -CommandArgs @("compute","instances","delete",$InstanceName,"--zone=$Zone","--quiet")
    } catch {
      Write-Warning $_
    }
  }
}
