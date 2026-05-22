param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("status", "ssh", "scp-to", "scp-from", "terminate")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$MetadataPath,

  [string]$Command = "",
  [string]$LocalPath = "",
  [string]$RemotePath = "",
  [int]$TimeoutSec = 30
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

# Prevent AWS CLI v2 from opening a pager and blocking non-interactive automation.
if (-not $env:AWS_PAGER) {
  $env:AWS_PAGER = ""
}

function Assert-Metadata {
  param($Meta)

  if (-not $Meta.instanceId -or $Meta.instanceId -notmatch '^i-[0-9a-f]{8,17}$') {
    throw "Metadata instanceId is missing or not a valid EC2 id: $($Meta.instanceId)"
  }
  if (-not $Meta.region -or $Meta.region -notmatch '^[a-z]{2}-[a-z0-9-]+-\d$') {
    throw "Metadata region is missing or invalid: $($Meta.region)"
  }
  if (-not $Meta.publicIp -or $Meta.publicIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
    throw "Metadata publicIp is missing or not an IPv4 address: $($Meta.publicIp)"
  }
  if ($Meta.keyPath -and -not (Test-Path -LiteralPath $Meta.keyPath)) {
    throw "Metadata keyPath does not exist: $($Meta.keyPath)"
  }
}

function Get-OpenSshExe {
  param([string]$Name)
  $path = Join-Path $env:WINDIR "System32\OpenSSH\$Name"
  if (Test-Path -LiteralPath $path) {
    return $path
  }
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  throw "$Name not found."
}

function Get-AwsCliPath {
  $candidates = @(
    "C:\Program Files\Amazon\AWSCLIV2\aws.exe",
    "aws.exe"
  )
  foreach ($candidate in $candidates) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) {
      return $cmd.Source
    }
  }
  throw "AWS CLI not found."
}

function Get-Metadata {
  if (-not (Test-Path -LiteralPath $MetadataPath)) {
    throw "Metadata file not found: $MetadataPath"
  }
  return Get-Content -LiteralPath $MetadataPath -Raw | ConvertFrom-Json
}

function Get-SshArgs {
  param($Meta)
  return @(
    "-n",
    "-T",
    "-i", $Meta.keyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=10",
    "$($Meta.loginUser)@$($Meta.publicIp)"
  )
}

function Invoke-BoundedProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList,

    [int]$TimeoutSec = 30
  )

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $FilePath
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  $quotedArgs = foreach ($arg in $ArgumentList) {
    if ($null -eq $arg -or $arg -eq "") {
      '""'
    } elseif ($arg -match '[\s"]') {
      '"' + ($arg -replace '(\\*)"', '$1$1\"') + '"'
    } else {
      $arg
    }
  }
  $startInfo.Arguments = ($quotedArgs -join " ")

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo

  try {
    [void]$process.Start()

    if (-not $process.WaitForExit($TimeoutSec * 1000)) {
      try {
        $process.Kill($true)
      } catch {
        # ignore
      }

      try {
        $process.WaitForExit()
      } catch {
        # ignore
      }

      $stdout = $process.StandardOutput.ReadToEnd()
      $stderr = $process.StandardError.ReadToEnd()
      if ($stdout) {
        [Console]::Out.Write($stdout)
      }
      if ($stderr) {
        [Console]::Error.Write($stderr)
      }
      exit 124
    }

    $process.WaitForExit()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()

    if ($stdout) {
      [Console]::Out.Write($stdout)
    }
    if ($stderr) {
      [Console]::Error.Write($stderr)
    }

    exit $process.ExitCode
  } finally {
    $process.Dispose()
  }
}

$meta = Get-Metadata
Assert-Metadata -Meta $meta

switch ($Action) {
  "status" {
    $aws = Get-AwsCliPath
    & $aws ec2 describe-instances `
      --profile $meta.profile `
      --region $meta.region `
      --instance-ids $meta.instanceId `
      --query "Reservations[0].Instances[0].{InstanceId:InstanceId,State:State.Name,PublicIp:PublicIpAddress,PublicDns:PublicDnsName,Type:InstanceType}" `
      --output json
    exit $LASTEXITCODE
  }

  "ssh" {
    if (-not $Command) {
      throw "Command is required for action ssh."
    }
    $ssh = Get-OpenSshExe -Name "ssh.exe"
    $args = (Get-SshArgs -Meta $meta) + @($Command)
    Invoke-BoundedProcess -FilePath $ssh -ArgumentList $args -TimeoutSec $TimeoutSec
  }

  "scp-to" {
    if (-not $LocalPath -or -not $RemotePath) {
      throw "LocalPath and RemotePath are required for action scp-to."
    }
    $scp = Get-OpenSshExe -Name "scp.exe"
    $dest = "$($meta.loginUser)@$($meta.publicIp):$RemotePath"
    $args = @(
      "-O",
      "-q",
      "-i", $meta.keyPath,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=10",
      $LocalPath,
      $dest
    )
    Invoke-BoundedProcess -FilePath $scp -ArgumentList $args -TimeoutSec $TimeoutSec
  }

  "scp-from" {
    if (-not $LocalPath -or -not $RemotePath) {
      throw "LocalPath and RemotePath are required for action scp-from."
    }
    $scp = Get-OpenSshExe -Name "scp.exe"
    $source = "$($meta.loginUser)@$($meta.publicIp):$RemotePath"
    $args = @(
      "-O",
      "-q",
      "-i", $meta.keyPath,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=10",
      $source,
      $LocalPath
    )
    Invoke-BoundedProcess -FilePath $scp -ArgumentList $args -TimeoutSec $TimeoutSec
  }

  "terminate" {
    $aws = Get-AwsCliPath
    & $aws ec2 terminate-instances `
      --profile $meta.profile `
      --region $meta.region `
      --instance-ids $meta.instanceId
    exit $LASTEXITCODE
  }
}
