# Starts the built app as administrator so scans can read the NTFS MFT.
param([string]$EncodedArguments = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$forwarded = @()
if ($EncodedArguments) {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedArguments))
  $forwarded = @(ConvertFrom-Json -InputObject $json)
}

# Start-Process joins ArgumentList into one Windows command line, so quote each
# argument for the executable's argv parser, including trailing backslashes.
function Quote-WindowsArgument([string]$Value) {
  $quoted = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $quoted = [regex]::Replace($quoted, '(\\+)$', '$1$1')
  return '"' + $quoted + '"'
}
$arguments = @($root) + $forwarded
$commandLine = ($arguments | ForEach-Object { Quote-WindowsArgument ([string]$_) }) -join ' '
Start-Process -FilePath "$root\node_modules\electron\dist\electron.exe" -ArgumentList $commandLine -Verb RunAs
