$ErrorActionPreference = 'Stop'
$startup = [System.Diagnostics.Stopwatch]::StartNew()
$startupTimeoutSeconds = 45
. (Join-Path $PSScriptRoot 'Environment.ps1')
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\Setup.Helpers.ps1')
$exe = Join-Path $PSScriptRoot 'runtime\ollama.exe'
$pidFile = Join-Path $PSScriptRoot 'logs\server.pid'
if (-not (Test-Path -LiteralPath $exe)) { throw '缺少本套 Ollama 运行时。便携版请运行 Install-LocalModel.cmd；源码版请运行 Setup.cmd。 / Ollama runtime is missing. Portable app: Install-LocalModel.cmd; source: Setup.cmd.' }
$server = $null
if (Test-Path -LiteralPath $pidFile) {
    $serverId = 0
    if ([int]::TryParse([System.IO.File]::ReadAllText($pidFile), [ref]$serverId) -and $serverId -gt 0) {
        $server = Get-Process -Id $serverId -ErrorAction SilentlyContinue
        if ($server -and $server.Path -ne $exe) { $server = $null }
    }
}
if (-not $server) {
    if (@(Get-LocalCodePortListeners).Count) { throw '11434 端口属于其他进程。没有停止或复用任何服务。 / Port 11434 belongs to another process. No service was stopped or reused.' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $server = Start-Process -FilePath $exe -ArgumentList 'serve' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot "logs\server-$stamp.stdout.log") -RedirectStandardError (Join-Path $PSScriptRoot "logs\server-$stamp.stderr.log") -PassThru
    $server.Id | Set-Content -LiteralPath $pidFile -Encoding ascii
}
while ($startup.Elapsed.TotalSeconds -lt $startupTimeoutSeconds) {
    # Never poll an HTTP listener merely because a matching executable exists.
    # Ownership failures are outside the HTTP retry catch and fail immediately.
    if (Assert-LocalCodeManagedServer $PSScriptRoot -ServerId $server.Id -AllowStarting) {
        $remainingSeconds = [math]::Floor($startupTimeoutSeconds - $startup.Elapsed.TotalSeconds)
        if ($remainingSeconds -lt 1) { break }
        $responded = $false
        try {
            $version = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec ([int][math]::Min(2, $remainingSeconds))
            if ($version.version) { $responded = $true }
        } catch { # HTTP readiness is retryable; ownership failures are not.
        }
        if ($responded) {
            [void](Assert-LocalCodeManagedServer $PSScriptRoot -ServerId $server.Id)
            if ($startup.Elapsed.TotalSeconds -ge $startupTimeoutSeconds) { break }
            Write-Output "Ollama $($version.version) 已就绪 / ready at http://127.0.0.1:11434"
            exit 0
        }
    }
    $remainingMilliseconds = [math]::Floor(($startupTimeoutSeconds * 1000) - $startup.Elapsed.TotalMilliseconds)
    if ($remainingMilliseconds -le 0) { break }
    Start-Sleep -Milliseconds ([int][math]::Min(1000, $remainingMilliseconds))
}
throw 'Ollama 未在 45 秒启动等待期间就绪，请检查 Ollama\logs，或稍后重新检查服务状态。 / Ollama did not become ready within the 45-second startup window. Check Ollama\logs or check service status again later.'
