# Starts the built app as administrator so scans can read the NTFS MFT.
$root = Split-Path $PSScriptRoot
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath "$root\node_modules\electron\dist\electron.exe" -ArgumentList "`"$root`"" -Verb RunAs
