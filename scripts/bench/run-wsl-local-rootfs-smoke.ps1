param(
  [string]$Distro = "Ubuntu-24.04",
  [string]$WslWorkDir = "~/baselayer-local-smoke",
  [string]$BundlePath = ".tmp/provider-runtime-local-smoke.tar.gz",
  [string]$WindowsTmpDir = ".tmp",
  [switch]$IncludeNodeModules
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$bundleFullPath = if ([System.IO.Path]::IsPathRooted($BundlePath)) {
  $BundlePath
} else {
  Join-Path $repoRoot $BundlePath
}
$windowsTmpFullPath = if ([System.IO.Path]::IsPathRooted($WindowsTmpDir)) {
  $WindowsTmpDir
} else {
  Join-Path $repoRoot $WindowsTmpDir
}
New-Item -ItemType Directory -Force -Path $windowsTmpFullPath | Out-Null

$packageScript = Join-Path $repoRoot "scripts\bench\adhoc\package-provider-runtime-bundle.ps1"

Write-Host "[smoke] packaging runtime bundle"
# Invoke directly so argument quoting is handled by PowerShell, not by a
# hand-built command string fed through Invoke-Expression.
if ($IncludeNodeModules.IsPresent) {
  & $packageScript -BundlePath $bundleFullPath -IncludeNodeModules
} else {
  & $packageScript -BundlePath $bundleFullPath
}
if ($LASTEXITCODE -ne 0) {
  throw "[smoke] packaging runtime bundle failed with exit code $LASTEXITCODE"
}

# Use wslpath rather than a hand-rolled drive-letter conversion so UNC paths,
# subst-ed drives, and non-C: drives all work.
function ConvertTo-WslPath {
  param([Parameter(Mandatory = $true)][string]$WindowsPath)
  $normalized = $WindowsPath.Replace('\', '/')
  $escaped = $normalized.Replace("'", "'\''")
  $converted = (wsl.exe -d $Distro -- bash -lc "wslpath -a -- '$escaped'") 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($converted)) {
    throw "[smoke] wslpath conversion failed for $WindowsPath"
  }
  return $converted.Trim()
}

$linuxBundlePath = ConvertTo-WslPath -WindowsPath $bundleFullPath
$linuxWorkDir = $WslWorkDir
$wslScriptWindowsPath = Join-Path $windowsTmpFullPath "run-wsl-local-rootfs-smoke.sh"
$wslScriptLinuxPath = ConvertTo-WslPath -WindowsPath $wslScriptWindowsPath

# Guard against accidental destructive values. The inner bash script also
# refuses to run if the workdir looks dangerous, but fail in PowerShell first
# so we never hand a bad path to `rm -rf`.
$normalizedWorkDir = $linuxWorkDir.Trim()
if ([string]::IsNullOrWhiteSpace($normalizedWorkDir) -or
    $normalizedWorkDir -eq "/" -or
    $normalizedWorkDir -eq "~" -or
    $normalizedWorkDir -eq "~/" -or
    $normalizedWorkDir -match "^\s*(/|~/?)\s*$") {
  throw "[smoke] refusing to use WslWorkDir='$linuxWorkDir'; pick a dedicated subdirectory like ~/baselayer-local-smoke"
}

$bootstrap = @"
#!/usr/bin/env bash
set -euo pipefail
WORKDIR='$normalizedWorkDir'
if [ -z "`$WORKDIR" ] || [ "`$WORKDIR" = "/" ] || [ "`$WORKDIR" = "~" ] || [ "`$WORKDIR" = "`$HOME" ]; then
  echo "[smoke] refusing destructive workdir: `$WORKDIR" >&2
  exit 1
fi
# Expand a leading ~ manually because single-quoted strings do not trigger
# tilde expansion in bash.
case "`$WORKDIR" in
  "~"|"~/"*) WORKDIR="`$HOME`${WORKDIR#~}" ;;
esac
BUNDLE='$linuxBundlePath'
rm -rf -- "`$WORKDIR"
mkdir -p -- "`$WORKDIR"
tar -xzf "`$BUNDLE" -C "`$WORKDIR"
chmod +x "`$WORKDIR/scripts/bench/wsl-local-rootfs-smoke.sh"
bash "`$WORKDIR/scripts/bench/wsl-local-rootfs-smoke.sh" "`$WORKDIR"
"@

# Write with LF-only line endings and UTF-8 no-BOM so bash under WSL does not
# choke on `\r` (previous `Set-Content` default emitted CRLF).
$bootstrapLf = $bootstrap -replace "`r`n", "`n"
[System.IO.File]::WriteAllText(
  $wslScriptWindowsPath,
  $bootstrapLf,
  (New-Object System.Text.UTF8Encoding($false))
)
Write-Host "[smoke] wrote WSL runner: $wslScriptWindowsPath"

Write-Host "[smoke] running WSL smoke build in $Distro"
wsl.exe -d $Distro -- bash $wslScriptLinuxPath
if ($LASTEXITCODE -ne 0) {
  throw "[smoke] WSL smoke build failed with exit code $LASTEXITCODE"
}
