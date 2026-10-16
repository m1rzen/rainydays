param(
    [Parameter(Mandatory = $true)][string]$SourceDatabase,
    [string]$UserData = (Join-Path $env:APPDATA 'rainydays'),
    [switch]$Apply
)
# 只追加缺少的会话和附件；默认预览，-Apply 才执行。不用旧备份覆盖整库。
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$arguments = @('--import', 'tsx', (Join-Path $root 'scripts\recover-session-history.mjs'), '--source', $SourceDatabase, '--user-data', $UserData)
if ($Apply) { $arguments += '--apply' }
Push-Location -LiteralPath $root
try { & node @arguments; if ($LASTEXITCODE -ne 0) { throw '会话恢复未完成；请查看上方错误。' } }
finally { Pop-Location }