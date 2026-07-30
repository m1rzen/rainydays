$ErrorActionPreference = 'Stop'

if (-not [Environment]::Is64BitOperatingSystem) { throw 'SEC-03 native toolchain requires Windows x64' }

$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$programFilesX86 = ${env:ProgramFiles(x86)}
if ([string]::IsNullOrWhiteSpace($programFilesX86)) { $programFilesX86 = 'C:\Program Files (x86)' }
$vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw 'vswhere.exe is unavailable' }

$installationVersion = '17.13.35825.156'
$allowedProductIds = @(
  'Microsoft.VisualStudio.Product.BuildTools',
  'Microsoft.VisualStudio.Product.Community'
)
$msvcVersion = '14.43.34808'
$compilerVersion = '19.43.34808.0'
$component = 'Microsoft.VisualStudio.Component.VC.14.43.17.13.x86.x64'
$bootstrapperUrl = 'https://download.visualstudio.microsoft.com/download/pr/84955a63-15ca-4f52-94af-14ea55b50424/e26a4f237c908739caa2ac36e2d90a51d7e3f71746e615207b7db449f82e3c4e/vs_BuildTools.exe'
$bootstrapperSha256 = 'e26a4f237c908739caa2ac36e2d90a51d7e3f71746e615207b7db449f82e3c4e'

function Invoke-CompilerProbe {
  param([Parameter(Mandatory = $true)][string]$CompilerPath)
  $probeId = [Guid]::NewGuid().ToString('N')
  $sourcePath = Join-Path ([System.IO.Path]::GetTempPath()) "rainydays-cl-probe-$probeId.cpp"
  $objectPath = Join-Path ([System.IO.Path]::GetTempPath()) "rainydays-cl-probe-$probeId.obj"
  [System.IO.File]::WriteAllText($sourcePath, 'int rainydays_toolchain_probe;', [System.Text.Encoding]::ASCII)
  $probe = [System.Diagnostics.Process]::new()
  try {
    $probe.StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $probe.StartInfo.FileName = $CompilerPath
    $probe.StartInfo.UseShellExecute = $false
    $probe.StartInfo.CreateNoWindow = $true
    $probe.StartInfo.RedirectStandardOutput = $true
    $probe.StartInfo.RedirectStandardError = $true
    $probe.StartInfo.Arguments = "/nologo /Bv /c `"$sourcePath`" /Fo`"$objectPath`""
    if (-not $probe.Start()) { throw 'Pinned MSVC compiler version probe did not start' }
    $text = $probe.StandardOutput.ReadToEnd() + $probe.StandardError.ReadToEnd()
    $probe.WaitForExit()
    return [PSCustomObject]@{ ExitCode = $probe.ExitCode; Text = $text }
  } finally {
    $probe.Dispose()
    Remove-Item -LiteralPath $sourcePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $objectPath -Force -ErrorAction SilentlyContinue
  }
}

function Get-Vs17Instances {
  $json = (& $vswhere -products * -version '[17.0,18.0)' -format json -utf8 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw 'vswhere failed while locating Visual Studio 2022' }
  if ([string]::IsNullOrWhiteSpace($json)) { return }
  foreach ($instance in @($json | ConvertFrom-Json)) { Write-Output $instance }
}

function Assert-PinnedVsInstance {
  param([Parameter(Mandatory = $true)]$Instance)
  if ($allowedProductIds -notcontains $Instance.productId) { throw "Unexpected Visual Studio 2022 product: $($Instance.productId)" }
  if ($Instance.installationVersion -ne $installationVersion) { throw "Unexpected Visual Studio 2022 version: $($Instance.installationVersion)" }
  $compilerPath = Join-Path $Instance.installationPath "VC\Tools\MSVC\$msvcVersion\bin\Hostx64\x64\cl.exe"
  if (-not (Test-Path -LiteralPath $compilerPath -PathType Leaf)) { throw "Pinned MSVC compiler is unavailable: $compilerPath" }
  $probe = Invoke-CompilerProbe -CompilerPath $compilerPath
  if ($probe.ExitCode -ne 0) { throw "Pinned MSVC compiler probe failed with exit code $($probe.ExitCode)" }
  if ($probe.Text -notmatch "(?im)^.*\\cl\.exe:[^\r\n]*$([regex]::Escape($compilerVersion))\s*$") {
    throw "Pinned MSVC compiler version differs: expected $compilerVersion"
  }
  return [PSCustomObject]@{ InstallationPath = $Instance.installationPath; CompilerPath = $compilerPath; ProductId = $Instance.productId }
}

function Write-BoundedInstallerDiagnostics {
  $patterns = @('dd_bootstrapper*.log', 'dd_setup*.log', 'dd_client*.log')
  $logs = @(
    foreach ($pattern in $patterns) {
      Get-ChildItem -Path ([System.IO.Path]::GetTempPath()) -Filter $pattern -File -ErrorAction SilentlyContinue
    }
  ) | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 3
  foreach ($log in $logs) {
    Write-Output "--- Visual Studio installer diagnostic: $($log.Name) ---"
    Get-Content -LiteralPath $log.FullName -Tail 80 -ErrorAction SilentlyContinue
  }
}

$instances = @(Get-Vs17Instances)
if ($instances.Count -gt 1) { throw "Expected at most one Visual Studio 2022 instance, found $($instances.Count)" }
$installed = $instances.Count -eq 1
if ($installed) { $pinnedInstance = Assert-PinnedVsInstance -Instance $instances[0] }

if (-not $installed) {
  $temporaryRoot = if (-not [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
  $bootstrapper = Join-Path $temporaryRoot 'rainydays-vs-buildtools-17.13.2.exe'
  if (Test-Path -LiteralPath $bootstrapper) { Remove-Item -LiteralPath $bootstrapper -Force }
  Invoke-WebRequest -UseBasicParsing -Uri $bootstrapperUrl -OutFile $bootstrapper
  $downloadedHash = (Get-FileHash -LiteralPath $bootstrapper -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($downloadedHash -ne $bootstrapperSha256) { throw 'Visual Studio 2022 17.13.2 bootstrapper checksum mismatch' }
  $downloadedVersion = (Get-Item -LiteralPath $bootstrapper).VersionInfo.FileVersion
  if ($downloadedVersion -ne $installationVersion) { throw 'Visual Studio 2022 17.13.2 bootstrapper file version mismatch' }

  $installationPath = Join-Path $env:SystemDrive 'RainyDaysToolchain\VS2022BuildTools-17.13.2'
  $arguments = @(
    'install',
    '--installPath', "`"$installationPath`"",
    '--add', $component,
    '--quiet',
    '--wait',
    '--norestart',
    '--nocache'
  )
  $process = Start-Process -FilePath $bootstrapper -ArgumentList $arguments -Wait -PassThru -NoNewWindow
  if ($process.ExitCode -notin @(0, 3010)) {
    Write-BoundedInstallerDiagnostics
    throw "Visual Studio 2022 17.13.2 installation failed with exit code $($process.ExitCode)"
  }

  $installationDeadline = [DateTime]::UtcNow.AddMinutes(10)
  do {
    $instances = @(Get-Vs17Instances)
    if ($instances.Count -gt 1) { throw "Expected at most one Visual Studio 2022 instance after installation, found $($instances.Count)" }
    if ($instances.Count -eq 1) { break }
    if ([DateTime]::UtcNow -ge $installationDeadline) {
      Write-BoundedInstallerDiagnostics
      throw 'Visual Studio 2022 17.13.2 installation did not become ready before the deadline'
    }
    Start-Sleep -Seconds 10
  } while ($true)
  $pinnedInstance = Assert-PinnedVsInstance -Instance $instances[0]
}

$sdkHeader = Join-Path $programFilesX86 'Windows Kits\10\Include\10.0.22621.0\um\Windows.h'
$sdkLibrary = Join-Path $programFilesX86 'Windows Kits\10\Lib\10.0.22621.0\um\x64\kernel32.lib'
if (-not (Test-Path -LiteralPath $sdkHeader -PathType Leaf) -or -not (Test-Path -LiteralPath $sdkLibrary -PathType Leaf)) {
  throw 'Pinned Windows SDK 10.0.22621.0 is unavailable'
}

$electronBootstrap = Join-Path $projectRoot 'scripts\gov04\bootstrap-electron-headers.mjs'
if (-not (Test-Path -LiteralPath $electronBootstrap -PathType Leaf)) { throw 'Pinned Electron header bootstrap is unavailable' }
& node $electronBootstrap
if ($LASTEXITCODE -ne 0) { throw "Pinned Electron header bootstrap failed with exit code $LASTEXITCODE" }

$state = if ($installed) { 'reused' } else { 'installed' }
Write-Output "SEC-03 native toolchain ${state}: $($pinnedInstance.ProductId), MSVC $msvcVersion, SDK 10.0.22621.0, Electron 43.1.1"
