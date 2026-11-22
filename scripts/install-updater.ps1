# One-time setup on the laptop (Windows): lets the Sensei extension update itself with its
# "Update now" button. No admin rights needed; everything goes into your user profile.
#
# Run in PowerShell:
#   iwr http://barkhausstr64:8000/downloads/install-updater.ps1 -OutFile $env:TEMP\i.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\i.ps1
#
# What it does:
#   1. Finds the folder Edge (or Chrome) loads the unpacked Sensei extension from, by reading the
#      browser's own preferences. Pass -Folder to choose it yourself.
#   2. Copies the small updater (sensei-updater.ps1 + .cmd) to %LOCALAPPDATA%\SenseiUpdater with
#      config.json (server URL + that folder).
#   3. Registers it as a "native messaging host" for Edge and Chrome (HKCU registry), allowed for the
#      Sensei extension only (its fixed ID).
#   4. If the folder doesn't hold the extension yet, downloads and unpacks it there (fresh install).
# Run it again any time; it just refreshes everything. Remove with -Uninstall.
param(
  [string]$Server = "http://barkhausstr64:8000",
  [string]$Folder = "",
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false  # Chromium rejects host manifests with a BOM

# Fixed ID of the Sensei extension, derived from the manifest key in extension/wxt.config.ts
# (server/tests/test_updater_scripts.py checks that they match).
$ExtensionId = "libcomhkhhmgijjgjfeelaeghehakdnh"
$HostName = "com.sensei.updater"
$InstallDir = Join-Path $env:LOCALAPPDATA "SenseiUpdater"
$RegistryKeys = @(
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
)

if ($Uninstall) {
  foreach ($k in $RegistryKeys) { if (Test-Path $k) { Remove-Item $k -Force } }
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  Write-Host "Sensei updater removed. The extension folder itself was not touched."
  return
}

function Get-ExtensionKey([string]$Dir) {
  $m = Join-Path $Dir "manifest.json"
  if (-not (Test-Path -LiteralPath $m)) { return $null }
  try { return (Get-Content -LiteralPath $m -Raw -Encoding UTF8 | ConvertFrom-Json).key } catch { return $null }
}

function Find-ExtensionFolder {
  # Unpacked extensions are listed in each browser profile's (Secure) Preferences file as
  # "extensions":{"settings":{"<id>":{..., "path":"C:\\..."}}}. A regex is enough here, and every
  # hit is checked against the extension's manifest key before it's used.
  $roots = @(
    (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\User Data"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data")
  )
  $pattern = '"' + $ExtensionId + '":\{.*?"path":"((?:[^"\\]|\\.)*)"'
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $files = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName "Secure Preferences"; Join-Path $_.FullName "Preferences" } |
      Where-Object { Test-Path -LiteralPath $_ }
    foreach ($f in $files) {
      $text = Get-Content -LiteralPath $f -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
      if (-not $text) { continue }
      $m = [regex]::Match($text, $pattern, [Text.RegularExpressions.RegexOptions]::Singleline)
      if ($m.Success) {
        $path = $null
        try { $path = ('"' + $m.Groups[1].Value + '"') | ConvertFrom-Json } catch { }
        if ($path -and (Test-Path -LiteralPath $path) -and (Get-ExtensionKey $path)) { return $path }
      }
    }
  }
  return $null
}

$Server = $Server.TrimEnd("/")
try { $latest = Invoke-RestMethod "$Server/downloads/version.json" -UseBasicParsing -TimeoutSec 20 }
catch { throw "Can't reach the Sensei server at $Server ($($_.Exception.Message)). Is Tailscale connected?" }

if (-not $Folder) {
  $Folder = Find-ExtensionFolder
  if ($Folder) { Write-Host "Found the Sensei extension in: $Folder" }
}
if (-not $Folder) {
  $default = Join-Path $HOME "Documents\sensei-extension"
  $answer = Read-Host "Folder for the Sensei extension (Enter = $default)"
  $Folder = $(if ($answer) { $answer.Trim('"') } else { $default })
}
$Folder = [IO.Path]::GetFullPath($Folder)

# 1. The updater itself.
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
foreach ($f in @("sensei-updater.ps1", "sensei-updater.cmd")) {
  Invoke-WebRequest "$Server/downloads/updater/$f" -OutFile (Join-Path $InstallDir $f) -UseBasicParsing -TimeoutSec 30
}
[IO.File]::WriteAllText((Join-Path $InstallDir "config.json"), (@{ server = $Server; folder = $Folder } | ConvertTo-Json), $Utf8NoBom)

# 2. Native messaging host manifest + registry (Edge and Chrome).
$hostManifest = Join-Path $InstallDir "$HostName.json"
$manifestObject = @{
  name = $HostName
  description = "Sensei extension updater"
  path = (Join-Path $InstallDir "sensei-updater.cmd")
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
[IO.File]::WriteAllText($hostManifest, ($manifestObject | ConvertTo-Json), $Utf8NoBom)
foreach ($k in $RegistryKeys) {
  New-Item -Path $k -Force | Out-Null
  Set-Item -Path $k -Value $hostManifest
}

# 3. Fresh install if the folder doesn't hold the extension yet.
$fresh = -not (Get-ExtensionKey $Folder)
if ($fresh) {
  if ((Test-Path -LiteralPath $Folder) -and (Get-ChildItem -LiteralPath $Folder -Force | Select-Object -First 1)) {
    throw "$Folder isn't empty and doesn't hold the Sensei extension. Pick an empty folder with -Folder."
  }
  New-Item -ItemType Directory -Force -Path $Folder | Out-Null
  $zip = Join-Path $env:TEMP "sensei-extension-chrome.zip"
  Invoke-WebRequest "$Server/downloads/sensei-extension-chrome.zip" -OutFile $zip -UseBasicParsing -TimeoutSec 120
  Expand-Archive -LiteralPath $zip -DestinationPath $Folder -Force
}

Write-Host ""
Write-Host "Sensei updater installed." -ForegroundColor Green
Write-Host "  Extension folder: $Folder"
Write-Host "  Latest build on the server: $($latest.version) ($($latest.extension_commit))"
if ($fresh) {
  Write-Host ""
  Write-Host "Last manual step: in edge://extensions turn on Developer mode, click 'Load unpacked'"
  Write-Host "and pick the folder above. If an older Sensei card is there, remove it first."
} else {
  Write-Host "From now on, click 'Update now' in the Sensei popup when it says an update is available."
}
