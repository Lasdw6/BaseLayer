# Thin wrapper: run bounded SSH from Windows (same behavior as ssh-run.mjs).
# Usage: same as: node scripts/ssh-run.mjs ...
# Env: SSH_RUN_TIMEOUT_SEC, SSH_RUN_JSON_RESULT, SSH_RUN_LOG
# Example:
#   .\scripts\ssh-run.ps1 --label=tail --json-result=.tmp\ssh-result.json -- ssh.exe -n -T user@host "bash -lc 'tail -n 50 /tmp/log'"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runner = Join-Path $ScriptDir "ssh-run.mjs"
if (-not (Test-Path $Runner)) {
  Write-Error "ssh-run.mjs not found at $Runner"
  exit 127
}
node $Runner @args
exit $LASTEXITCODE
