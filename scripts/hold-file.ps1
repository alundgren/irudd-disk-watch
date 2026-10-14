$ErrorActionPreference = 'Stop'
$fixturePath = $env:DISK_WATCH_LOCK_PATH
if (-not $fixturePath) { throw 'DISK_WATCH_LOCK_PATH is required.' }
if (-not $fixturePath.StartsWith('\\?\')) { $fixturePath = '\\?\' + $fixturePath }
$handle = [System.IO.File]::Open($fixturePath, 'Open', 'Read', 'Read')
try {
    [Console]::WriteLine('LOCK_READY')
    [Console]::Out.Flush()
    [Console]::In.ReadLine() | Out-Null
} finally {
    $handle.Dispose()
}
