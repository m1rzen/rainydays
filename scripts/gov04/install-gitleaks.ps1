param(
  [Parameter(Mandatory = $true)]
  [string]$DestinationDirectory
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$policy = Get-Content -LiteralPath (Join-Path $projectRoot 'parity\policies\gov-04-policy.json') -Raw | ConvertFrom-Json
$scan = $policy.secretScan
if ($scan.tool -ne 'gitleaks' -or $scan.version -ne '8.30.1') { throw 'Unexpected Gitleaks policy identity' }
if (Test-Path -LiteralPath $DestinationDirectory) { throw 'Gitleaks destination already exists' }
New-Item -ItemType Directory -Path $DestinationDirectory | Out-Null
$zipPath = Join-Path $DestinationDirectory 'gitleaks.zip'
$extractPath = Join-Path $DestinationDirectory 'extracted'
Invoke-WebRequest -UseBasicParsing -Uri $scan.windowsX64ZipUrl -OutFile $zipPath
$zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($zipHash -ne $scan.windowsX64ZipSha256) { throw 'Gitleaks archive checksum mismatch' }
Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath
$executable = Join-Path $extractPath 'gitleaks.exe'
$exeInfo = Get-Item -LiteralPath $executable -Force
if ($null -ne $exeInfo.LinkType -or $exeInfo.PSIsContainer -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw 'Gitleaks executable is not a regular file'
}
$exeHash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($exeHash -ne $scan.windowsX64ExecutableSha256) { throw 'Gitleaks executable checksum mismatch' }
$version = (& $executable version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $version -ne $scan.version) { throw 'Gitleaks executable version mismatch' }
Write-Output $executable
