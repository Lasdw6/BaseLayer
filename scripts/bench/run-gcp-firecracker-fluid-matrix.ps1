param(
  [string]$InstanceName = "baselayer-firecracker-fluid-matrix",
  [string]$Zone = "us-central1-a",
  [string]$RemoteHomePath = "/home/ubuntu",
  [string]$MachineType = "n2-standard-8",
  [string]$DiskSize = "80GB",
  [int]$SoakSeconds = 300,
  [switch]$SkipCreateInstance,
  [switch]$SkipSync,
  [switch]$SkipBootstrap,
  [switch]$SkipBuild,
  [switch]$PullResults,
  [switch]$DeleteWhenDone
)

$ErrorActionPreference = "Stop"
$env:CLOUDSDK_PREFER_WINDOWS_NATIVE_SSH = "true"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$archivePath = Join-Path $repoRoot "$InstanceName-sync.tar.gz"
$remoteHome = $RemoteHomePath
$remoteRoot = "$remoteHome/baselayer"
$remoteRunner = "$remoteHome/baselayer-fluid5-matrix.sh"
$remoteStatusDir = "$remoteHome/baselayer-bench-status-fluid5-matrix"
$remoteLogFile = "$remoteStatusDir/bench.log"
$remoteDoneFile = "$remoteStatusDir/done"
$remoteFailedFile = "$remoteStatusDir/failed"

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

function Wait-ForRemoteCompletion {
  $deadline = (Get-Date).AddHours(2)
  while ((Get-Date) -lt $deadline) {
    $status = ((Invoke-GcloudCapture -CommandArgs @(
      "compute","ssh",$InstanceName,"--zone=$Zone","--command=bash -lc 'if [ -f ""$remoteDoneFile"" ]; then echo done; elif [ -f ""$remoteFailedFile"" ]; then echo failed; else echo running; fi'"
    )) -join "`n").Trim()
    if ($status -eq "done") { return }
    if ($status -eq "failed") {
      $tail = (Invoke-GcloudCapture -CommandArgs @(
        "compute","ssh",$InstanceName,"--zone=$Zone","--command=bash -lc 'tail -n 80 ""$remoteLogFile"" || true'"
      )) -join "`n"
      if ($tail) { Write-Host $tail }
      throw "Remote matrix failed."
    }
    Start-Sleep -Seconds 30
  }
  throw "Timed out waiting for remote matrix completion."
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
    Invoke-Gcloud -CommandArgs @("compute","scp","--zone=$Zone",$archivePath,"${InstanceName}:$remoteHome/$InstanceName-sync.tar.gz")
    Invoke-Gcloud -CommandArgs @("compute","ssh",$InstanceName,"--zone=$Zone","--command=mkdir -p $remoteRoot && tar -xzf $remoteHome/$InstanceName-sync.tar.gz -C $remoteRoot")
  }

  if (-not $SkipBootstrap) {
    Invoke-Gcloud -CommandArgs @("compute","ssh",$InstanceName,"--zone=$Zone","--command=cd $remoteRoot && curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs")
    Invoke-Gcloud -CommandArgs @("compute","ssh",$InstanceName,"--zone=$Zone","--command=cd $remoteRoot && PATH=/usr/bin:`$PATH bash ./scripts/bench/bootstrap-firecracker-linux.sh")
    Invoke-Gcloud -CommandArgs @("compute","ssh",$InstanceName,"--zone=$Zone","--command=cd $remoteRoot && PATH=/usr/bin:`$PATH bash ./scripts/firecracker/build-headless-shell-rootfs.sh")
  }

  if (-not $SkipBuild) {
    Invoke-Gcloud -CommandArgs @("compute","ssh",$InstanceName,"--zone=$Zone","--command=cd $remoteRoot && /usr/bin/npm run build && /usr/bin/npm test")
  }

  $remoteScript = @"
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$remoteStatusDir"
rm -f "$remoteDoneFile" "$remoteFailedFile"
exec > >(tee "$remoteLogFile") 2>&1
trap 'code=`$?; if [ `$code -eq 0 ]; then touch "$remoteDoneFile"; else touch "$remoteFailedFile"; fi; exit `$code' EXIT

run_case() {
  local run_name="$1"
  local concurrency="$2"
  local dynamic="$3"
  local cgroups="$4"
  local mode="$5"
  cd "$remoteRoot"
  pkill -f "tsx src/bench/density.ts" || true
  pkill -f "src/node-agent/server.ts" || true
  pkill -f "src/api/server.ts" || true
  export BENCH_ENABLE_FIRECRACKER=1
  export BENCH_PROFILE_IDS=profile-c-firecracker-snapshot
  export FIRECRACKER_KERNEL_PATH=$remoteRoot/artifacts/firecracker/vmlinux
  export FIRECRACKER_ROOTFS_PATH=$remoteRoot/artifacts/firecracker/rootfs.ext4
  export FIRECRACKER_SNAPSHOT_DIR=$remoteRoot/data/firecracker/snapshots
  export FIRECRACKER_ALLOW_AUTO_SNAPSHOT=1
  export BENCH_SITE_PUBLIC_HOST=172.22.0.1
  export BENCH_MAX_CONCURRENCY="$concurrency"
  export BENCH_CONCURRENCY_VALUES="$concurrency"
  export BENCH_SUCCESS_THRESHOLD=1
  export BENCH_WARMUP_ITERATIONS=1
  export BENCH_WARMUP_SOAK_SECONDS=2
  export BENCH_WARMUP_ACTIVE_ROUNDS=1
  export BENCH_SOAK_SECONDS=$SoakSeconds
  export BENCH_ACTIVE_SESSION_RATIO=0.5
  export BENCH_ACTIVE_ROUNDS_PER_SESSION=2
  export BENCH_ACTIVE_PAUSE_MS=250
  export BENCH_SESSION_TIMEOUT_SEC=1200
  export BENCH_SESSION_IDLE_TIMEOUT_SEC=1200
  export BENCH_SESSION_ACTION_TIMEOUT_MS=300000
  export BENCH_FIRECRACKER_MAX_SESSIONS="$concurrency"
  export BENCH_FIRECRACKER_MAX_MICROVM_COUNT="$concurrency"
  export FIRECRACKER_NETWORK_SLOT_VALIDATE_ON_CLAIM=0
  export BENCH_USE_DATA_URLS=1
  export FIRECRACKER_DYNAMIC_CPU_POLICY="$dynamic"
  export FIRECRACKER_DYNAMIC_CPU_CGROUPS="$cgroups"
  if [ -n "$mode" ]; then
    export FIRECRACKER_DYNAMIC_CPU_MODE="$mode"
  else
    unset FIRECRACKER_DYNAMIC_CPU_MODE || true
  fi
  ./node_modules/.bin/tsx src/bench/density.ts
  cp "data/benchmarks/density-profile-c-firecracker-snapshot-c${concurrency}.json" "data/benchmarks/${run_name}.json"
}

run_case fluid5-c12-baseline 12 0 0 ""
run_case fluid5-c24-baseline 24 0 0 ""
run_case fluid5-c12-always 12 1 1 "always"
run_case fluid5-c24-always 24 1 1 "always"
run_case fluid5-c12-hybrid 12 1 1 "hybrid"
run_case fluid5-c24-hybrid 24 1 1 "hybrid"
"@

  $tmpScript = Join-Path $repoRoot ".tmp-gcp\$InstanceName-fluid5-matrix.sh"
  New-Item -ItemType Directory -Force -Path (Split-Path $tmpScript) | Out-Null
  Set-Content -Path $tmpScript -Value $remoteScript -NoNewline
  Invoke-Gcloud -CommandArgs @("compute","scp","--zone=$Zone",$tmpScript,"${InstanceName}:$remoteRunner")
  Invoke-Gcloud -CommandArgs @("compute","ssh",$InstanceName,"--zone=$Zone","--command=chmod +x $remoteRunner && nohup bash $remoteRunner >/dev/null 2>&1 < /dev/null &")

  Wait-ForRemoteCompletion

  if ($PullResults) {
    $resultsDir = Join-Path $repoRoot "data\benchmarks\$InstanceName"
    if (-not (Test-Path $resultsDir)) {
      New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null
    }
    Invoke-Gcloud -CommandArgs @("compute","scp","--zone=$Zone","--recurse","${InstanceName}:$remoteRoot/data/benchmarks",$resultsDir)
    Invoke-Gcloud -CommandArgs @("compute","scp","--zone=$Zone","${InstanceName}:$remoteLogFile","$resultsDir\fluid5-matrix.log")
  }
}
finally {
  if ($DeleteWhenDone) {
    try {
      Invoke-Gcloud -CommandArgs @("compute","instances","delete",$InstanceName,"--zone=$Zone","--quiet")
    } catch {
      Write-Warning $_
    }
  }
}
