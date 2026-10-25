param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
Push-Location $repoRoot
try {
    $dirty = @(& git status --porcelain --untracked-files=normal)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count) { throw 'Commit the reviewed source first. Candidate creation requires a clean checkout.' }
    $commit = (& git rev-parse HEAD).Trim()
    $version = (Get-Content -LiteralPath 'LocalCode/source/package.json' -Raw | ConvertFrom-Json).version
    $destination = [IO.Path]::GetFullPath($OutputDirectory)
    if (Test-Path -LiteralPath $destination) { throw 'Output already exists; candidate files are never overwritten.' }
    New-Item -ItemType Directory -Path $destination | Out-Null
    $portableName = "LocalCode-$version-windows-x64-candidate"
    $portableFolder = Join-Path $destination $portableName
    & node 'scripts/portable-bundle.mjs' $portableFolder
    if ($LASTEXITCODE -ne 0) { throw 'Portable allowlist assembly failed; partial candidate retained.' }
    $portableZip = Join-Path $destination ($portableName + '.zip')
    Compress-Archive -LiteralPath $portableFolder -DestinationPath $portableZip
    $sourceName = "LocalCode-$version-source-candidate"
    $sourceZip = Join-Path $destination ($sourceName + '.zip')
    & git archive --format=zip "--prefix=$sourceName/" "--output=$sourceZip" $commit
    if ($LASTEXITCODE -ne 0) { throw 'Source archive failed.' }
    $kitName = "LocalCode-$version-acceptance"
    $kitFolder = Join-Path $destination $kitName
    New-Item -ItemType Directory -Path $kitFolder | Out-Null
    # Read tracked files from the commit archive, preserving Unicode in Windows PowerShell 5.1.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($sourceZip)
    try {
        $prefix = "$sourceName/scripts/acceptance/"
        foreach ($entry in $archive.Entries) {
            if (-not $entry.FullName.StartsWith($prefix, [StringComparison]::Ordinal) -or -not $entry.Name) { continue }
            $relative = $entry.FullName.Substring($prefix.Length)
            $target = [IO.Path]::GetFullPath((Join-Path $kitFolder $relative))
            if (-not $target.StartsWith($kitFolder + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid acceptance archive path.' }
            New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
        }
    } finally { $archive.Dispose() }
    # Plain text opens in Windows Notepad without a Markdown application.
    $guideFile = Get-ChildItem -LiteralPath $kitFolder -File -Filter '*.md' | Where-Object { $_.Name -ne 'README.zh-CN.md' } | Select-Object -First 1
    if (-not $guideFile) { throw 'Missing beginner instructions.' }
    $guide = Get-Content -LiteralPath $guideFile.FullName -Raw -Encoding UTF8
    $guide | Set-Content -LiteralPath (Join-Path $kitFolder ([IO.Path]::ChangeExtension($guideFile.Name, '.txt'))) -Encoding UTF8
    $kitZip = Join-Path $destination ($kitName + '.zip')
    Compress-Archive -LiteralPath $kitFolder -DestinationPath $kitZip
    $artifacts = @($portableZip, $sourceZip, $kitZip) | ForEach-Object {
        [pscustomobject]@{ name = [IO.Path]::GetFileName($_); sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = (Get-Item -LiteralPath $_).Length }
    }
    @($artifacts | ForEach-Object { $_.sha256 + '  ' + $_.name }) | Set-Content -LiteralPath (Join-Path $destination 'SHA256SUMS.txt') -Encoding ascii
    $manifest = [ordered]@{ schemaVersion = 1; version = $version; commit = $commit; createdAt = (Get-Date).ToUniversalTime().ToString('o'); candidate = $true; signed = $false; platform = 'Windows x64'; artifacts = @($artifacts); cleanWindows = 'UNRUN: awaiting external tester'; freshOllama = 'UNRUN: awaiting fresh default model installation and computer reboot'; releaseReady = $false }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $destination 'candidate-manifest.json') -Encoding UTF8
    Write-Host ('Candidate prepared: ' + $destination)
    Write-Host 'No GitHub Release was created. Final release requires all acceptance evidence and exact-byte revalidation.'
} finally { Pop-Location }
