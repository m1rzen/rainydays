[CmdletBinding()]
param(
  [ValidateSet("Create", "Mount", "Remove")]
  [string]$Action = "Create",
  [string]$FixtureDirectory = ""
)

if (-not $FixtureDirectory) { $FixtureDirectory = Join-Path $PSScriptRoot "..\test-results\sec03-storage-fixtures" }

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "SEC-03 storage fixtures require an elevated PowerShell session"
  }
}

function Assert-SafeFixtureDirectory([string]$Path) {
  $resolved = [IO.Path]::GetFullPath($Path)
  if (-not [IO.Path]::IsPathRooted($resolved)) { throw "Fixture directory must be absolute" }
  $projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
  $expectedParent = [IO.Path]::GetFullPath((Join-Path $projectRoot "test-results"))
  if (-not $resolved.StartsWith($expectedParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Fixture directory must remain below the project test-results directory"
  }
  New-Item -ItemType Directory -Path $resolved -Force | Out-Null
  $item = Get-Item -LiteralPath $resolved -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Fixture directory cannot be a reparse point" }
  return $item.FullName
}

function Invoke-DiskPartExact([string[]]$Commands, [string]$Directory) {
  $scriptPath = Join-Path $Directory ("diskpart-" + [Guid]::NewGuid().ToString("N") + ".txt")
  try {
    [IO.File]::WriteAllLines($scriptPath, $Commands, [Text.UTF8Encoding]::new($false))
    $output = & "$env:SystemRoot\System32\diskpart.exe" /s $scriptPath 2>&1
    if ($LASTEXITCODE -ne 0) { throw "diskpart failed: $($output -join [Environment]::NewLine)" }
    return ($output -join [Environment]::NewLine)
  } finally {
    Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
  }
}

function Dismount-ExactImage([string]$ImagePath, [string]$Directory) {
  if (-not (Test-Path -LiteralPath $ImagePath -PathType Leaf)) { return }
  $image = Get-DiskImage -ImagePath $ImagePath
  if (-not $image.Attached) { return }
  Invoke-DiskPartExact @(
    "select vdisk file=`"$ImagePath`"",
    "detach vdisk",
    "exit"
  ) $Directory | Out-Null
}

function Read-State([string]$StatePath, [string]$Directory) {
  if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { throw "SEC-03 storage fixture state is missing" }
  $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
  $keys = @($state.PSObject.Properties.Name | Sort-Object)
  if (($keys -join ",") -ne "exfatImage,exfatLetter,ntfsImage,ntfsLetter,schemaVersion") { throw "SEC-03 storage fixture state keys differ" }
  if ($state.schemaVersion -ne 1) { throw "SEC-03 storage fixture state version differs" }
  foreach ($image in @([string]$state.ntfsImage, [string]$state.exfatImage)) {
    $full = [IO.Path]::GetFullPath($image)
    if (-not $full.StartsWith($Directory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Fixture image escaped its directory" }
    if ([IO.Path]::GetExtension($full) -ne ".vhdx") { throw "Fixture image extension differs" }
  }
  foreach ($letter in @([string]$state.ntfsLetter, [string]$state.exfatLetter)) {
    if ($letter -notmatch "^[S-Y]$") { throw "Fixture drive letter is invalid" }
  }
  return $state
}

Assert-Elevated
$directory = Assert-SafeFixtureDirectory $FixtureDirectory
$statePath = Join-Path $directory "state.json"

if ($Action -eq "Mount") {
  $state = Read-State $statePath $directory
  foreach ($image in @([string]$state.ntfsImage, [string]$state.exfatImage)) {
    if (-not (Test-Path -LiteralPath $image -PathType Leaf)) { throw "SEC-03 storage fixture image is missing: $image" }
    if ((Get-DiskImage -ImagePath $image).Attached) { throw "SEC-03 storage fixture image is already attached: $image" }
  }
  $usedLetters = @(Get-Volume | Where-Object DriveLetter | ForEach-Object { [string]$_.DriveLetter })
  foreach ($letter in @([string]$state.ntfsLetter, [string]$state.exfatLetter)) {
    if ($usedLetters -contains $letter) { throw "SEC-03 storage fixture drive letter is already in use: $letter" }
  }
  $mounted = $false
  try {
    foreach ($fixture in @(
      [ordered]@{ image = [string]$state.ntfsImage; letter = [string]$state.ntfsLetter },
      [ordered]@{ image = [string]$state.exfatImage; letter = [string]$state.exfatLetter }
    )) {
      $disk = Mount-DiskImage -ImagePath $fixture.image -NoDriveLetter -PassThru | Get-Disk
      if ($null -eq $disk) { throw "Mounted fixture disk is unavailable: $($fixture.image)" }
      $partitions = @($disk | Get-Partition | Where-Object Type -eq "Basic")
      if ($partitions.Count -ne 1) { throw "Mounted fixture must contain exactly one Basic partition: $($fixture.image)" }
      Add-PartitionAccessPath -DiskNumber $disk.Number -PartitionNumber $partitions[0].PartitionNumber -AccessPath "$($fixture.letter):\"
    }
    $ntfsVolume = Get-Volume -DriveLetter ([string]$state.ntfsLetter)
    $exfatVolume = Get-Volume -DriveLetter ([string]$state.exfatLetter)
    if ($ntfsVolume.DriveType -ne "Fixed" -or $ntfsVolume.FileSystemType -ne "NTFS") { throw "A16 mounted fixture is not Fixed NTFS" }
    if ($exfatVolume.DriveType -ne "Fixed" -or $exfatVolume.FileSystemType -eq "NTFS") { throw "A18 mounted fixture is not Fixed non-NTFS" }
    $ntfsRoot = "$([string]$state.ntfsLetter):\sec03-a16-root"
    $exfatRoot = "$([string]$state.exfatLetter):\sec03-a18-root"
    foreach ($root in @($ntfsRoot, $exfatRoot)) {
      $item = Get-Item -LiteralPath $root -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Mounted fixture root is invalid: $root" }
    }
    $mounted = $true
    [ordered]@{
      mounted = $true
      a16FixedNtfsRoot = $ntfsRoot
      a18NonNtfsRoot = $exfatRoot
      environment = [ordered]@{
        MINI_LUX_SEC03_A16_FIXED_NTFS_ROOT = $ntfsRoot
        MINI_LUX_SEC03_A18_NON_NTFS_ROOT = $exfatRoot
      }
    } | ConvertTo-Json -Depth 4 -Compress
  } finally {
    if (-not $mounted) {
      Dismount-ExactImage ([string]$state.ntfsImage) $directory
      Dismount-ExactImage ([string]$state.exfatImage) $directory
    }
  }
  exit 0
}

if ($Action -eq "Remove") {
  $state = Read-State $statePath $directory
  Dismount-ExactImage ([string]$state.ntfsImage) $directory
  Dismount-ExactImage ([string]$state.exfatImage) $directory
  foreach ($image in @([string]$state.ntfsImage, [string]$state.exfatImage)) {
    Remove-Item -LiteralPath $image -Force -ErrorAction Stop
  }
  Remove-Item -LiteralPath $statePath -Force
  [ordered]@{ removed = $true; directory = $directory } | ConvertTo-Json -Compress
  exit 0
}

if (Test-Path -LiteralPath $statePath) { throw "SEC-03 storage fixtures already exist; remove them first" }
$ntfsImage = Join-Path $directory "sec03-a16-fixed-ntfs.vhdx"
$exfatImage = Join-Path $directory "sec03-a18-fixed-exfat.vhdx"
if ((Test-Path -LiteralPath $ntfsImage) -or (Test-Path -LiteralPath $exfatImage)) { throw "A fixture image already exists without canonical state" }

$usedLetters = @(Get-Volume | Where-Object DriveLetter | ForEach-Object { [string]$_.DriveLetter })
$available = @("Y", "X", "W", "V", "U", "T", "S") | Where-Object { $usedLetters -notcontains $_ }
if ($available.Count -lt 2) { throw "Two unused fixture drive letters in S-Y are required" }
$ntfsLetter = $available[0]
$exfatLetter = $available[1]
$created = $false
try {
  Invoke-DiskPartExact @(
    "create vdisk file=`"$ntfsImage`" maximum=256 type=expandable",
    "select vdisk file=`"$ntfsImage`"",
    "attach vdisk",
    "convert gpt",
    "create partition primary",
    "format fs=ntfs quick label=SEC03A16",
    "assign letter=$ntfsLetter",
    "create vdisk file=`"$exfatImage`" maximum=256 type=expandable",
    "select vdisk file=`"$exfatImage`"",
    "attach vdisk",
    "convert gpt",
    "create partition primary",
    "format fs=exfat quick label=SEC03A18",
    "assign letter=$exfatLetter",
    "exit"
  ) $directory | Out-Null

  $ntfsVolume = Get-Volume -DriveLetter $ntfsLetter
  $exfatVolume = Get-Volume -DriveLetter $exfatLetter
  if ($ntfsVolume.DriveType -ne "Fixed" -or $ntfsVolume.FileSystemType -ne "NTFS") { throw "A16 fixture is not Fixed NTFS" }
  if ($exfatVolume.DriveType -ne "Fixed" -or $exfatVolume.FileSystemType -eq "NTFS") { throw "A18 fixture is not Fixed non-NTFS" }

  $ntfsRoot = "$ntfsLetter`:\sec03-a16-root"
  $exfatRoot = "$exfatLetter`:\sec03-a18-root"
  New-Item -ItemType Directory -Path $ntfsRoot | Out-Null
  New-Item -ItemType Directory -Path $exfatRoot | Out-Null

  $state = [ordered]@{
    schemaVersion = 1
    ntfsImage = $ntfsImage
    ntfsLetter = $ntfsLetter
    exfatImage = $exfatImage
    exfatLetter = $exfatLetter
  }
  [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  $created = $true
  [ordered]@{
    created = $true
    a16FixedNtfsRoot = $ntfsRoot
    a18NonNtfsRoot = $exfatRoot
    environment = [ordered]@{
      MINI_LUX_SEC03_A16_FIXED_NTFS_ROOT = $ntfsRoot
      MINI_LUX_SEC03_A18_NON_NTFS_ROOT = $exfatRoot
    }
  } | ConvertTo-Json -Depth 4 -Compress
} finally {
  if (-not $created) {
    Dismount-ExactImage $ntfsImage $directory
    Dismount-ExactImage $exfatImage $directory
    Remove-Item -LiteralPath $ntfsImage -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $exfatImage -Force -ErrorAction SilentlyContinue
  }
}
