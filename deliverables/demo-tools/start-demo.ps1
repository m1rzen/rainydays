# RainyDays 演示啟動器：建置已是最新時跳過編譯，直接開啟桌面程式。
# 使用 npm 的 Node 啟動開發服務；應用仍會正常保存設定和對話。
$ErrorActionPreference = 'Stop'
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$log = Join-Path $root 'test-results\demo-launch.log'
Add-Type -AssemblyName PresentationFramework
function Fail($msg) {
    $msg | Out-File -LiteralPath $log -Append -Encoding utf8
    [System.Windows.MessageBox]::Show("RainyDays 演示啟動失敗`n`n$msg`n`n記錄：$log", 'RainyDays', 'OK', 'Error') | Out-Null
    exit 1
}
try {
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
    "=== demo launch $(Get-Date -Format s) ===" | Out-File -LiteralPath $log -Encoding utf8
    Push-Location -LiteralPath $root
    $electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path -LiteralPath $electron)) { Fail '找不到 Electron，請先在專案資料夾執行 npm ci。' }

    # 1. 程式是否已在執行（避免第二個實例與佔用埠）
    $port = if ($env:PORT) { [int]$env:PORT } else { 3111 }
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        Fail "RainyDays 似乎已經在執行（$port 埠被佔用）。請先從工作列切換到已開啟的視窗，或完全結束後再啟動。"
    }

    # 2. 上次是否未正常結束（連續三次會進入安全模式）
    $recovery = Join-Path $env:APPDATA 'rainydays\recovery-state.json'
    if (Test-Path $recovery) {
        $r = Get-Content $recovery -Raw | ConvertFrom-Json
        "recovery: safeMode=$($r.safeMode) unclean=$($r.uncleanLaunches.Count) serviceLoops=$($r.serviceCrashLoops)" | Out-File -LiteralPath $log -Append -Encoding utf8
        if (($r.safeMode -or $r.uncleanLaunches.Count -ge 2) -and ($args -notcontains '--recover-normal')) {
            $answer = [System.Windows.MessageBox]::Show("上次沒有正常結束（累計 $($r.uncleanLaunches.Count) 次）。再失敗一次可能進入安全模式。`n`n仍要啟動嗎？", 'RainyDays', 'YesNo', 'Warning')
            if ($answer -ne 'Yes') { exit 0 }
        }
    }

    # 3. 建置是否為最新；不是才重新編譯
    & node scripts/generate-build-info.mjs --check *>> $log
    $buildCurrent = ($LASTEXITCODE -eq 0) -and (Test-Path 'dist\index.js')
    if ($buildCurrent) {
        & node scripts/build-sec03-native.mjs --check *>> $log
        $buildCurrent = ($LASTEXITCODE -eq 0)
    }
    if (-not $buildCurrent) {
        'build stale -> npm run build' | Out-File -LiteralPath $log -Append -Encoding utf8
        $ErrorActionPreference = 'Continue'
        & npm.cmd run build *>> $log
        $ErrorActionPreference = 'Stop'
        if ($LASTEXITCODE -ne 0) { Fail '重新編譯失敗。' }
    }

    # 4. 啟動
    'starting electron' | Out-File -LiteralPath $log -Append -Encoding utf8
    $ErrorActionPreference = 'Continue'
    & npm.cmd exec --offline -- electron . @args *>> $log
    "electron exited $LASTEXITCODE" | Out-File -LiteralPath $log -Append -Encoding utf8
} catch {
    Fail $_.Exception.Message
} finally {
    Pop-Location -ErrorAction SilentlyContinue
}
