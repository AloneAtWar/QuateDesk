$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$portable = Join-Path $root 'outputs\QuotaDesk-win32-x64'
$runtime = Join-Path $root 'node_modules\electron\dist'

if (Test-Path -LiteralPath $portable) {
  Remove-Item -LiteralPath $portable -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $portable 'resources\app') | Out-Null
Copy-Item -Path (Join-Path $runtime '*') -Destination $portable -Recurse -Force
Copy-Item -Path (Join-Path $root 'dist') -Destination (Join-Path $portable 'resources\app\dist') -Recurse -Force
Copy-Item -Path (Join-Path $root 'electron') -Destination (Join-Path $portable 'resources\app\electron') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination (Join-Path $portable 'resources\app\package.json') -Force
Copy-Item -LiteralPath (Join-Path $root 'desktop-readme.txt') -Destination (Join-Path $portable 'README.txt') -Force
Rename-Item -LiteralPath (Join-Path $portable 'electron.exe') -NewName 'QuotaDesk.exe' -Force
Write-Host "Portable app created at $portable"
