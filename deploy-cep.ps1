# Sign cep/ and install it into Premiere's CEP extensions folder.
# CEP 12 refuses modified signed extensions silently, so every change to
# cep/ files must go through this script, followed by a Premiere restart.
# Cert + ZXPSignCmd live in tools/ (gitignored); see tools/SIGNING.md.

param(
  [string]$Cert = "$PSScriptRoot\tools\grid-selfsign-2.p12",
  [string]$CertPassword = "gridcontrol-2026"
)

$ErrorActionPreference = "Stop"

$signCmd = "$PSScriptRoot\tools\ZXPSignCmd.exe"
$dest = "$env:APPDATA\Adobe\CEP\extensions\studio.intech.gridcontrol"
$stage = Join-Path $env:TEMP "gridcontrol-stage"
$zxp = Join-Path $env:TEMP "gridcontrol.zxp"

# Stage only what the panel needs (no README, no repo clutter).
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory $stage | Out-Null
Copy-Item "$PSScriptRoot\cep\CSXS" $stage -Recurse
Copy-Item "$PSScriptRoot\cep\CSInterface.js", "$PSScriptRoot\cep\host.jsx",
  "$PSScriptRoot\cep\index.html", "$PSScriptRoot\cep\main.js" $stage

if (Test-Path $zxp) { Remove-Item $zxp -Force }
& $signCmd -sign $stage $zxp $Cert $CertPassword
if ($LASTEXITCODE -ne 0) { throw "Signing failed" }
& $signCmd -verify $zxp
if ($LASTEXITCODE -ne 0) { throw "Signature verification failed" }

# The .zxp is a zip; extract it as the installed extension.
if (Test-Path $dest) { Remove-Item "$dest\*" -Recurse -Force }
New-Item -ItemType Directory -Force $dest | Out-Null
$zip = "$zxp.zip"
Copy-Item $zxp $zip -Force
Expand-Archive $zip $dest -Force
Remove-Item $zip -Force

Write-Host "Deployed signed panel to $dest"
Write-Host "Restart Premiere to load it."
