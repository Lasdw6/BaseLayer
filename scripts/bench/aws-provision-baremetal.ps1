param(
  [string]$Profile = "baselayer",
  [string]$Region = "us-east-2",
  [string]$InstanceType = "m5zn.metal",
  [string]$NamePrefix = "baselayer-aws-baremetal",
  [int]$VolumeSizeGb = 100,
  [int]$RunningTimeoutSec = 120,
  [string]$MetadataPath = "",
  [string]$PreferredAvailabilityZone = "",
  [switch]$NoWaitForRunning,
  [switch]$OpenSshToWorld,
  [switch]$OpenProviderPorts,
  [string]$ProviderAccessCidr = ""
)

$ErrorActionPreference = "Stop"

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

function Invoke-AwsJson {
  param(
    [string[]]$CliArgs
  )
  $aws = Get-AwsCliPath
  $raw = & $aws @CliArgs
  if ($LASTEXITCODE -ne 0) {
    throw "aws failed: $($CliArgs -join ' ')"
  }
  return $raw | ConvertFrom-Json
}

function Invoke-AwsText {
  param(
    [string[]]$CliArgs
  )
  $aws = Get-AwsCliPath
  $raw = & $aws @CliArgs
  if ($LASTEXITCODE -ne 0) {
    throw "aws failed: $($CliArgs -join ' ')"
  }
  return ($raw | Out-String).Trim()
}

function Set-PrivateKeyAcl {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }
  & icacls.exe $Path /inheritance:r | Out-Null
  $user = "$env:USERDOMAIN\$env:USERNAME"
  & icacls.exe $Path /grant:r "${user}:(R)" | Out-Null
}

function Remove-AwsProvisionArtifacts {
  param(
    [string]$KeyName,
    [string]$SecurityGroupId,
    [string]$KeyPath
  )
  $aws = Get-AwsCliPath
  if ($SecurityGroupId) {
    & $aws ec2 delete-security-group --profile $Profile --region $Region --group-id $SecurityGroupId | Out-Null
  }
  if ($KeyName) {
    & $aws ec2 delete-key-pair --profile $Profile --region $Region --key-name $KeyName | Out-Null
  }
  if ($KeyPath -and (Test-Path -LiteralPath $KeyPath)) {
    Remove-Item -LiteralPath $KeyPath -Force -ErrorAction SilentlyContinue
  }
}

function Wait-ForInstanceState {
  param(
    [string]$InstanceId,
    [string]$TargetState,
    [int]$TimeoutSec = 900
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $state = Invoke-AwsText @(
      "ec2","describe-instances",
      "--profile",$Profile,
      "--region",$Region,
      "--instance-ids",$InstanceId,
      "--query","Reservations[0].Instances[0].State.Name",
      "--output","text"
    )
    if ($state -eq $TargetState) {
      return $true
    }
    Start-Sleep -Seconds 5
  }
  return $false
}

function Get-InstanceDetails {
  param(
    [string]$InstanceId
  )

  $details = Invoke-AwsJson @(
    "ec2","describe-instances",
    "--profile",$Profile,
    "--region",$Region,
    "--instance-ids",$InstanceId
  )
  return $details.Reservations[0].Instances[0]
}

function Get-PreferredAvailabilityZone {
  param(
    [string[]]$OfferedAzs,
    [string]$PreferredAz = ""
  )

  $clean = @($OfferedAzs | Where-Object { $_ -and $_ -ne "None" } | Select-Object -Unique)
  if (-not $clean -or $clean.Count -eq 0) {
    throw "No availability zones found for the requested instance type."
  }

  if ($PreferredAz) {
    if ($clean -contains $PreferredAz) {
      return $PreferredAz
    }
    throw "Preferred availability zone $PreferredAz is not offered for this instance type in this region."
  }

  $prioritySuffixes = @("b", "c", "a", "d", "e", "f")
  foreach ($suffix in $prioritySuffixes) {
    $match = $clean | Where-Object { $_.EndsWith($suffix) } | Select-Object -First 1
    if ($match) {
      return $match
    }
  }

  return $clean[0]
}

function Get-InstanceArchitecture {
  param(
    [string]$InstanceTypeName
  )

  $archText = Invoke-AwsText @(
    "ec2","describe-instance-types",
    "--profile",$Profile,
    "--region",$Region,
    "--instance-types",$InstanceTypeName,
    "--query","InstanceTypes[0].ProcessorInfo.SupportedArchitectures[0]",
    "--output","text"
  )

  if (-not $archText -or $archText -eq "None") {
    throw "Could not resolve architecture for $InstanceTypeName in $Region."
  }

  return $archText
}

function Get-UbuntuAmiArchitectureName {
  param(
    [string]$AwsArchitecture
  )

  switch ($AwsArchitecture) {
    "x86_64" { return "amd64" }
    "arm64" { return "arm64" }
    default { return $AwsArchitecture }
  }
}

$timestamp = Get-Date -Format "yyyyMMddHHmmss"
$name = "$NamePrefix-$timestamp"

if (-not $MetadataPath) {
  New-Item -ItemType Directory -Force -Path ".tmp" | Out-Null
  $MetadataPath = Join-Path ".tmp" "$name.json"
}

$metadataDir = Split-Path -Parent $MetadataPath
if ($metadataDir) {
  New-Item -ItemType Directory -Force -Path $metadataDir | Out-Null
}

$createdKeyName = ""
$createdSecurityGroupId = ""

try {
$azText = Invoke-AwsText @(
  "ec2","describe-instance-type-offerings",
  "--profile",$Profile,
  "--region",$Region,
  "--location-type","availability-zone",
  "--filters","Name=instance-type,Values=$InstanceType",
  "--query","InstanceTypeOfferings[].Location",
  "--output","text"
)
if (-not $azText -or $azText -eq "None") {
  throw "No availability zone found for $InstanceType in $Region."
}
$offeredAzs = @($azText -split "\s+" | Where-Object { $_ })
$availabilityZone = Get-PreferredAvailabilityZone -OfferedAzs $offeredAzs -PreferredAz $PreferredAvailabilityZone
$instanceArchitecture = Get-InstanceArchitecture -InstanceTypeName $InstanceType
$ubuntuAmiArchitecture = Get-UbuntuAmiArchitectureName -AwsArchitecture $instanceArchitecture

$vpcId = Invoke-AwsText @(
  "ec2","describe-vpcs",
  "--profile",$Profile,
  "--region",$Region,
  "--filters","Name=is-default,Values=true",
  "--query","Vpcs[0].VpcId",
  "--output","text"
)
if (-not $vpcId -or $vpcId -eq "None") {
  throw "Default VPC not found in $Region."
}

$subnetId = Invoke-AwsText @(
  "ec2","describe-subnets",
  "--profile",$Profile,
  "--region",$Region,
  "--filters","Name=vpc-id,Values=$vpcId","Name=availability-zone,Values=$availabilityZone","Name=default-for-az,Values=true",
  "--query","Subnets[0].SubnetId",
  "--output","text"
)
if (-not $subnetId -or $subnetId -eq "None") {
  throw "Default subnet not found in $availabilityZone."
}

$amiId = Invoke-AwsText @(
  "ec2","describe-images",
  "--profile",$Profile,
  "--region",$Region,
  "--owners","099720109477",
  "--filters",
  "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-$ubuntuAmiArchitecture-server-*",
  "Name=architecture,Values=$instanceArchitecture",
  "Name=state,Values=available",
  "--query","sort_by(Images,&CreationDate)[-1].ImageId",
  "--output","text"
)
if (-not $amiId -or $amiId -eq "None") {
  throw "Ubuntu 22.04 $instanceArchitecture AMI not found in $Region."
}

$keyName = $name
$keyPath = (Resolve-Path ".tmp").Path
$keyPath = Join-Path $keyPath "$keyName.pem"

$keyPair = Invoke-AwsJson @(
  "ec2","create-key-pair",
  "--profile",$Profile,
  "--region",$Region,
  "--key-name",$keyName,
  "--output","json"
)
[System.IO.File]::WriteAllText($keyPath, $keyPair.KeyMaterial, [System.Text.Encoding]::ASCII)
$createdKeyName = $keyName
Set-PrivateKeyAcl -Path $keyPath

$sg = Invoke-AwsJson @(
  "ec2","create-security-group",
  "--profile",$Profile,
  "--region",$Region,
  "--group-name",$name,
  "--description","Temporary SSH access for BaseLayer AWS bare-metal benchmarking",
  "--vpc-id",$vpcId
)
$securityGroupId = $sg.GroupId
$createdSecurityGroupId = $securityGroupId

$cidr = if ($OpenSshToWorld) { "0.0.0.0/0" } else {
  try {
    (Invoke-RestMethod -Uri "https://checkip.amazonaws.com/" -TimeoutSec 10).Trim() + "/32"
  } catch {
    "0.0.0.0/0"
  }
}

$null = Invoke-AwsText @(
  "ec2","authorize-security-group-ingress",
  "--profile",$Profile,
  "--region",$Region,
  "--group-id",$securityGroupId,
  "--protocol","tcp",
  "--port","22",
  "--cidr",$cidr
)

if ($OpenProviderPorts) {
  $providerCidr = if ($ProviderAccessCidr) { $ProviderAccessCidr } else { $cidr }
  foreach ($portRange in @(
    @{ From = 3000; To = 3000 },
    @{ From = 1024; To = 65535 }
  )) {
    $null = Invoke-AwsText @(
      "ec2","authorize-security-group-ingress",
      "--profile",$Profile,
      "--region",$Region,
      "--group-id",$securityGroupId,
      "--ip-permissions",
      "IpProtocol=tcp,FromPort=$($portRange.From),ToPort=$($portRange.To),IpRanges=[{CidrIp=$providerCidr,Description=BaseLayer provider access}]"
    )
  }
}

$blockDeviceMappingsPath = Join-Path $metadataDir "block-device-mappings-$timestamp.json"
$blockDeviceMappingsJson = @"
[
  {
    "DeviceName": "/dev/sda1",
    "Ebs": {
      "VolumeSize": $VolumeSizeGb,
      "VolumeType": "gp3",
      "DeleteOnTermination": true
    }
  }
]
"@
$blockDeviceMappingsJson | Set-Content -LiteralPath $blockDeviceMappingsPath -Encoding ASCII
$blockDeviceMappingsUri = "file://" + ((Resolve-Path $blockDeviceMappingsPath).Path -replace "\\","/")

$run = Invoke-AwsJson @(
  "ec2","run-instances",
  "--profile",$Profile,
  "--region",$Region,
  "--image-id",$amiId,
  "--instance-type",$InstanceType,
  "--key-name",$keyName,
  "--security-group-ids",$securityGroupId,
  "--subnet-id",$subnetId,
  "--associate-public-ip-address",
  "--block-device-mappings",$blockDeviceMappingsUri,
  "--tag-specifications","ResourceType=instance,Tags=[{Key=Name,Value=$name}]"
)

$instance = $run.Instances[0]
$instanceId = $instance.InstanceId

$waitedForRunning = $false
if (-not $NoWaitForRunning.IsPresent -and $RunningTimeoutSec -gt 0) {
  $waitedForRunning = Wait-ForInstanceState -InstanceId $instanceId -TargetState "running" -TimeoutSec $RunningTimeoutSec
}

$live = Get-InstanceDetails -InstanceId $instanceId

$metadata = [ordered]@{
  profile = $Profile
  region = $Region
  availabilityZone = $availabilityZone
  instanceType = $InstanceType
  architecture = $instanceArchitecture
  name = $name
  instanceId = $instanceId
  amiId = $amiId
  vpcId = $vpcId
  subnetId = $subnetId
  securityGroupId = $securityGroupId
  sshCidr = $cidr
  providerPortsOpen = [bool]$OpenProviderPorts
  providerAccessCidr = if ($OpenProviderPorts) { if ($ProviderAccessCidr) { $ProviderAccessCidr } else { $cidr } } else { $null }
  keyName = $keyName
  keyPath = $keyPath
  currentState = $live.State.Name
  waitedForRunning = [bool]$waitedForRunning
  runningWaitTimeoutSec = $RunningTimeoutSec
  publicIp = $live.PublicIpAddress
  publicDnsName = $live.PublicDnsName
  privateIp = $live.PrivateIpAddress
  loginUser = "ubuntu"
  createdAt = (Get-Date).ToString("o")
}

$metadata | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $MetadataPath -Encoding UTF8
$metadata | ConvertTo-Json -Depth 5
}
catch {
  Remove-AwsProvisionArtifacts -KeyName $createdKeyName -SecurityGroupId $createdSecurityGroupId -KeyPath $keyPath
  throw
}
