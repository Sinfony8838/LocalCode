$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Environment.ps1')
$exe = Join-Path $PSScriptRoot 'runtime\ollama.exe'
$pidFile = Join-Path $PSScriptRoot 'logs\server.pid'
if (-not (Test-Path -LiteralPath $exe)) { throw 'Ollama runtime is missing.' }
$server = $null
if (Test-Path -LiteralPath $pidFile) {
    $serverId = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
    $server = Get-Process -Id $serverId -ErrorAction SilentlyContinue
    if ($server -and $server.Path -ne $exe) { $server = $null }
}
if (-not $server) {
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    if (@($listeners | Where-Object { $_.Port -eq 11434 }).Count) { throw 'Port 11434 belongs to another process. No process was stopped.' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $server = Start-Process -FilePath $exe -ArgumentList 'serve' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot "logs\server-$stamp.stdout.log") -RedirectStandardError (Join-Path $PSScriptRoot "logs\server-$stamp.stderr.log") -PassThru
    $server.Id | Set-Content -LiteralPath $pidFile -Encoding ascii
}
for ($attempt = 0; $attempt -lt 45; $attempt++) {
    try {
        $version = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2
        Write-Output "Ollama $($version.version) is ready at http://127.0.0.1:11434"
        exit 0
    } catch {
        if (-not (Get-Process -Id $server.Id -ErrorAction SilentlyContinue)) { throw 'Ollama exited. Check the logs folder.' }
        Start-Sleep -Seconds 1
    }
}
throw 'Ollama did not become ready within 45 seconds. Check the logs folder.'
