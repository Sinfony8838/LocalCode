param([switch]$Inference)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$profile = Get-Content -LiteralPath (Join-Path $root 'LocalCode\model-profile.json') -Raw | ConvertFrom-Json
$tags = Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 10
$model = @($tags.models | Where-Object { $_.name -eq 'localcode-agent:latest' -or $_.name -eq 'localcode-agent' })
if ($model.Count -ne 1) { throw 'localcode-agent is missing. Run Setup.cmd first.' }
$result = [ordered]@{ alias=$model[0].name; digest=$model[0].digest; bytes=$model[0].size; context=$profile.contextWindow; inference='UNRUN'; toolCalling='UNRUN' }
if ($Inference) {
    $body = @{ model='localcode-agent'; prompt='Reply with one short greeting.'; stream=$false; think=$false; options=@{num_ctx=$profile.contextWindow;num_predict=32} } | ConvertTo-Json -Depth 4
    $response = Invoke-RestMethod 'http://127.0.0.1:11434/api/generate' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 300
    if (-not $response.done -or -not $response.response) { throw 'No completed text response.' }
    $result.inference = 'TEXT_RESPONSE_RECEIVED'
    $result.response = $response.response
}
$result.loadedModels = (Invoke-RestMethod 'http://127.0.0.1:11434/api/ps' -TimeoutSec 10).models
$result | ConvertTo-Json -Depth 8
