$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'numbers.ps1')
$cases = @(@(2, 3, 5), @(-2, 5, 3), @(0, 0, 0))
foreach ($case in $cases) {
    $actual = Add-Numbers $case[0] $case[1]
    if ($actual -ne $case[2]) { throw "Expected $($case[2]); got $actual" }
}
Write-Output 'PASS: 3 addition cases'
