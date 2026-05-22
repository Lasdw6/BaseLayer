# Same engine as ssh-run.mjs — use for bounded scp/rsync (see scripts/ssh-run.mjs --help).
# Example:
#   .\scripts\scp-run.ps1 --timeout-sec=30 --log=.tmp\scp.log --json-result=.tmp\scp.json -- scp.exe -q -i key.pem local ubuntu@host:remote/

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runner = Join-Path $ScriptDir "ssh-run.mjs"
if (-not (Test-Path $Runner)) {
  Write-Error "ssh-run.mjs not found at $Runner"
  exit 127
}
node $Runner @args
exit $LASTEXITCODE
