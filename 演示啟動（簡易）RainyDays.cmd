@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo RainyDays demo launcher (no PowerShell)
node scripts\generate-build-info.mjs --check >nul 2>&1
if errorlevel 1 (
  echo Build is stale, rebuilding...
  call npm run build
  if errorlevel 1 (
    echo BUILD FAILED. Press any key.
    pause >nul
    exit /b 1
  )
)
echo Starting RainyDays...
call npm.cmd exec --offline -- electron . %*
