# Update the Sensei browser extension on the laptop (Windows, Edge/Chrome) from the home server.
#
# Run in PowerShell (no admin needed):
#   powershell -ExecutionPolicy Bypass -File update-extension.ps1
# or with your own paths:
#   powershell -ExecutionPolicy Bypass -File update-extension.ps1 -Server http://barkhausstr64:8000 -Folder "$HOME\Documents\sensei-extension"
#
# It downloads the newest zip and unpacks it OVER the folder Edge loads the extension from.
# Keep using the same folder: Edge then keeps the extension (and its settings: server URL,
# token) and only needs a Reload in edge://extensions (or the popup's Reload button).
param(
  [string]$Server = "http://barkhausstr64:8000",
  [string]$Folder = "$HOME\Documents\sensei-extension"
)
$ErrorActionPreference = "Stop"
$zip = Join-Path $env:TEMP "sensei-extension-chrome.zip"
Write-Host "Downloading $Server/downloads/sensei-extension-chrome.zip ..."
Invoke-WebRequest "$Server/downloads/sensei-extension-chrome.zip" -OutFile $zip
$info = Invoke-RestMethod "$Server/downloads/version.json"
New-Item -ItemType Directory -Force -Path $Folder | Out-Null
Expand-Archive -Path $zip -DestinationPath $Folder -Force
Remove-Item $zip
Write-Host "Updated $Folder to build $($info.commit) ($($info.built_at))."
Write-Host "Now click Reload on the Sensei card in edge://extensions."
