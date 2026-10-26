param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'results'))
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$adminSid = 'S-1-5-32-544'
$adminMember = @($identity.Groups | ForEach-Object { $_.Value }) -contains $adminSid
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$commands = @('node.exe', 'npm.cmd', 'git.exe', 'python.exe', 'python3.exe', 'ollama.exe')
$tools = @($commands | ForEach-Object {
    $found = @(Get-Command $_ -CommandType Application -ErrorAction SilentlyContinue)
    [pscustomobject]@{ name = $_; found = $found.Count -gt 0; windowsStoreAlias = @($found | Where-Object { $_.Source -like '*\WindowsApps\python*' }).Count -gt 0 }
})
$build = [Environment]::OSVersion.Version.Build
$windows11x64 = $build -ge 22000 -and [Environment]::Is64BitOperatingSystem -and $env:PROCESSOR_ARCHITECTURE -eq 'AMD64'
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 11434 -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort, OwningProcess)
$drives = @(Get-PSDrive -PSProvider FileSystem | ForEach-Object { [pscustomobject]@{ name = $_.Name; freeGiB = [Math]::Round($_.Free / 1GB, 2) } })
$report = [ordered]@{
    schemaVersion = 1; recordedAt = (Get-Date).ToUniversalTime().ToString('o'); osBuild = $build; architecture = $env:PROCESSOR_ARCHITECTURE
    windows11x64 = $windows11x64; accountIsAdministrator = $adminMember; processElevated = $elevated; globalTools = $tools
    port11434Listeners = $listeners; disks = $drives; powershellVersion = $PSVersionTable.PSVersion.ToString()
    eligibleCleanInstall = $windows11x64 -and -not $adminMember -and -not $elevated -and @($tools | Where-Object { $_.found }).Count -eq 0 -and $listeners.Count -eq 0
    inferenceValidation = 'UNRUN'; privacy = 'No username, credentials, history, project files or environment variable values collected.'
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = Join-Path $OutputDirectory ('environment-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $output -Encoding UTF8
Write-Host ('Report: ' + $output)
Write-Host ('Eligible clean-install environment: ' + $report.eligibleCleanInstall)
Write-Host 'If false, retain the report. Do not uninstall software, elevate, or change system protection to make this check pass.'
Write-Host 'Python Windows Store aliases require manual review; never count them as proof of a clean environment.'
