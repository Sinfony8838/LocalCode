param(
    [Parameter(Mandatory = $true)][string]$Manifest,
    [Parameter(Mandatory = $true)][string]$Results,
    [Parameter(Mandatory = $true)][string]$EnvironmentReport,
    [Parameter(Mandatory = $true)][string]$CloudReport
)
$ErrorActionPreference = 'Stop'
$candidate = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$result = Get-Content -LiteralPath $Results -Raw | ConvertFrom-Json
$environment = Get-Content -LiteralPath $EnvironmentReport -Raw | ConvertFrom-Json
$cloud = Get-Content -LiteralPath $CloudReport -Raw | ConvertFrom-Json
$failures = New-Object 'System.Collections.Generic.List[string]'
if ($result.candidateCommit -ne $candidate.commit) { $failures.Add('Results refer to a different candidate commit.') }
foreach ($kind in @('portable', 'source')) {
    $artifact = @($candidate.artifacts | Where-Object { if ($kind -eq 'portable') { $_.name -like '*windows-x64*' } else { $_.name -like '*source*' } })
    $expected = $(if ($kind -eq 'portable') { $result.portableZipSha256 } else { $result.sourceZipSha256 })
    if ($artifact.Count -ne 1 -or $artifact[0].sha256 -ne $expected) { $failures.Add("$kind ZIP hash does not match the tested candidate.") }
}
if ($environment.eligibleCleanInstall -ne $true -or $environment.accountIsAdministrator -ne $false -or $environment.processElevated -ne $false) { $failures.Add('External environment does not establish a clean non-administrator Windows installation.') }
$required = @('P01', 'S01', 'S02', 'F01', 'F02', 'F03', 'F04', 'F05', 'M01', 'M02')
foreach ($id in $required) {
    $case = @($result.cases | Where-Object { $_.id -eq $id })
    if ($case.Count -ne 1 -or $case[0].status -ne 'PASS' -or [string]::IsNullOrWhiteSpace($case[0].evidence)) { $failures.Add("$id is missing PASS and concrete evidence.") }
}
if ($result.model.tag -ne 'qwen3.5:9b-q4_K_M' -or $result.model.digest -notmatch '^(sha256:)?[a-fA-F0-9]{64}$' -or $result.model.ollamaVersion -in @('', 'UNRUN', $null)) { $failures.Add('Fresh default Ollama runtime/model identity is incomplete.') }
if ($cloud.passed -ne $true -or $cloud.requestedModel -ne 'ark-code-latest' -or $cloud.totalRequests -lt 1 -or $cloud.productionHistoriesUsed -ne $false) { $failures.Add('Real-cloud acceptance is incomplete.') }
[pscustomobject]@{ evidenceComplete = $failures.Count -eq 0; releaseReady = $false; failures = $failures.ToArray(); note = 'Even complete submitted evidence still requires final commit CI, artifact scans and exact ZIP download/startup revalidation before publication.' } | ConvertTo-Json -Depth 5
if ($failures.Count) { exit 1 }
