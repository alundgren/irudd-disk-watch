[CmdletBinding()]
param(
  [string]$Installer,
  [switch]$SkipBuild,
  [string]$InstallDirectory = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Disk Watch')
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot
if (-not [IO.Path]::IsPathRooted($InstallDirectory)) { throw 'InstallDirectory must be an absolute path.' }
$InstallDirectory = [IO.Path]::GetFullPath($InstallDirectory)
$executable = Join-Path $InstallDirectory 'Disk Watch.exe'
$running = Get-CimInstance Win32_Process -Filter "Name = 'Disk Watch.exe'" | Where-Object {
  $_.ExecutablePath -and [StringComparer]::OrdinalIgnoreCase.Equals($_.ExecutablePath, $executable)
}
if ($running) { throw 'Close the installed Disk Watch first, then run the install command again.' }

if (-not $SkipBuild) {
  Push-Location $projectRoot
  try {
    & vp run dist:win
    if ($LASTEXITCODE -ne 0) { throw "Windows build failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}

if (-not $Installer) {
  $package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
  $Installer = Join-Path $projectRoot "dist\Disk-Watch-$($package.version)-x64-Setup.exe"
}
$Installer = (Resolve-Path -LiteralPath $Installer).Path

$process = Start-Process -FilePath $Installer -ArgumentList @('/S', '/currentuser', "/D=$InstallDirectory") -Wait -PassThru -WindowStyle Hidden
if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode)." }

$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Disk Watch.lnk'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Installed executable was not found at $executable." }
if (-not (Test-Path -LiteralPath $shortcut -PathType Leaf)) { throw "Start menu shortcut was not found at $shortcut." }
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($link.TargetPath, $executable)) {
  throw "The Start menu shortcut does not point to $executable."
}

Write-Output "Installed: $executable"
Write-Output "Start menu: $shortcut"
Write-Output 'Search Start for Disk Watch to launch it. Existing scans stay in %APPDATA%\disk-watch.'
