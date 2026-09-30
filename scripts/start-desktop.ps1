param([switch]$RecoverNormal)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
$logPath = Join-Path $projectRoot 'test-results\desktop-launch.log'

try {
    New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
    $npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
    $electronPath = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path -LiteralPath $electronPath)) {
        throw '请先按照 README 安装项目依赖。'
    }
    Push-Location -LiteralPath $projectRoot
    try {
        # Native stderr contains diagnostic messages as well as failures; use the exit code.
        $ErrorActionPreference = 'Continue'
        if ($RecoverNormal) {
            & $npmCommand run electron:dev -- --recover-normal *> $logPath
        } else {
            & $npmCommand run electron:dev *> $logPath
        }
        if ($LASTEXITCODE -ne 0) {
            throw "启动未完成。详细信息保存在：$logPath"
        }
    } finally {
        $ErrorActionPreference = 'Stop'
        Pop-Location
    }
} catch {
    $_.Exception.Message | Out-File -LiteralPath $logPath -Append -Encoding utf8
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        "RainyDays 未能启动。`n`n$($_.Exception.Message)",
        'RainyDays', 'OK', 'Error'
    ) | Out-Null
    exit 1
}
