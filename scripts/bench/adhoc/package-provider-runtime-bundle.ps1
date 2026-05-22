param(
  [string]$BundlePath = ".tmp/baselayer-provider-runtime.tar.gz",
  [switch]$IncludeArtifacts,
  [switch]$IncludeNodeModules,
  # Directory containing headless_shell or chrome-headless-shell plus icudtl.dat, *.pak, etc.
  # Staged on the host under artifacts/custom-chromium-runtime/ for prepare-basic-profiles-host.sh.
  [string]$CustomChromiumRuntimePath = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$bundleFullPath = if ([System.IO.Path]::IsPathRooted($BundlePath)) {
  $BundlePath
} else {
  Join-Path $repoRoot $BundlePath
}

$bundleDir = Split-Path -Parent $bundleFullPath
if ($bundleDir) {
  New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null
}

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("baselayer-provider-runtime-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null

function Copy-PathIntoBundle {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RelativePath
  )

  $source = Join-Path $repoRoot $RelativePath
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Required path missing: $RelativePath"
  }

  $destination = Join-Path $stagingRoot $RelativePath
  $destinationParent = Split-Path -Parent $destination
  if ($destinationParent) {
    New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
  }

  if ((Get-Item -LiteralPath $source).PSIsContainer) {
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
  } else {
    Copy-Item -LiteralPath $source -Destination $destination -Force
  }
}

try {
  $paths = @(
    "package.json",
    "package-lock.json",
    "dist",
    "scripts/bench/bootstrap-firecracker-linux.sh",
    "scripts/bench/build-firecracker-rootfs-variants.sh",
    "scripts/bench/wsl-local-rootfs-smoke.sh",
    "scripts/bench/start-baselayer-baremetal.sh",
    "scripts/bench/aws-host.ps1",
    "scripts/bench/run-baremetal-provider-matrix.sh",
    "scripts/bench/adhoc/run-kernel-goto-matrix-remote.sh",
    "scripts/bench/adhoc/apply-host-tuning-profile.sh",
    "scripts/bench/adhoc/prepare-basic-profiles-host.sh",
    "scripts/bench/adhoc/stage-custom-chromium-runtime.sh",
    "scripts/chromium",
    "scripts/firecracker/build-headless-shell-rootfs.sh"
  )

  foreach ($path in $paths) {
    Copy-PathIntoBundle -RelativePath $path
  }

  if ($CustomChromiumRuntimePath -ne "") {
    $custSrc = if ([System.IO.Path]::IsPathRooted($CustomChromiumRuntimePath)) {
      $CustomChromiumRuntimePath
    } else {
      Join-Path $repoRoot $CustomChromiumRuntimePath
    }
    if (-not (Test-Path -LiteralPath $custSrc)) {
      throw "CustomChromiumRuntimePath not found: $custSrc"
    }
    $custDest = Join-Path $stagingRoot "artifacts\custom-chromium-runtime"
    New-Item -ItemType Directory -Force -Path $custDest | Out-Null
    Copy-Item -LiteralPath $custSrc -Destination $custDest -Recurse -Force
    Write-Host "[package-bundle] included custom Chromium runtime from $custSrc"
  }

  $artifactsDir = Join-Path $repoRoot "artifacts\firecracker"
  if ($IncludeArtifacts.IsPresent -and (Test-Path -LiteralPath $artifactsDir)) {
    Copy-PathIntoBundle -RelativePath "artifacts/firecracker"
  }

  $nodeModulesDir = Join-Path $repoRoot "node_modules"
  if ($IncludeNodeModules.IsPresent -and (Test-Path -LiteralPath $nodeModulesDir)) {
    Copy-PathIntoBundle -RelativePath "node_modules"
  }

  if (Test-Path -LiteralPath $bundleFullPath) {
    Remove-Item -LiteralPath $bundleFullPath -Force
  }

  Push-Location $stagingRoot
  try {
    & tar.exe -czf $bundleFullPath .
    if ($LASTEXITCODE -ne 0) {
      throw "tar.exe failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }

  Get-Item -LiteralPath $bundleFullPath | Select-Object FullName, Length, LastWriteTime | Format-List
} finally {
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
}
