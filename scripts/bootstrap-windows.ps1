$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Disk Watch requires Windows x64 and 64-bit PowerShell.' }
$repo = 'alundgren/irudd-disk-watch'
$stage = Join-Path ([IO.Path]::GetTempPath()) ('disk-watch-install-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($stage) | Out-Null
function Save-DiskWatchDownload([string]$Url, [string]$File, [long]$Limit) {
  Add-Type -AssemblyName System.Net.Http
  $client = New-Object Net.Http.HttpClient
  $client.DefaultRequestHeaders.UserAgent.ParseAdd('Disk-Watch/0.2.0')
  $client.DefaultRequestHeaders.Accept.ParseAdd('application/octet-stream')
  if ($env:DISK_WATCH_GITHUB_TOKEN -and ([Uri]$Url).Host -eq 'api.github.com') { $client.DefaultRequestHeaders.Authorization = New-Object Net.Http.Headers.AuthenticationHeaderValue('Bearer', $env:DISK_WATCH_GITHUB_TOKEN) }
  $cancel = New-Object Threading.CancellationTokenSource
  $cancel.CancelAfter(180000)
  $response = $null; $inputStream = $null; $outputStream = $null
  try {
    $response = $client.GetAsync($Url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token).GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode() | Out-Null
    $uri = $response.RequestMessage.RequestUri
    if ($uri.Scheme -ne 'https' -or $uri.Host -notin @('api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com')) { throw 'Release download redirected outside GitHub.' }
    if ($response.Content.Headers.ContentLength -gt $Limit) { throw 'Download exceeds size limit.' }
    $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $outputStream = [IO.File]::Open($File, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $buffer = New-Object byte[] 65536
    [long]$total = 0
    while (($count = $inputStream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token).GetAwaiter().GetResult()) -gt 0) {
      $total += $count
      if ($total -gt $Limit) { throw 'Download exceeds size limit.' }
      $outputStream.Write($buffer, 0, $count)
    }
  } finally {
    if ($outputStream) { $outputStream.Dispose() }; if ($inputStream) { $inputStream.Dispose() }
    if ($response) { $response.Dispose() }; $client.Dispose(); $cancel.Dispose()
  }
}
try {
$metadata = Join-Path $stage 'release.json'
Save-DiskWatchDownload "https://api.github.com/repos/$repo/releases/latest" $metadata 1048576
$release = Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json
if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw 'Invalid stable release.' }
$version = $release.tag_name.Substring(1)
$asset = "Disk-Watch-$version-x64-Setup.exe"
$expectedNames = @('Disk-Watch-mac-arm64.tar.gz', $asset, 'dw-scan-linux-x64', 'dw-scan-linux-arm64', 'SHA256SUMS')
if ($release.assets.Count -ne 5) { throw 'Incomplete release.' }
$assetIds = @{}
foreach ($name in $expectedNames) {
  $matching = @($release.assets | Where-Object { $_.name -ceq $name -and $_.state -eq 'uploaded' -and $_.browser_download_url -ceq "https://github.com/$repo/releases/download/v$version/$name" })
  if ($matching.Count -ne 1 -or [string]$matching[0].id -notmatch '^[1-9][0-9]*$') { throw 'Invalid release assets.' }
  $assetIds[$name] = $matching[0].id
}
  $base = "https://github.com/$repo/releases/download/v$version"
  $manifestPath = Join-Path $stage 'SHA256SUMS'
  $manifestUrl = "$base/SHA256SUMS"
  $installerUrl = "$base/$asset"
  if ($env:DISK_WATCH_GITHUB_TOKEN) {
    $manifestUrl = "https://api.github.com/repos/$repo/releases/assets/$($assetIds['SHA256SUMS'])"
    $installerUrl = "https://api.github.com/repos/$repo/releases/assets/$($assetIds[$asset])"
  }
  Save-DiskWatchDownload $manifestUrl $manifestPath 1048576
  $manifest = Get-Content -LiteralPath $manifestPath -Raw
  $checksums = @{}
  foreach ($line in ($manifest.Trim() -split "`n")) {
    if ($line.TrimEnd("`r") -notmatch '^([a-fA-F0-9]{64}) [ *]([^/\\\r\n]+)$') { throw 'Invalid checksum manifest.' }
    $name = $Matches[2]
    if ($name -cnotin $expectedNames -or $name -eq 'SHA256SUMS' -or $checksums.ContainsKey($name)) { throw 'Invalid checksum asset.' }
    $checksums[$name] = $Matches[1]
  }
  if ($checksums.Count -ne 4) { throw 'Incomplete checksum manifest.' }
  $installer = Join-Path $stage $asset
  Save-DiskWatchDownload $installerUrl $installer 734003200
  Install-DiskWatch -Installer $installer -ExpectedHash $checksums[$asset] -InstallDirectory (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Disk Watch')
  Write-Output 'Search Start for Disk Watch. The installer does not launch the app. History and settings are preserved.'
} finally { Remove-Item -LiteralPath $stage -Recurse -Force }
