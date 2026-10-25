# Dependency-free smoke tests: only synthetic files in a unique temporary folder.
# No real runtime/model downloads, service starts, builds or provider requests.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Setup.Helpers.ps1')
$checks = 0
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
    $script:checks++
}
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
    $message = $null
    $failureStack = $null
    try { & $Action | Out-Null } catch { $message = $_.Exception.Message; $failureStack = $_.ScriptStackTrace }
    Assert ($null -ne $message -and $message -match $Pattern) "Expected failure matching '$Pattern'; got '$message'. Failure stack: $failureStack"
}
function File-Snapshot([string]$Folder) {
    @((Get-ChildItem -LiteralPath $Folder -Recurse -Force | Sort-Object FullName | ForEach-Object {
        "$($_.FullName)|$($_.LastWriteTimeUtc.Ticks)|$(if (-not $_.PSIsContainer) { $_.Length })"
    })) -join "`n"
}
function File-ContentSnapshot([string]$Folder) {
    @((Get-ChildItem -LiteralPath $Folder -Recurse -Force | Sort-Object FullName | ForEach-Object {
        if ($_.PSIsContainer) { "$($_.FullName)|directory" }
        else { "$($_.FullName)|file|$($_.Length)|$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)" }
    })) -join "`n"
}
$temp = Join-Path ([IO.Path]::GetTempPath()) ('LocalCode-setup-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    foreach ($file in @('Setup.ps1', 'scripts\Setup.Helpers.ps1', 'scripts\Test-Setup.ps1', 'Ollama\Start.ps1')) {
        $tokens = $null
        $parseErrors = $null
        [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root $file), [ref]$tokens, [ref]$parseErrors) | Out-Null
        Assert (@($parseErrors).Count -eq 0) "PowerShell parser: $file ($parseErrors)"
        $bytes = [IO.File]::ReadAllBytes((Join-Path $root $file))
        Assert ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) "UTF-8 BOM keeps Chinese readable in Windows PowerShell 5.1: $file"
    }
    Assert-LocalCodeSupportedHost -Platform Win32NT -Architecture AMD64 -Is64BitOS $true -PowerShellVersion '5.1'
    Assert-Throws { Assert-LocalCodeSupportedHost -Platform Unix -Architecture AMD64 -Is64BitOS $true -PowerShellVersion '7.0' } 'Windows x64'
    Assert-Throws { Assert-LocalCodeSupportedHost -Platform Win32NT -Architecture ARM64 -Is64BitOS $true -PowerShellVersion '5.1' } 'ARM64'
    Assert-Throws { Assert-LocalCodeSupportedHost -Platform Win32NT -Architecture x86 -Is64BitOS $false -PowerShellVersion '5.1' } 'Windows x64'
    Assert-Throws { Assert-LocalCodeSupportedHost -Platform Win32NT -Architecture AMD64 -Is64BitOS $true -PowerShellVersion '5.0' } 'PowerShell 5.1'
    Assert (-not (Get-LocalCodeDiskAdvice 512MB).HasScratchSpace) 'Critically low disk space is blocked'
    Assert ((Get-LocalCodeDiskAdvice 1GB).HasScratchSpace) 'Minimum disk boundary'
    Assert ((Get-LocalCodeDiskAdvice 5GB -BuildOnly).BelowRecommendation -eq $false) 'Desktop-only recommendation is 5 GiB'
    Assert ((Get-LocalCodeDiskAdvice 5GB).BelowRecommendation) 'Model installation warns below 25 GiB'
    Assert (-not (Get-LocalCodeDiskAdvice 25GB).BelowRecommendation) 'Full disk recommendation boundary'
    $originalWriteProbe = ${function:Assert-LocalCodeWritableFolder}
    $originalTransfer = ${function:Invoke-LocalCodeTransfer}
    $script:networkPathWrites = 0
    $script:networkPathDownloads = 0
    function Assert-LocalCodeWritableFolder { param($Root) $script:networkPathWrites++ }
    function Invoke-LocalCodeTransfer { param($Url, $Destination) $script:networkPathDownloads++ }
    try {
        Assert-Throws { Assert-LocalCodeInstallFolder '\\not-a-real-localcode-host\share' } 'local drive'
        Assert ($script:networkPathWrites -eq 0 -and $script:networkPathDownloads -eq 0) 'Network path rejection makes no write probes or downloads'
    } finally {
        Set-Item Function:\Assert-LocalCodeWritableFolder -Value $originalWriteProbe
        Set-Item Function:\Invoke-LocalCodeTransfer -Value $originalTransfer
    }
    $before = File-Snapshot $temp
    Assert-LocalCodeWritableFolder $temp
    Assert ((File-Snapshot $temp) -eq $before) 'Write probe cleans up its own temporary file'
    Assert-Throws { Assert-LocalCodeWritableFolder (Join-Path $temp 'missing\folder') } 'writable local directory'

    $fixture = Join-Path $temp 'ZIP source with spaces'
    foreach ($relative in @('LocalCode\source\package.json', 'LocalCode\source\package-lock.json', 'LocalCode\source\scripts\build.mjs', 'LocalCode\model-profile.json', 'Ollama\Start.ps1', 'Ollama\Environment.ps1')) {
        $path = Join-Path $fixture $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
        [IO.File]::WriteAllText($path, '{}')
    }
    Assert-LocalCodeSourceLayout $fixture
    Assert (-not (Test-Path -LiteralPath (Join-Path $fixture '.git'))) 'ZIP source requires no Git metadata'
    Remove-Item -LiteralPath (Join-Path $fixture 'LocalCode\source') -Recurse
    Assert-LocalCodeSourceLayout $fixture -ModelOnly
    Assert-Throws { Assert-LocalCodeSourceLayout $fixture } 'Extract the entire ZIP'
    Assert-Throws { Assert-LocalCodePackagedApp $fixture } 'no model will be downloaded'
    $app = Join-Path $fixture 'LocalCode\app'
    New-Item -ItemType Directory -Path (Join-Path $app 'releases\test\LocalCode-win32-x64') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $app 'current.txt'), "releases\test\LocalCode-win32-x64`r`n")
    [IO.File]::WriteAllText((Join-Path $app 'releases\test\LocalCode-win32-x64\LocalCode.exe'), 'synthetic-not-executable')
    Assert-LocalCodePackagedApp $fixture
    $invalidReleases = @('', " `t`r`n", '..\outside', '../outside', 'C:\outside', 'C:relative', '\rooted', '/rooted', "releases\test`nother", '\\server\share')
    # Exercise the full C0 range on .NET Framework, not only newline/NUL.
    foreach ($code in (0..31) + @(127)) { $invalidReleases += 'releases\bad' + [char]$code + '\LocalCode-win32-x64' }
    foreach ($character in @('"', ':', '*', '?', '<', '>', '|')) { $invalidReleases += 'releases\bad' + $character + '\LocalCode-win32-x64' }
    # Only the marker's CR/LF record ending may be trimmed, not other controls.
    $invalidReleases += "`tLocalCode-win32-x64", "LocalCode-win32-x64`t"
    foreach ($invalid in $invalidReleases) {
        [IO.File]::WriteAllText((Join-Path $app 'current.txt'), $invalid)
        Assert-Throws { Assert-LocalCodePackagedApp $fixture } 'Invalid app release path'
    }

    $managedRoot = Join-Path $temp 'managed ownership fixture'
    New-Item -ItemType Directory -Path (Join-Path $managedRoot 'logs') -Force | Out-Null
    $managedPid = Join-Path $managedRoot 'logs\server.pid'
    [IO.File]::WriteAllText($managedPid, '123')
    $script:fakeProcess = [pscustomobject]@{ Id = 123; Path = (Join-Path $managedRoot 'runtime\ollama.exe') }
    $script:fakeListeners = @([pscustomobject]@{ OwningProcess = 123 })
    $originalListeners = ${function:Get-LocalCodePortListeners}
    function Get-Process { param($Id, $ErrorAction) $script:fakeProcess }
    function Get-LocalCodePortListeners { $script:fakeListeners }
    try {
        Assert (Assert-LocalCodeManagedServer $managedRoot) 'Managed executable and matching listener PID are required'
        [IO.File]::WriteAllText($managedPid, " 123`r`n")
        Assert (Assert-LocalCodeManagedServer $managedRoot) 'PID parsing accepts whitespace without calling Trim on file output'
        $script:fakeListeners = @([pscustomobject]@{ OwningProcess = 456 })
        Assert-Throws { Assert-LocalCodeManagedServer $managedRoot } 'unrelated listener'
        $script:fakeListeners = @([pscustomobject]@{ OwningProcess = 123 }, [pscustomobject]@{ OwningProcess = 456 })
        Assert-Throws { Assert-LocalCodeManagedServer $managedRoot } 'unrelated listener'
        $script:fakeListeners = @()
        Assert (-not (Assert-LocalCodeManagedServer $managedRoot -AllowStarting)) 'Startup can wait for its own listener without calling HTTP'
        Assert-Throws { Assert-LocalCodeManagedServer $managedRoot } 'not listening'
        $script:fakeListeners = @([pscustomobject]@{ OwningProcess = 123 })
        $script:fakeProcess.Path = 'different-runtime.exe'
        Assert-Throws { Assert-LocalCodeManagedServer $managedRoot } 'path does not match'
        $script:fakeProcess = $null
        Assert-Throws { Assert-LocalCodeManagedServer $managedRoot } 'not running'
        foreach ($invalid in @('', " `t`r`n", 'bad-pid', '-1')) {
            [IO.File]::WriteAllText($managedPid, $invalid)
            Assert-Throws { Assert-LocalCodeManagedServer $managedRoot } 'PID record is invalid'
        }
    } finally {
        Remove-Item Function:\Get-Process
        Set-Item Function:\Get-LocalCodePortListeners -Value $originalListeners
    }

    # The real listener filter must exclude other ports and non-listening sockets.
    $script:tcpFailure = $false
    function Get-Command { param($Name, $CommandType, $ErrorAction) [pscustomobject]@{ Name = $Name } }
    function Get-NetTCPConnection {
        param($ErrorAction)
        if ($script:tcpFailure) { throw 'synthetic diagnostics failure' }
        @([pscustomobject]@{ LocalPort = 11434; State = 'Listen'; OwningProcess = 123 },
          [pscustomobject]@{ LocalPort = 11434; State = 'Established'; OwningProcess = 456 },
          [pscustomobject]@{ LocalPort = 11435; State = 'Listen'; OwningProcess = 789 })
    }
    try {
        $listeners = @(Get-LocalCodePortListeners)
        Assert ($listeners.Count -eq 1 -and $listeners[0].OwningProcess -eq 123) 'Listener query filters by port and listening state'
        $script:tcpFailure = $true
        Assert-Throws { Get-LocalCodePortListeners } 'Unable to verify port 11434 ownership'
    } finally {
        Remove-Item Function:\Get-Command
        Remove-Item Function:\Get-NetTCPConnection
    }

    # Exercise the real fallback path while replacing all network transports.
    $script:webRequestCalls = 0
    function Get-Command { param($Name, $CommandType, $ErrorAction) return $null }
    function Invoke-WebRequest {
        param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
        $script:webRequestCalls++
        [IO.File]::WriteAllText($OutFile, 'synthetic-fallback')
    }
    $fallback = Join-Path $temp 'fallback'
    try {
        Assert-Throws { Get-LocalCodePortListeners } 'Get-NetTCPConnection is unavailable'
        Invoke-LocalCodeTransfer 'https://example.invalid/archive.zip' $fallback
        Assert ($script:webRequestCalls -eq 1) 'Missing curl uses the built-in PowerShell download path'
        Assert ((Get-Content -LiteralPath $fallback -Raw) -eq 'synthetic-fallback') 'Fallback destination is honored'
    } finally {
        Remove-Item Function:\Get-Command
        Remove-Item Function:\Invoke-WebRequest
    }

    $script:transferCalls = 0
    $script:failTransfer = $false
    function Invoke-LocalCodeTransfer([string]$Url, [string]$Destination) {
        $script:transferCalls++
        [IO.File]::WriteAllText($Destination, 'synthetic-archive')
        if ($script:failTransfer) { throw 'synthetic offline failure' }
    }
    $payload = Join-Path $temp 'payload'
    [IO.File]::WriteAllText($payload, 'synthetic-archive')
    $hash = (Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant()
    $archive = Join-Path $temp 'verified.zip'
    CheckedDownload 'https://example.invalid/archive.zip' $archive $hash
    Assert ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -eq $hash) 'Successful transfer verifies the hash before activation'
    CheckedDownload 'https://example.invalid/archive.zip' $archive $hash
    Assert ($script:transferCalls -eq 1) 'Verified cache is reused without network'
    Assert-Throws { CheckedDownload 'https://example.invalid/archive.zip' $archive ('0' * 64) } 'Cached checksum mismatch'
    Assert ($script:transferCalls -eq 1) 'Bad cache is not silently replaced/downloaded'
    $bad = Join-Path $temp 'bad.zip'
    Assert-Throws { CheckedDownload 'https://example.invalid/archive.zip' $bad ('0' * 64) } 'nothing was extracted'
    Assert (-not (Test-Path -LiteralPath $bad)) 'Bad download is never activated'
    Assert (@(Get-ChildItem -LiteralPath $temp -Filter 'bad.zip.*.part').Count -eq 1) 'Failed checksum retains partial evidence'
    $script:failTransfer = $true
    $offline = Join-Path $temp 'offline.zip'
    Assert-Throws { CheckedDownload 'https://example.invalid/archive.zip' $offline $hash } 'Check connectivity/proxy'
    Assert (-not (Test-Path -LiteralPath $offline)) 'Network failure never activates an archive'
    Assert (@(Get-ChildItem -LiteralPath $temp -Filter 'offline.zip.*.part').Count -eq 1) 'Network failure preserves its partial file'
    $target = Join-Path $temp 'existing-runtime'
    New-Item -ItemType Directory -Path $target | Out-Null
    [IO.File]::WriteAllText((Join-Path $target 'keep.txt'), 'keep')
    Assert-Throws { ExtractNew $archive $target } 'Refusing to overwrite'
    Assert ((Get-Content -LiteralPath (Join-Path $target 'keep.txt') -Raw) -eq 'keep') 'Existing extraction files are preserved'

    $invalidTarget = Join-Path $temp 'invalid-archive-runtime'
    Assert-Throws { ExtractNew $archive $invalidTarget } 'Extraction failed'
    Assert (-not (Test-Path -LiteralPath $invalidTarget)) 'Invalid archive never activates a runtime'
    $zipSource = Join-Path $temp 'tiny zip source'
    New-Item -ItemType Directory -Path $zipSource | Out-Null
    [IO.File]::WriteAllText((Join-Path $zipSource 'hello.txt'), 'synthetic-only')
    $tinyZip = Join-Path $temp 'tiny.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($zipSource, $tinyZip)
    $zipTarget = Join-Path $temp 'tiny extracted'
    ExtractNew $tinyZip $zipTarget
    Assert ((Get-Content -LiteralPath (Join-Path $zipTarget 'hello.txt') -Raw) -eq 'synthetic-only') 'Verified extraction promotes a complete destination'

    # A standalone copy proves Plan does not import helpers, probe writable paths,
    # create folders, download binaries, start services, or require source/Git/Node.
    $planRoot = Join-Path $temp 'plan only'
    New-Item -ItemType Directory -Path $planRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'Setup.ps1') -Destination $planRoot
    $shell = (Get-Process -Id $PID).Path
    $before = File-Snapshot $planRoot
    foreach ($mode in @('full', 'build', 'model')) {
        $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $planRoot 'Setup.ps1'), '-Plan')
        if ($mode -eq 'build') { $arguments += '-BuildOnly' }
        if ($mode -eq 'model') { $arguments += '-ModelOnly' }
        $json = & $shell @arguments
        Assert ($LASTEXITCODE -eq 0) "Plan succeeds for $mode"
        $plan = $json | ConvertFrom-Json
        Assert ($plan.cloudRequests -eq 0 -and -not $plan.manualNodeOrGitRequired) 'Plan promises no manual Node/Git or model requests'
        Assert ($plan.nodeSha256 -eq '313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66') 'Node integrity pin is unchanged'
        Assert ($plan.runtimeSha256 -eq 'd52aea2d323bdd324bf66a4b1226844aa5fb665cc5974fbcceceda1ce3d934eb') 'Ollama integrity pin is unchanged'
        Assert ($plan.downloadsModel -eq ($mode -ne 'build')) 'Plan model download mode is accurate'
        Assert ($plan.buildsDesktop -eq ($mode -ne 'model')) 'Model-only plan skips desktop build'
        Assert ((File-Snapshot $planRoot) -eq $before) 'Plan makes no filesystem changes'
    }
    # Missing packaged executable must fail before any directory creation/download.
    Copy-Item -LiteralPath (Join-Path $root 'Setup.ps1') -Destination $fixture
    New-Item -ItemType Directory -Path (Join-Path $fixture 'scripts') | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Setup.Helpers.ps1') -Destination (Join-Path $fixture 'scripts')
    Remove-Item -LiteralPath $app -Recurse
    $beforeContent = File-ContentSnapshot $fixture
    $before = File-Snapshot $fixture
    $output = & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fixture 'Setup.ps1') -ModelOnly
    Assert ($LASTEXITCODE -ne 0) 'Missing desktop rejects ModelOnly'
    Assert (($output -join "`n") -match 'no model will be downloaded') 'Missing desktop supplies actionable instructions'
    $after = File-Snapshot $fixture
    $afterContent = File-ContentSnapshot $fixture
    if ($after -ne $before) {
        Write-Host 'Unexpected filesystem metadata difference: <= before, => after; path|LastWriteTimeUtc.Ticks|length'
        Compare-Object -ReferenceObject @($before -split "`n") -DifferenceObject @($after -split "`n") | ForEach-Object {
            Write-Host "$($_.SideIndicator) $($_.InputObject)"
        }
        if ($afterContent -eq $beforeContent) {
            Write-Host 'Independent content/path comparison: IDENTICAL (all file SHA-256 hashes, lengths and directory/file paths).'
        } else {
            Write-Host 'Independent content/path difference: <= before, => after; path|type|length|SHA-256'
            Compare-Object -ReferenceObject @($beforeContent -split "`n") -DifferenceObject @($afterContent -split "`n") | ForEach-Object {
                Write-Host "$($_.SideIndicator) $($_.InputObject)"
            }
        }
    }
    Assert ($after -eq $before) 'Rejected ModelOnly creates no files/downloads'
    Write-Host "Setup smoke tests: PASS ($checks checks; no real downloads or service starts)"
} finally {
    # Delete only this test's own unique synthetic fixture directory.
    Remove-Item -LiteralPath $temp -Recurse -Force
}
# An expected failing native child leaves LASTEXITCODE = 1. Clear the process
# result only after all assertions and finally cleanup complete successfully.
exit 0
