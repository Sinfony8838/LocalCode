# Dot-sourcing this file only defines helpers; it never downloads or writes files.
function Assert-LocalCodeSupportedHost {
    param(
        [string]$Platform = [Environment]::OSVersion.Platform.ToString(),
        [string]$Architecture = $(if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }),
        [bool]$Is64BitOS = [Environment]::Is64BitOperatingSystem,
        [version]$PowerShellVersion = $PSVersionTable.PSVersion
    )
    if ($Platform -ne 'Win32NT' -or -not $Is64BitOS -or $Architecture -ne 'AMD64') {
        throw '需要 Windows x64（推荐 Windows 11），不支持 ARM64、32 位 Windows、macOS 或 Linux。 / Use Windows x64 (Windows 11 recommended); ARM64 and other platforms are not supported by this setup.'
    }
    if ($PowerShellVersion -lt [version]'5.1') {
        throw '需要 Windows PowerShell 5.1 或更新版本。请使用 Windows 自带的 powershell.exe。 / Windows PowerShell 5.1 or later is required. Use the built-in powershell.exe.'
    }
}

function Assert-LocalCodeSourceLayout([string]$Root, [switch]$ModelOnly) {
    $required = @('LocalCode\model-profile.json', 'Ollama\Start.ps1', 'Ollama\Environment.ps1')
    if (-not $ModelOnly) { $required += @('LocalCode\source\package.json', 'LocalCode\source\package-lock.json', 'LocalCode\source\scripts\build.mjs') }
    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)) {
            throw "源码文件缺失：$relative。请先完整解压 ZIP，再从解压后的目录运行 Setup.cmd，无需安装 Git。 / Missing source file: $relative. Extract the entire ZIP before running Setup.cmd; Git is not required."
        }
    }
}

function Assert-LocalCodePackagedApp([string]$Root) {
    $app = Join-Path $Root 'LocalCode\app'
    $marker = Join-Path $app 'current.txt'
    $release = 'LocalCode-win32-x64'
    if (Test-Path -LiteralPath $marker) {
        # Windows PowerShell 5.1 can return no pipeline value for an empty file.
        # ReadAllText returns an empty string deterministically; guard before Trim.
        [string]$releaseContents = [System.IO.File]::ReadAllText($marker)
        if ([string]::IsNullOrWhiteSpace($releaseContents)) { $release = '' }
        else { $release = $releaseContents.Trim() }
    }
    if (-not $release -or [System.IO.Path]::IsPathRooted($release) -or $release -match '[\r\n":*?<>|]' -or @($release -split '[\\/]' | Where-Object { $_ -eq '..' }).Count) {
        throw '应用版本路径无效。请重新完整解压便携 ZIP，不会修改已有文件。 / Invalid app release path. Extract a fresh complete portable ZIP; existing files are preserved.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $app $release) 'LocalCode.exe') -PathType Leaf)) {
        throw '尚未安装桌面程序，不会下载模型。请先完整解压便携版 ZIP；源码用户请运行 Setup.cmd。 / The desktop is not installed; no model will be downloaded. Extract the complete portable ZIP first; source users should run Setup.cmd.'
    }
}

function Assert-LocalCodeWritableFolder([string]$Root) {
    $probe = Join-Path $Root ('.localcode-write-check-' + [guid]::NewGuid().ToString('N'))
    $created = $false
    try {
        $stream = [System.IO.File]::Open($probe, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $created = $true
        $stream.Dispose()
    } catch {
        throw "无法写入安装目录：$Root。请把完整文件夹移动到自己可写的本地目录（例如 D:\LocalCode），无需以管理员运行。 / Cannot write to $Root. Move the complete folder to a writable local directory; administrator rights are not needed."
    } finally {
        if ($created) { Remove-Item -LiteralPath $probe -ErrorAction Stop }
    }
}

function Get-LocalCodeDiskAdvice([long]$AvailableBytes, [switch]$BuildOnly) {
    # A small hard floor catches clearly unusable disks; recommendations are not
    # model-size guarantees and do not block a resumed/cached installation.
    [pscustomobject]@{
        AvailableGiB = [math]::Round($AvailableBytes / 1GB, 1)
        MinimumBytes = 1GB
        RecommendedGiB = $(if ($BuildOnly) { 5 } else { 25 })
        HasScratchSpace = $AvailableBytes -ge 1GB
        BelowRecommendation = $AvailableBytes -lt $(if ($BuildOnly) { 5GB } else { 25GB })
    }
}

function Assert-LocalCodeInstallFolder([string]$Root, [switch]$BuildOnly) {
    if ($Root.StartsWith('\\')) {
        throw '请把完整文件夹移动到本地磁盘，不要从网络共享目录运行。 / Move the complete folder to a local drive, not a network share.'
    }
    $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($Root))
    if ($drive.DriveType -eq [System.IO.DriveType]::Network) {
        throw '请把完整文件夹移动到本地磁盘，不要从网络共享目录运行。 / Move the complete folder to a local drive, not a network share.'
    }
    Assert-LocalCodeWritableFolder $Root
    $advice = Get-LocalCodeDiskAdvice $drive.AvailableFreeSpace -BuildOnly:$BuildOnly
    Write-Host "可用磁盘 / Free disk: $($advice.AvailableGiB) GiB; 建议预留 / recommended: $($advice.RecommendedGiB) GiB."
    if (-not $advice.HasScratchSpace) {
        throw '可用空间不足 1 GiB，无法安全准备下载与构建。请释放空间或移动完整目录后重试；脚本不会自动删除文件。 / Less than 1 GiB is free. Free disk space or move the complete folder, then retry. No files are deleted automatically.'
    }
    if ($advice.BelowRecommendation) {
        Write-Warning "空间低于建议的 $($advice.RecommendedGiB) GiB；模型大小不同，下载/解压可能需要更多空间。 / Below the recommended $($advice.RecommendedGiB) GiB; model downloads and extraction may need more space."
    }
}

function Invoke-LocalCodeTransfer([string]$Url, [string]$Destination) {
    if (Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue) {
        & curl.exe --fail --location --retry 3 --connect-timeout 30 --speed-time 120 --speed-limit 1024 --output $Destination $Url
        if ($LASTEXITCODE -ne 0) { throw "curl exit code: $LASTEXITCODE" }
    } else {
        Write-Host '未找到 curl.exe，改用 Windows PowerShell 下载。 / curl.exe is unavailable; using the built-in PowerShell downloader.'
        # Process-local setting only; certificate verification remains enabled.
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec 300
    }
}

function CheckedDownload([string]$Url, [string]$Destination, [string]$Hash) {
    if (Test-Path -LiteralPath $Destination) {
        if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) {
            throw "缓存文件校验失败，未解压：$Destination。请自行移走这个文件后重试；不会跳过安全校验。 / Cached checksum mismatch: $Destination. Move this file aside and retry; verification is never bypassed."
        }
        Write-Host "复用已校验下载 / Using verified archive: $Destination"
        return
    }
    $part = "$Destination.$([guid]::NewGuid().ToString('N')).part"
    Write-Host "下载 / Download: $Url"
    try { Invoke-LocalCodeTransfer $Url $part }
    catch {
        $hostName = ([uri]$Url).DnsSafeHost
        throw "下载失败：$hostName。请检查网络、代理或组织网络限制后重试；不要关闭证书校验或防火墙。临时文件（如有）保留在 $part。 / Download failed from $hostName. Check connectivity/proxy or your organization's network policy, then retry. Do not disable certificate checks or the firewall. Partial file, if created: $part. $($_.Exception.Message)"
    }
    if ((Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) {
        throw "下载文件 SHA-256 校验失败，未解压。请重试；若持续出现，请核对官方发布信息。文件保留在 $part。 / Downloaded archive checksum mismatch; nothing was extracted. Retry, or check the official release if this persists. Preserved file: $part"
    }
    Move-Item -LiteralPath $part -Destination $Destination -ErrorAction Stop
}

function ExtractNew([string]$Archive, [string]$Destination) {
    if (Test-Path -LiteralPath $Destination) {
        throw "目标目录已存在且不完整：$Destination。为保护文件不会覆盖。请检查并自行移走该目录后重试。 / Refusing to overwrite $Destination. Inspect and move the incomplete directory aside, then retry."
    }
    $pending = "$Destination.incomplete-$([guid]::NewGuid().ToString('N'))"
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($Archive, $pending)
        Move-Item -LiteralPath $pending -Destination $Destination -ErrorAction Stop
    } catch {
        throw "解压失败，请检查磁盘空间、写入权限和安全软件提示。未完成文件保留在 $pending。 / Extraction failed. Check free disk space, write permissions, and security-software notifications. Incomplete files are preserved at $pending. $($_.Exception.Message)"
    }
}

# Both setup and the explicit service launcher use these checks. An executable
# PID record alone does not prove that it owns the HTTP listener we will call.
function Get-LocalCodePortListeners {
    if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
        throw '缺少 Windows NetTCPIP 诊断命令，无法安全确认端口归属。请使用系统自带 PowerShell，或请管理员恢复系统网络诊断组件；不会自动修改系统。 / Windows Get-NetTCPConnection is unavailable, so listener ownership cannot be verified. Use built-in Windows PowerShell or ask your administrator to restore NetTCPIP diagnostics; no system changes are made.'
    }
    try {
        @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.LocalPort -eq 11434 -and $_.State -eq 'Listen' })
    } catch {
        throw "无法确认 11434 端口归属，已停止以保护其他服务。 / Unable to verify port 11434 ownership; stopped to protect other services. $($_.Exception.Message)"
    }
}

function Assert-LocalCodeManagedServer([string]$OllamaRoot, [int]$ServerId = 0, [switch]$AllowStarting) {
    $exe = Join-Path $OllamaRoot 'runtime\ollama.exe'
    if ($ServerId -le 0) {
        $pidFile = Join-Path $OllamaRoot 'logs\server.pid'
        if (-not (Test-Path -LiteralPath $pidFile) -or -not [int]::TryParse([System.IO.File]::ReadAllText($pidFile), [ref]$ServerId) -or $ServerId -le 0) {
            throw '本套 Ollama 的进程记录无效。请使用本套 Ollama\Start.cmd 重新启动；不会继续请求模型。 / Managed Ollama PID record is invalid. Start this installation using Ollama\Start.cmd; no further model request will be made.'
        }
    }
    $process = Get-Process -Id $ServerId -ErrorAction SilentlyContinue
    if (-not $process -or $process.Path -ne $exe) {
        throw '本套 Ollama 进程未运行或路径不匹配，不会继续请求模型。请重新启动本套服务。 / The managed runtime is not running or its path does not match; no further model request will be made. Restart this installation''s service.'
    }
    $listeners = @(Get-LocalCodePortListeners)
    if (@($listeners | Where-Object { $_.OwningProcess -ne $ServerId }).Count) {
        throw '端口 11434 存在其他进程的监听，已停止；不会停止或复用该服务。 / Port 11434 has an unrelated listener. Stopped without terminating or reusing that service.'
    }
    if (-not $listeners.Count) {
        if ($AllowStarting) { return $false }
        throw '本套 Ollama 尚未监听 11434 端口，请等待或检查 Ollama\logs。 / Managed Ollama is not listening on port 11434. Wait or check Ollama\logs.'
    }
    return $true
}
