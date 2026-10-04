import { LAUNCHER_CHECKSUMS_URL, RELEASE_ASSETS } from "@/lib/downloads";

/**
 * `irm https://stella.sh/install.ps1 | iex`
 *
 * Downloads the signed Windows launcher, checks it against the published
 * SHA256SUMS, and puts it where the launcher installs itself
 * (%LOCALAPPDATA%\Programs\Stella\Stella.exe, so its own first-run copy is a
 * no-op), then starts it. The launcher does the rest of the install and adds
 * the Start Menu shortcut.
 */
const SCRIPT = `#Requires -Version 5
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$url = '${RELEASE_ASSETS.windows}'
$sumsUrl = '${LAUNCHER_CHECKSUMS_URL}'
$dir = Join-Path $env:LOCALAPPDATA 'Programs\\Stella'
$dest = Join-Path $dir 'Stella.exe'
$staged = "$dest.download"

New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Host 'Downloading Stella for Windows...'
Invoke-WebRequest -Uri $url -OutFile $staged -UseBasicParsing

$sumsFile = "$dest.sha256sums"
Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsFile -UseBasicParsing
$line = Get-Content -Path $sumsFile | Where-Object { $_ -match '[\\s*]Stella\\.exe\\s*$' } | Select-Object -First 1
Remove-Item -Force $sumsFile
if (-not $line) { Remove-Item -Force $staged; throw 'Stella.exe is missing from SHA256SUMS.' }
$expected = ($line -split '\\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 -Path $staged).Hash.ToLowerInvariant()
if ($actual -ne $expected) { Remove-Item -Force $staged; throw 'Stella.exe failed its checksum; try again.' }

try {
  Move-Item -Force -Path $staged -Destination $dest
} catch {
  Remove-Item -Force $staged
  throw "Could not replace $dest. Quit Stella if it is running and try again."
}

Write-Host 'Starting Stella...'
Start-Process -FilePath $dest
`;

const HEADERS: HeadersInit = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
};

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(SCRIPT, { status: 200, headers: HEADERS });
}
