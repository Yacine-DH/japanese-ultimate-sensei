# Sensei updater: native messaging host for the Sensei browser extension (Windows).
#
# Edge/Chrome start this script when the extension's "Update now" button sends a message to
# "com.sensei.updater". It downloads the newest extension build from the home server, checks it,
# and unpacks it over the folder Edge loads the unpacked extension from. The extension then
# reloads itself. Installed by install-updater.ps1 into %LOCALAPPDATA%\SenseiUpdater, next to
# config.json ({ "server": "...", "folder": "..." }), written at install time.
#
# Protocol (Chrome native messaging): every message is a 4-byte little-endian length + UTF-8 JSON
# on stdin/stdout. Nothing else may be written to stdout, so this script never uses Write-Host or
# Write-Output; diagnostics go to updater.log next to it.
#
# Requests:  {"action":"status"}  -> {ok, host_version, folder, installed, latest}
#            {"action":"update"}  -> {ok, version, commit, files}
# The server URL and the folder come from config.json only, never from the message.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$HostVersion = 1
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogFile = Join-Path $Dir 'updater.log'

function Write-Log([string]$Text) {
  try { Add-Content -Path $LogFile -Value ("{0:u} {1}" -f (Get-Date), $Text) } catch { }
}

$StdIn = [Console]::OpenStandardInput()
$StdOut = [Console]::OpenStandardOutput()

function Read-Exact([int]$Count) {
  $buf = New-Object byte[] $Count
  $got = 0
  while ($got -lt $Count) {
    $n = $StdIn.Read($buf, $got, $Count - $got)
    if ($n -le 0) { return $null }
    $got += $n
  }
  return ,$buf
}

function Read-Message {
  $len = Read-Exact 4
  if ($null -eq $len) { return $null }
  $size = [BitConverter]::ToInt32($len, 0)
  if ($size -le 0 -or $size -gt 65536) { return $null }
  $body = Read-Exact $size
  if ($null -eq $body) { return $null }
  return ([Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json)
}

function Send-Message($Object) {
  $json = $Object | ConvertTo-Json -Compress -Depth 6
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $StdOut.Write([BitConverter]::GetBytes([int32]$bytes.Length), 0, 4)
  $StdOut.Write($bytes, 0, $bytes.Length)
  $StdOut.Flush()
}

function Get-ManifestInfo([string]$Folder) {
  $path = Join-Path $Folder 'manifest.json'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $m = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
  return @{ version = $m.version; key = $m.key; name = $m.name }
}

function Get-Latest($Config) {
  $url = $Config.server.TrimEnd('/') + '/downloads/version.json'
  return Invoke-RestMethod -Uri $url -UseBasicParsing -TimeoutSec 20
}

function Invoke-Status($Config) {
  $latest = $null
  $latestError = $null
  try { $latest = Get-Latest $Config } catch { $latestError = $_.Exception.Message }
  $installed = Get-ManifestInfo $Config.folder
  return @{
    ok = $true; host_version = $HostVersion; folder = $Config.folder; server = $Config.server
    installed = $(if ($installed) { @{ version = $installed.version } } else { $null })
    latest = $latest; latest_error = $latestError
  }
}

function Invoke-Update($Config) {
  $folder = $Config.folder
  $installed = Get-ManifestInfo $folder
  $latest = Get-Latest $Config
  $temp = Join-Path ([IO.Path]::GetTempPath()) ('sensei-update-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temp | Out-Null
  try {
    $zip = Join-Path $temp 'sensei-extension-chrome.zip'
    $zipUrl = $Config.server.TrimEnd('/') + '/downloads/sensei-extension-chrome.zip'
    Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing -TimeoutSec 120 | Out-Null
    if ($latest.sha256_chrome) {
      $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($hash -ne $latest.sha256_chrome.ToLowerInvariant()) {
        throw "Download check failed (sha256 mismatch). Try again in a minute; the server may be deploying."
      }
    }
    $unpacked = Join-Path $temp 'unpacked'
    Expand-Archive -LiteralPath $zip -DestinationPath $unpacked -Force
    $new = Get-ManifestInfo $unpacked
    if (-not $new) { throw 'The download has no manifest.json.' }
    # Only ever write over a folder that holds this same extension (same key), or an empty one.
    if ($installed -and $installed.key -and $new.key -and ($installed.key -ne $new.key)) {
      throw "The folder $folder holds a different extension; not touching it."
    }
    if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder | Out-Null }
    $newFiles = @{}
    Get-ChildItem -LiteralPath $unpacked -Recurse -File | ForEach-Object {
      $rel = $_.FullName.Substring($unpacked.Length).TrimStart('\', '/')
      $newFiles[$rel.ToLowerInvariant()] = $true
      $dest = Join-Path $folder $rel
      $destDir = Split-Path -Parent $dest
      if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir | Out-Null }
      Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    }
    # Remove files from older builds (hashed chunk names change), but only in a folder we
    # verified above to be this extension.
    $removed = 0
    if ($installed) {
      Get-ChildItem -LiteralPath $folder -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($folder.TrimEnd('\', '/').Length).TrimStart('\', '/')
        if (-not $newFiles.ContainsKey($rel.ToLowerInvariant())) {
          Remove-Item -LiteralPath $_.FullName -Force
          $removed++
        }
      }
    }
    Write-Log ("updated {0} -> {1} ({2}), {3} files, {4} removed" -f `
      $(if ($installed) { $installed.version } else { 'none' }), $new.version, $latest.extension_commit, $newFiles.Count, $removed)
    return @{ ok = $true; version = $new.version; commit = $latest.extension_commit; files = $newFiles.Count; removed = $removed }
  }
  finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

try {
  $config = Get-Content -LiteralPath (Join-Path $Dir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $msg = Read-Message
  if ($null -eq $msg) { exit 0 }
  switch ($msg.action) {
    'status' { Send-Message (Invoke-Status $config) }
    'update' { Send-Message (Invoke-Update $config) }
    default { Send-Message @{ ok = $false; error = "Unknown action '$($msg.action)'." } }
  }
}
catch {
  Write-Log ("error: " + $_.Exception.Message)
  try { Send-Message @{ ok = $false; error = $_.Exception.Message } } catch { }
}
