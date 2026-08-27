param(
  [Parameter(Mandatory = $true)][string]$AppDirectory,
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$NativeManifestPath,
  [Parameter(Mandatory = $true)][string]$ExpectedThumbprint,
  [Parameter(Mandatory = $true)][string]$ExpectedSerial,
  [Parameter(Mandatory = $true)][string]$ReportPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Normalize-Hex([string]$Value) {
  return ($Value -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
}

function Resolve-SignTool {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    return $command.Source
  }

  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  $candidate = Get-ChildItem $kitsRoot -Filter signtool.exe -Recurse -File |
    Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if ($null -eq $candidate) {
    throw "SignTool was not found on the Windows runner"
  }
  return $candidate.FullName
}

$expectedThumbprint = Normalize-Hex $ExpectedThumbprint
$expectedSerial = Normalize-Hex $ExpectedSerial
$matchingCertificates = @(
  Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { (Normalize-Hex $_.Thumbprint) -eq $expectedThumbprint }
)
if ($matchingCertificates.Count -ne 1) {
  throw "Exactly one expected Windows signing certificate must be available"
}
$expectedCertificate = $matchingCertificates[0]
if ((Normalize-Hex $expectedCertificate.SerialNumber) -ne $expectedSerial) {
  throw "The synchronized signing certificate has the wrong serial number"
}
if ($expectedCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -ne "FromYou, LLC") {
  throw "The synchronized signing certificate has the wrong publisher"
}
if (-not $expectedCertificate.Subject.Contains("O=FromYou, LLC") -and -not $expectedCertificate.Subject.Contains('O="FromYou, LLC"')) {
  throw "The synchronized signing certificate has the wrong organization"
}

$signTool = Resolve-SignTool
$results = [System.Collections.Generic.List[object]]::new()

function Assert-SignedFile([string]$Path, [string]$ArtifactType) {
  $resolved = (Resolve-Path $Path).Path
  $signature = Get-AuthenticodeSignature -LiteralPath $resolved
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "$ArtifactType has an invalid Authenticode signature: $($signature.Status)"
  }
  if ($null -eq $signature.SignerCertificate) {
    throw "$ArtifactType has no signer certificate"
  }
  if ((Normalize-Hex $signature.SignerCertificate.Thumbprint) -ne $expectedThumbprint) {
    throw "$ArtifactType was signed with the wrong certificate"
  }
  if ((Normalize-Hex $signature.SignerCertificate.SerialNumber) -ne $expectedSerial) {
    throw "$ArtifactType was signed with the wrong certificate serial number"
  }
  if ([Convert]::ToBase64String($signature.SignerCertificate.SubjectName.RawData) -ne [Convert]::ToBase64String($expectedCertificate.SubjectName.RawData)) {
    throw "$ArtifactType was signed with the wrong subject"
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "$ArtifactType has no trusted timestamp"
  }
  if (-not $signature.TimeStamperCertificate.Subject.Contains("DigiCert") -and -not $signature.TimeStamperCertificate.Issuer.Contains("DigiCert")) {
    throw "$ArtifactType has an unexpected timestamp authority"
  }

  $verificationOutput = & $signTool verify /pa /all /v $resolved 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "SignTool verification failed for $ArtifactType"
  }
  if (($verificationOutput -join "`n") -notmatch "(?i)timestamp") {
    throw "SignTool did not confirm a timestamp for $ArtifactType"
  }

  $relativePath = if ($resolved.StartsWith((Resolve-Path $AppDirectory).Path, [System.StringComparison]::OrdinalIgnoreCase)) {
    [System.IO.Path]::GetRelativePath((Resolve-Path $AppDirectory).Path, $resolved)
  } else {
    Split-Path $resolved -Leaf
  }
  $results.Add([ordered]@{
    artifactType = $ArtifactType
    path = $relativePath
    authenticodeStatus = $signature.Status.ToString()
    signer = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    signerSubject = $signature.SignerCertificate.Subject
    timestampPresent = $true
    timestampAuthority = $signature.TimeStamperCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    signToolPolicyVerification = "Valid"
  })
}

$appExecutable = Join-Path $AppDirectory "Stella.exe"
Assert-SignedFile $appExecutable "application-executable"

$nativeRoot = Join-Path $AppDirectory "resources\native\out\win32"
$nativeManifest = Get-Content -Raw $NativeManifestPath | ConvertFrom-Json
$nativeAsset = $nativeManifest.assets.'win-x64'
if ($null -eq $nativeAsset) {
  throw "The native helper manifest has no win-x64 asset"
}
$manifestExecutables = @($nativeAsset.files | Where-Object { $_.path -like "*.exe" })
if ($manifestExecutables.Count -eq 0) {
  throw "The native helper manifest contains no Windows executables"
}
foreach ($entry in $manifestExecutables) {
  Assert-SignedFile (Join-Path $nativeRoot $entry.path) "native-helper"
}
$packagedNativeExecutables = @(Get-ChildItem $nativeRoot -Filter *.exe -Recurse -File)
if ($packagedNativeExecutables.Count -ne $manifestExecutables.Count) {
  throw "The packaged native helper executable set does not match the pinned manifest"
}

$browserRoot = Join-Path $AppDirectory "resources\stella-browser\out\win-x64"
$browserExecutables = @(
  Get-ChildItem $browserRoot -File |
    Where-Object { $_.Name -eq "stella-browser" -or $_.Name -eq "stella-browser.exe" }
)
if ($browserExecutables.Count -ne 1) {
  throw "Exactly one packaged Windows Stella Browser executable is required"
}
Assert-SignedFile $browserExecutables[0].FullName "stella-browser-helper"

$managedRuntimeRoot = Join-Path $AppDirectory "resources\bin"
$managedRuntimeNames = @("bun.exe", "rg.exe", "uv.exe")
$managedRuntimeExecutables = @(Get-ChildItem $managedRuntimeRoot -Filter *.exe -File)
if ($managedRuntimeExecutables.Count -ne $managedRuntimeNames.Count) {
  throw "The packaged managed CLI executable set is unexpected"
}
foreach ($runtimeName in $managedRuntimeNames) {
  Assert-SignedFile (Join-Path $managedRuntimeRoot $runtimeName) "managed-cli-runtime"
}

Assert-SignedFile (Join-Path $AppDirectory "resources\elevate.exe") "nsis-elevation-helper"

Assert-SignedFile $InstallerPath "nsis-installer"

$installDirectory = Join-Path $env:RUNNER_TEMP "StellaSignatureValidation"
if (Test-Path $installDirectory) {
  Remove-Item $installDirectory -Recurse -Force
}
$install = Start-Process -FilePath (Resolve-Path $InstallerPath).Path -ArgumentList @("/S", "/D=$installDirectory") -Wait -PassThru
if ($install.ExitCode -ne 0) {
  throw "Silent NSIS validation install failed with exit code $($install.ExitCode)"
}
$uninstallers = @(Get-ChildItem $installDirectory -Filter "Uninstall*.exe" -Recurse -File)
if ($uninstallers.Count -ne 1) {
  throw "Exactly one generated NSIS uninstaller is required"
}
Assert-SignedFile $uninstallers[0].FullName "nsis-uninstaller"

$report = [ordered]@{
  schemaVersion = 1
  commit = $env:GITHUB_SHA
  verifiedAtUtc = [DateTime]::UtcNow.ToString("o")
  publisher = "FromYou, LLC"
  timestampProtocol = "RFC3161"
  artifacts = $results
}
$reportDirectory = Split-Path $ReportPath -Parent
if ($reportDirectory) {
  New-Item -ItemType Directory -Force $reportDirectory | Out-Null
}
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $ReportPath

$cleanup = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList "/S" -Wait -PassThru
if ($cleanup.ExitCode -ne 0) {
  throw "Silent NSIS validation uninstall failed with exit code $($cleanup.ExitCode)"
}

$results | Format-Table artifactType, path, authenticodeStatus, signer, timestampPresent, signToolPolicyVerification -AutoSize
