[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$ExpectedHash,
  [string]$InstallDirectory = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Disk Watch'),
  [int]$ParentProcessId = 0,
  [string]$ProfileDirectory,
  [switch]$Restart
)
$ErrorActionPreference = 'Stop'

function Assert-DiskWatchPath([string]$Path) {
  if (-not [IO.Path]::IsPathRooted($Path) -or $Path.Contains('"') -or $Path.Contains("`n") -or $Path.Contains("`r")) { throw 'Unsafe install path.' }
  $current = [IO.Path]::GetFullPath($Path)
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $item.PSIsContainer) { throw "Linked or non-directory install path: $current" }
    }
    $current = Split-Path -Path $current -Parent
  }
}

function Install-DiskWatch {
  param([string]$Installer, [string]$ExpectedHash, [string]$InstallDirectory, [int]$ParentProcessId, [string]$ProfileDirectory, [switch]$Restart)
  if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Disk Watch requires Windows x64 and 64-bit PowerShell.' }
  if ($ExpectedHash -notmatch '^[0-9a-fA-F]{64}$') { throw 'Invalid installer checksum.' }
  if ((Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash -ne $ExpectedHash) { throw 'SHA256 verification failed. The installed app was not changed.' }
  Assert-DiskWatchPath $InstallDirectory
  $InstallDirectory = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
  if ((Split-Path $InstallDirectory -Leaf) -ne 'Disk Watch') { throw 'The install directory must end in Disk Watch.' }
  $parent = Split-Path $InstallDirectory -Parent
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  $lock = Join-Path $parent '.disk-watch-install.lock'
  if ((Test-Path -LiteralPath $lock) -and ((Get-Item -LiteralPath $lock -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe installer lock.' }
  $lockStream = [IO.File]::Open($lock, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $backup = Join-Path $parent ('.disk-watch-previous-' + [Guid]::NewGuid().ToString('N'))
  $hadPrevious = $false
  $changed = $false
  try {
    if ($ParentProcessId -gt 0) {
      $process = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
      if ($process -and -not $process.WaitForExit(120000)) { throw 'Disk Watch did not exit within two minutes.' }
    }
    $executable = Join-Path $InstallDirectory 'Disk Watch.exe'
    $running = Get-CimInstance Win32_Process -Filter "Name = 'Disk Watch.exe'" | Where-Object {
      $_.ExecutablePath -and [StringComparer]::OrdinalIgnoreCase.Equals($_.ExecutablePath, $executable)
    }
    if ($running) { throw 'Quit the installed Disk Watch before installing.' }
    if (Test-Path -LiteralPath $InstallDirectory) {
      if (-not (Test-Path -LiteralPath $executable -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $InstallDirectory 'resources\app.asar') -PathType Leaf)) { throw 'Refusing to replace an unrelated directory.' }
      # Copy the entire old app before NSIS changes files. User data is outside this directory.
      Copy-Item -LiteralPath $InstallDirectory -Destination $backup -Recurse
      $hadPrevious = $true
    }
    $changed = $true
    $process = Start-Process -FilePath $Installer -ArgumentList @('/S', '/currentuser', "/D=$InstallDirectory") -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode)." }
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $InstallDirectory 'resources\dw-scan.exe') -PathType Leaf)) { throw 'Installed app verification failed.' }
    Set-Content -LiteralPath (Join-Path $InstallDirectory '.disk-watch-managed') -Value 'com.irudd.diskwatch' -Encoding ASCII
    if ($Restart) {
      $arguments = @()
      if ($ProfileDirectory) {
        if ($ProfileDirectory.Contains('"') -or $ProfileDirectory.Contains("`n") -or $ProfileDirectory.Contains("`r")) { throw 'Invalid profile path.' }
        $quotedProfile = $ProfileDirectory -replace '(\\+)$', '$1$1'
        $arguments = @('"--user-data-dir=' + $quotedProfile + '"')
      }
      if ($arguments.Count) { Start-Process -FilePath $executable -ArgumentList $arguments | Out-Null }
      else { Start-Process -FilePath $executable | Out-Null }
    }
    $changed = $false
    if ($hadPrevious) { Remove-Item -LiteralPath $backup -Recurse -Force }
    Write-Output "Installed: $executable"
  } catch {
    $failure = $_
    if ($changed) {
      if (Test-Path -LiteralPath $InstallDirectory) { Remove-Item -LiteralPath $InstallDirectory -Recurse -Force }
      if ($hadPrevious) { Move-Item -LiteralPath $backup -Destination $InstallDirectory }
    }
    throw $failure
  } finally {
    $lockStream.Dispose()
    # Leave the lock file in place. Deleting it after unlocking allows two separate lock files.
  }
}

Install-DiskWatch -Installer $Installer -ExpectedHash $ExpectedHash -InstallDirectory $InstallDirectory -ParentProcessId $ParentProcessId -ProfileDirectory $ProfileDirectory -Restart:$Restart
