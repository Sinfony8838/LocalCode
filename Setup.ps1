param(
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,180}$')][string]$Model = 'qwen3.5:9b-q4_K_M',
    [ValidateRange(4096,131072)][int]$Context = 8192,
    [ValidateRange(128,32768)][int]$MaxTokens = 1024,
    [switch]$BuildOnly,
    [switch]$Plan
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = $PSScriptRoot
if ($MaxTokens + 1536 -ge $Context) { throw 'Context must exceed MaxTokens + 1536.' }
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -notin @('AMD64', 'x86')) { throw 'This bootstrap supports Windows x64 only.' }
$source = Join-Path $root 'LocalCode\source'
$ollama = Join-Path $root 'Ollama'
$nodeVersion = '24.14.0'
$nodeHash = '313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66'
$runtimeHash = 'd52aea2d323bdd324bf66a4b1226844aa5fb665cc5974fbcceceda1ce3d934eb'
if ($Plan) {
    [pscustomobject]@{ mode = $(if ($BuildOnly) { 'build-only' } else { 'local-model-and-build' }); root = $root; node = $nodeVersion; ollama = '0.40.10'; model = $Model; alias = 'localcode-agent'; context = $Context; maxTokens = $MaxTokens; cloudRequests = 0; runtimeSha256 = $runtimeHash; nodeSha256 = $nodeHash } | ConvertTo-Json
    exit 0
}
if (-not $BuildOnly) {
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    if (@($listeners | Where-Object { $_.Port -eq 11434 }).Count) {
        $pidFile = Join-Path $ollama 'logs\server.pid'
        $owned = $null
        if (Test-Path -LiteralPath $pidFile) {
            $owned = Get-Process -Id ([int](Get-Content -LiteralPath $pidFile -Raw).Trim()) -ErrorAction SilentlyContinue
        }
        if (-not $owned -or $owned.Path -ne (Join-Path $ollama 'runtime\ollama.exe')) {
            throw 'Port 11434 is already used by another service. No process was stopped. Close it before setup or use -BuildOnly.'
        }
    }
}
function CheckedDownload([string]$Url, [string]$Destination, [string]$Hash) {
    if (Test-Path -LiteralPath $Destination) {
        if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) { throw "Cached checksum mismatch: $Destination" }
        return
    }
    $part = "$Destination.$([guid]::NewGuid().ToString('N')).part"
    & curl.exe --fail --location --retry 3 --connect-timeout 30 --output $part $Url
    if ($LASTEXITCODE -ne 0) { throw "Download failed; partial file retained at $part" }
    if ((Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) { throw 'Downloaded archive checksum mismatch. Nothing was extracted.' }
    Move-Item -LiteralPath $part -Destination $Destination -ErrorAction Stop
}
function ExtractNew([string]$Archive, [string]$Destination) {
    if (Test-Path -LiteralPath $Destination) { throw "Refusing to overwrite: $Destination" }
    $pending = "$Destination.incomplete-$([guid]::NewGuid().ToString('N'))"
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Archive, $pending)
    Move-Item -LiteralPath $pending -Destination $Destination -ErrorAction Stop
}
foreach ($dir in @('tools','downloads','LocalCode\cache','Ollama\downloads','Ollama\models','Ollama\logs','Ollama\profile','Ollama\temp')) {
    New-Item -ItemType Directory -Path (Join-Path $root $dir) -Force | Out-Null
}
$nodeDir = Join-Path $root "tools\node\node-v$nodeVersion-win-x64"
if (-not (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe'))) {
    $archive = Join-Path $root "downloads\node-v$nodeVersion-win-x64.zip"
    CheckedDownload "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" $archive $nodeHash
    ExtractNew $archive (Join-Path $root 'tools\node')
}
$env:PATH = "$nodeDir;$env:PATH"
$env:npm_config_cache = Join-Path $root 'LocalCode\cache\npm'
$env:electron_config_cache = Join-Path $root 'LocalCode\cache\electron'
$env:TEMP = Join-Path $root 'LocalCode\cache'
$env:TMP = $env:TEMP
$env:ELECTRON_RUN_AS_NODE = $null
$npm = Join-Path $nodeDir 'npm.cmd'
Push-Location $source
try {
    & $npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    & $npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Type check failed.' }
    & $npm test -- --no-file-parallelism
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    & $npm run package
    if ($LASTEXITCODE -ne 0) { throw 'Packaging failed.' }
} finally { Pop-Location }
if (-not $BuildOnly) {
    $runtime = Join-Path $ollama 'runtime'
    if (-not (Test-Path -LiteralPath (Join-Path $runtime 'ollama.exe'))) {
        $archive = Join-Path $ollama 'downloads\ollama-windows-amd64-v0.40.10.zip'
        CheckedDownload 'https://github.com/ollama/ollama/releases/download/v0.40.10/ollama-windows-amd64.zip' $archive $runtimeHash
        ExtractNew $archive $runtime
    }
    $profilePath = Join-Path $root 'LocalCode\model-profile.json'
    $existing = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
    if ($existing.contextWindow -ne $Context -or $existing.maxTokens -ne $MaxTokens) {
        if (Test-Path -LiteralPath (Join-Path $root 'LocalCode\data\index.json')) { throw 'Existing app data uses a saved profile. Use a fresh clone for different context/output budgets.' }
    }
    # Run in a child shell: Start.ps1 isolates Ollama environment and exits on success.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ollama 'Start.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Managed Ollama could not start. An unrelated port 11434 listener is never stopped or reused.' }
    $exe = Join-Path $runtime 'ollama.exe'
    $env:OLLAMA_HOST = '127.0.0.1:11434'
    & $exe pull $Model
    if ($LASTEXITCODE -ne 0) { throw 'Model download failed; rerun Setup to resume.' }
    $file = Join-Path $ollama 'Agent.Modelfile'
    "FROM $Model`nPARAMETER num_ctx $Context" | Set-Content -LiteralPath $file -Encoding ascii
    & $exe create localcode-agent -f $file
    if ($LASTEXITCODE -ne 0) { throw 'Model alias creation failed.' }
    @{contextWindow=$Context;maxTokens=$MaxTokens} | ConvertTo-Json | Set-Content -LiteralPath $profilePath -Encoding ascii
    $record = @{ baseModel=$Model; alias='localcode-agent'; context=$Context; maxTokens=$MaxTokens; ollamaVersion='0.40.10'; createdAt=(Get-Date).ToString('o'); inferenceValidation='UNRUN' }
    $record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ollama 'logs\deployment.json') -Encoding utf8
}
Write-Output 'Build complete. Run Start.cmd. No paid/cloud model requests were made.'
