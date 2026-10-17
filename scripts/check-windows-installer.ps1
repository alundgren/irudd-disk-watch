$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot
$helper = Join-Path $PSScriptRoot 'install-windows.ps1'
$version = (Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json).version
$installer = Join-Path $project "dist\Disk-Watch-$version-x64-Setup.exe"
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('disk-watch-ci-' + [Guid]::NewGuid().ToString('N'))
$destination = Join-Path $fixture 'Disk Watch'
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$oldPath = $env:PATH
try {
  # Only system PowerShell and NSIS are available, with no Node, Rust or repo tools on PATH.
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
  & $helper -Installer $installer -ExpectedHash $hash -InstallDirectory $destination
  $sentinel = Join-Path $destination 'rollback-sentinel'
  Set-Content -LiteralPath $sentinel -Value 'preserve'
  try {
    & $helper -Installer $installer -ExpectedHash ('0' * 64) -InstallDirectory $destination
    throw 'Hash failure was accepted'
  } catch {
    if ($_ -notmatch 'SHA256 verification failed') { throw }
  }
  if ((Get-Content -LiteralPath $sentinel).Trim() -ne 'preserve') { throw 'Hash failure changed previous app.' }
  # A verified but invalid EXE fails after backup, exercising rollback rather than preflight.
  $invalid = Join-Path $fixture 'invalid.exe'
  Set-Content -LiteralPath $invalid -Value 'not an executable'
  try {
    & $helper -Installer $invalid -ExpectedHash (Get-FileHash -LiteralPath $invalid -Algorithm SHA256).Hash -InstallDirectory $destination
    throw 'Invalid candidate was accepted'
  } catch {
    if ($_ -match 'Invalid candidate was accepted') { throw }
  }
  if ((Get-Content -LiteralPath $sentinel).Trim() -ne 'preserve') { throw 'Rollback lost previous app.' }
  & $helper -Installer $installer -ExpectedHash $hash -InstallDirectory $destination
  if (-not (Test-Path -LiteralPath (Join-Path $destination '.disk-watch-managed'))) { throw 'Missing managed marker.' }
  Write-Output 'Clean-machine install, failed verification, rollback and reinstall checks passed.'
} finally {
  $env:PATH = $oldPath
  Remove-Item -LiteralPath $fixture -Recurse -Force
}
