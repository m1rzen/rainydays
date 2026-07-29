param(
  [Parameter(Mandatory = $true)]
  [string]$ArtifactPath
)

$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $ArtifactPath
$result = [ordered]@{
  status = [string]$signature.Status
  signerThumbprint = if ($null -ne $signature.SignerCertificate) { [string]$signature.SignerCertificate.Thumbprint } else { $null }
  signerSubject = if ($null -ne $signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { $null }
  timestampThumbprint = if ($null -ne $signature.TimeStamperCertificate) { [string]$signature.TimeStamperCertificate.Thumbprint } else { $null }
  timestampSubject = if ($null -ne $signature.TimeStamperCertificate) { [string]$signature.TimeStamperCertificate.Subject } else { $null }
}
$result | ConvertTo-Json -Compress
