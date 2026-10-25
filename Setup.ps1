param(
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,180}$')][string]$Model = 'qwen3.5:9b-q4_K_M',
    [ValidateRange(4096,131072)][int]$Context = 8192,
    [ValidateRange(128,32768)][int]$MaxTokens = 1024,
    [switch]$BuildOnly,
    [switch]$ModelOnly,
    [switch]$Plan
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = $PSScriptRoot
if ($BuildOnly -and $ModelOnly) { throw '-BuildOnly and -ModelOnly cannot be combined. / -BuildOnly 与 -ModelOnly 不能同时使用。' }
if ($MaxTokens + 1536 -ge $Context) { throw 'Context must exceed MaxTokens + 1536. / Context 必须大于 MaxTokens + 1536。' }
$source = Join-Path $root 'LocalCode\source'
$ollama = Join-Path $root 'Ollama'
$nodeVersion = '24.14.0'
$nodeHash = '313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66'
$runtimeHash = 'd52aea2d323bdd324bf66a4b1226844aa5fb665cc5974fbcceceda1ce3d934eb'
# Plan is intentionally before all checks that probe folders or use the network.
if ($Plan) {
    [pscustomobject]@{ mode = $(if ($BuildOnly) { 'build-only' } elseif ($ModelOnly) { 'model-only' } else { 'local-model-and-build' }); root = $root; node = $nodeVersion; ollama = '0.40.10'; model = $Model; alias = 'localcode-agent'; context = $Context; maxTokens = $MaxTokens; cloudRequests = 0; runtimeSha256 = $runtimeHash; nodeSha256 = $nodeHash; platform = 'Windows x64'; recommendedFreeGiB = $(if ($BuildOnly) { 5 } else { 25 }); manualNodeOrGitRequired = $false; downloadsModel = -not $BuildOnly; buildsDesktop = -not $ModelOnly } | ConvertTo-Json
    exit 0
}
$stage = '环境检查 / Environment checks'
$step = 0
$totalSteps = $(if ($BuildOnly) { 4 } elseif ($ModelOnly) { 3 } else { 6 })
function Show-SetupStage([string]$Name) {
    $script:stage = $Name
    $script:step++
    Write-Host "`n[$script:step/$script:totalSteps] $Name" -ForegroundColor Cyan
}
try {
    $helpers = Join-Path $root 'scripts\Setup.Helpers.ps1'
    if (-not (Test-Path -LiteralPath $helpers -PathType Leaf)) { throw '安装辅助脚本缺失，请完整解压 ZIP 后重试。 / Setup helpers are missing. Extract the complete ZIP and retry.' }
    . $helpers
    Show-SetupStage $stage
    Write-Host "安装目录 / Install folder: $root"
    Write-Host '无需预装 Node.js、npm 或 Git，无需管理员权限。请关闭 LocalCode 后再安装。 / No manual Node.js, npm, Git or administrator rights needed. Close LocalCode before setup.'
    if (-not $BuildOnly) {
        Write-Host "本次会下载本地运行时和模型 $Model（数 GB）。只需桌面或自选 API？源码版可运行 Setup.cmd -BuildOnly；便携版可直接运行 Start.cmd。 / This installs a local runtime and model (several GB). For desktop-only/API use, source users can run Setup.cmd -BuildOnly; portable users can open Start.cmd directly."
    }
    if ($ModelOnly) { Write-Host '便携版模型安装：不会下载 Node.js、安装 npm 依赖或重新构建桌面。 / Portable model setup: no Node.js download, npm install, or desktop build.' }
    Assert-LocalCodeSupportedHost
    Assert-LocalCodeSourceLayout $root -ModelOnly:$ModelOnly
    if ($ModelOnly) { Assert-LocalCodePackagedApp $root }
    Assert-LocalCodeInstallFolder $root -BuildOnly:$BuildOnly
    if (-not $BuildOnly) {
        # Validate profile and port ownership before expensive downloads/builds.
        $profilePath = Join-Path $root 'LocalCode\model-profile.json'
        $existing = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
        if (($existing.contextWindow -ne $Context -or $existing.maxTokens -ne $MaxTokens) -and (Test-Path -LiteralPath (Join-Path $root 'LocalCode\data\index.json'))) {
            throw '已有会话使用已保存的预算。请在新解压目录设置不同的 Context/MaxTokens，原数据不会修改。 / Existing app data uses a saved profile. Use a fresh extracted folder for different context/output budgets; existing data is preserved.'
        }
        $listeners = @(Get-LocalCodePortListeners)
        if ($listeners.Count) {
            $pidFile = Join-Path $ollama 'logs\server.pid'
            $owned = $null
            if (Test-Path -LiteralPath $pidFile) {
                $serverId = 0
                if ([int]::TryParse(([string](Get-Content -LiteralPath $pidFile -Raw)).Trim(), [ref]$serverId) -and $serverId -gt 0) {
                    $owned = Get-Process -Id $serverId -ErrorAction SilentlyContinue
                }
            }
            if (-not $owned -or $owned.Path -ne (Join-Path $ollama 'runtime\ollama.exe') -or @($listeners | Where-Object { $_.OwningProcess -ne $owned.Id }).Count) {
                throw '端口 11434 已被其他服务使用；没有停止或复用它。请自行退出已有服务，或在应用设置中明确连接它。源码版可运行 Setup.cmd -BuildOnly；便携版直接打开 Start.cmd。 / Port 11434 is in use by another service. No process was stopped or reused. Quit that service yourself, or explicitly connect to it in Settings. Source: Setup.cmd -BuildOnly; portable app: Start.cmd.'
            }
        }
    }
    $directories = @()
    if (-not $BuildOnly) { $directories += @('Ollama\downloads','Ollama\models','Ollama\logs','Ollama\profile','Ollama\temp') }
    if (-not $ModelOnly) { $directories += @('tools','downloads','LocalCode\cache') }
    foreach ($dir in $directories) {
        New-Item -ItemType Directory -Path (Join-Path $root $dir) -Force | Out-Null
    }
    if (-not $ModelOnly) {
        Show-SetupStage '准备便携 Node.js / Prepare portable Node.js'
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
            Show-SetupStage '安装锁定依赖（首次可能较慢） / Install locked dependencies (first run may take time)'
            & $npm ci
            if ($LASTEXITCODE -ne 0) { throw '依赖下载/安装失败。请检查上方 npm 错误、磁盘空间，以及 registry.npmjs.org 和 GitHub 的网络连接后重试。 / npm ci failed. Check the npm error above, disk space, and access to registry.npmjs.org and GitHub, then retry.' }
            Show-SetupStage '检查、构建与打包桌面 / Check, build and package desktop'
            & $npm run typecheck
            if ($LASTEXITCODE -ne 0) { throw '类型检查失败，未继续打包。 / Type check failed; packaging was not attempted.' }
            & $npm test -- --no-file-parallelism
            if ($LASTEXITCODE -ne 0) { throw '测试失败，未继续打包。 / Tests failed; packaging was not attempted.' }
            & $npm run build
            if ($LASTEXITCODE -ne 0) { throw '构建失败，请保留上方错误信息。 / Build failed; keep the error shown above.' }
            & $npm run package
            if ($LASTEXITCODE -ne 0) { throw '打包失败。请检查上方错误、网络与磁盘空间；已有版本不会被覆盖。 / Packaging failed. Check the error above, connectivity and disk space; an existing release is not overwritten.' }
        } finally { Pop-Location }
    }
    if (-not $BuildOnly) {
        Show-SetupStage '准备本地 Ollama / Prepare local Ollama'
        $runtime = Join-Path $ollama 'runtime'
        if (-not (Test-Path -LiteralPath (Join-Path $runtime 'ollama.exe'))) {
            $archive = Join-Path $ollama 'downloads\ollama-windows-amd64-v0.40.10.zip'
            CheckedDownload 'https://github.com/ollama/ollama/releases/download/v0.40.10/ollama-windows-amd64.zip' $archive $runtimeHash
            ExtractNew $archive $runtime
        }
        # Run in a child shell: Start.ps1 isolates Ollama environment and exits on success.
        & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ollama 'Start.ps1')
        if ($LASTEXITCODE -ne 0) { throw "本地 Ollama 启动失败。请检查上方错误与 $ollama\logs；不会停止或复用其他服务。 / Managed Ollama could not start. Check the error above and $ollama\logs. An unrelated service is never stopped or reused." }
        Show-SetupStage "下载模型并创建别名 / Download model and create alias: $Model"
        Write-Host '模型下载中断可用相同参数重跑本安装脚本续传。安装成功不代表已验证模型推理。 / Rerun this installer with the same options to resume an interrupted model download. Setup does not validate model inference.'
        $exe = Join-Path $runtime 'ollama.exe'
        $env:OLLAMA_HOST = '127.0.0.1:11434'
        [void](Assert-LocalCodeManagedServer $ollama)
        & $exe pull $Model
        if ($LASTEXITCODE -ne 0) { throw '模型下载失败。请检查网络、模型名称与磁盘空间；使用相同参数重跑本安装脚本可续传。 / Model download failed. Check connectivity, the model name and disk space; rerun this installer with the same options to resume.' }
        $file = Join-Path $ollama 'Agent.Modelfile'
        "FROM $Model`nPARAMETER num_ctx $Context" | Set-Content -LiteralPath $file -Encoding ascii
        [void](Assert-LocalCodeManagedServer $ollama)
        & $exe create localcode-agent -f $file
        if ($LASTEXITCODE -ne 0) { throw '模型别名创建失败，请保留上方错误后重试。 / Model alias creation failed; keep the error above and retry.' }
        @{contextWindow=$Context;maxTokens=$MaxTokens} | ConvertTo-Json | Set-Content -LiteralPath $profilePath -Encoding ascii
        $record = @{ baseModel=$Model; alias='localcode-agent'; context=$Context; maxTokens=$MaxTokens; ollamaVersion='0.40.10'; createdAt=(Get-Date).ToString('o'); inferenceValidation='UNRUN' }
        $record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ollama 'logs\deployment.json') -Encoding utf8
    }
    Write-Host "`n安装完成，请双击 Start.cmd。 / Setup complete. Double-click Start.cmd." -ForegroundColor Green
    if ($BuildOnly) { Write-Host '仅桌面已就绪：未安装本地模型。请在应用内配置提供方，或稍后运行 Setup.cmd 安装本地模型。 / Desktop only: no local model was installed. Configure a provider in the app, or run Setup.cmd later for a local model.' }
    if ($ModelOnly) { Write-Host '本地模型已准备好。打开应用后，可在设置中检查本套本地服务；重启电脑后如需使用，请手动启动。 / Local model ready. Open the app and check the managed local service in Settings; start it explicitly after reboot when needed.' }
    Write-Host '未调用付费/云端模型。 / No paid/cloud model requests were made.'
} catch {
    Write-Host "`n安装停止于 / Setup stopped at: $stage" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host '请保留上方错误信息。解决后从同一目录、使用相同参数重试；无需重新安装 Node.js 或 Git。 / Keep the error above. After resolving it, retry the same installer from the same folder with the same options; no manual Node.js or Git installation is needed.'
    exit 1
}
