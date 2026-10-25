$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Environment.ps1')
$exe = Join-Path $PSScriptRoot 'runtime\ollama.exe'
$pidFile = Join-Path $PSScriptRoot 'logs\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'No managed Ollama server PID found.'; exit 0 }
$serverId = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$server = Get-Process -Id $serverId -ErrorAction SilentlyContinue
if (-not $server) { Write-Output 'Ollama is already stopped.'; exit 0 }
if ($server.Path -ne $exe) { throw 'PID no longer belongs to this Ollama installation. Nothing was stopped.' }
try {
    $loaded = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/ps' -TimeoutSec 5
    foreach ($model in $loaded.models) { & $exe stop $model.name }
} catch { Write-Warning 'Could not unload models through the API.' }
Stop-Process -Id $serverId
Write-Output 'This Ollama server has been stopped.'
