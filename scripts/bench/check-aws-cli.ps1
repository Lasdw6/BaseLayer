param(
  [string]$Profile = "baselayer",
  [string]$Region = "us-east-1"
)

$ErrorActionPreference = "Stop"

if ($Profile -eq "default") {
  throw "Refusing to use the default AWS profile. Use a dedicated profile such as 'baselayer'."
}

Write-Host "AWS CLI:"
aws --version

Write-Host ""
Write-Host "Caller identity:"
aws sts get-caller-identity --profile $Profile

Write-Host ""
Write-Host "Region probe:"
aws ec2 describe-regions --profile $Profile --region $Region --output table
