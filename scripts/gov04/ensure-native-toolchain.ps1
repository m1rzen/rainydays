$ErrorActionPreference = 'Stop'

if (-not [Environment]::Is64BitOperatingSystem) { throw 'SEC-03 native toolchain requires Windows x64' }

$programFilesX86 = ${env:ProgramFiles(x86)}
if ([string]::IsNullOrWhiteSpace($programFilesX86)) { $programFilesX86 = 'C:\Program Files (x86)' }
$vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw 'vswhere.exe is unavailable' }

$instances = @(
  & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
)
if ($LASTEXITCODE -ne 0 -or $instances.Count -ne 1) { throw "Expected exactly one eligible Visual Studio instance, found $($instances.Count)" }

$installationPath = $instances[0]
$msvcVersion = '14.43.34808'
$compilerVersion = '19.43.34808.0'
$component = 'Microsoft.VisualStudio.Component.VC.14.43.17.13.x86.x64'
$cl = Join-Path $installationPath "VC\Tools\MSVC\$msvcVersion\bin\Hostx64\x64\cl.exe"
$installed = Test-Path -LiteralPath $cl -PathType Leaf

if (-not $installed) {
  $setup = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\setup.exe'
  if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw 'Visual Studio Installer setup.exe is unavailable' }
  $arguments = @(
    'modify',
    '--installPath', "`"$installationPath`"",
    '--add', $component,
    '--quiet',
    '--norestart'
  )
  $process = Start-Process -FilePath $setup -ArgumentList $arguments -Wait -PassThru -NoNewWindow
  if ($process.ExitCode -notin @(0, 3010)) { throw "Visual Studio Installer failed with exit code $($process.ExitCode)" }
}

if (-not (Test-Path -LiteralPath $cl -PathType Leaf)) { throw "Pinned MSVC compiler is unavailable after installation: $cl" }
$probe = [System.Diagnostics.Process]::new()
$probe.StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
$probe.StartInfo.FileName = $cl
$probe.StartInfo.Arguments = '/Bv'
$probe.StartInfo.UseShellExecute = $false
$probe.StartInfo.CreateNoWindow = $true
$probe.StartInfo.RedirectStandardOutput = $true
$probe.StartInfo.RedirectStandardError = $true
if (-not $probe.Start()) { throw 'Pinned MSVC compiler version probe did not start' }
$versionText = $probe.StandardOutput.ReadToEnd() + $probe.StandardError.ReadToEnd()
$probe.WaitForExit()
if ($versionText -notmatch [regex]::Escape($compilerVersion)) { throw "Pinned MSVC compiler version differs: expected $compilerVersion" }

$sdkHeader = Join-Path $programFilesX86 'Windows Kits\10\Include\10.0.22621.0\um\Windows.h'
$sdkLibrary = Join-Path $programFilesX86 'Windows Kits\10\Lib\10.0.22621.0\um\x64\kernel32.lib'
if (-not (Test-Path -LiteralPath $sdkHeader -PathType Leaf) -or -not (Test-Path -LiteralPath $sdkLibrary -PathType Leaf)) {
  throw 'Pinned Windows SDK 10.0.22621.0 is unavailable'
}

$state = if ($installed) { 'reused' } else { 'installed' }
Write-Output "SEC-03 native toolchain ${state}: MSVC $msvcVersion, SDK 10.0.22621.0"
