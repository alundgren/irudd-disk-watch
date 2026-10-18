#!/bin/bash
# Install the latest stable prebuilt app. This script never opens the app.
set -euo pipefail
umask 077
[ "$(/usr/bin/uname -s)" = Darwin ] && [ "$(/usr/bin/uname -m)" = arm64 ] || { echo 'Disk Watch requires macOS ARM64.' >&2; exit 1; }
[ "$(/usr/bin/id -u)" -ne 0 ] || { echo 'Run this installer as your normal account, without sudo.' >&2; exit 1; }
repo='alundgren/irudd-disk-watch'
stage=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/disk-watch-install.XXXXXXXX")
trap '/bin/rm -rf "$stage"' EXIT
fetch() {
  set -- -H "Accept: ${3:-application/octet-stream}" --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 180 --max-filesize 734003200 "$1" -o "$2"
  if [ -n "${DISK_WATCH_GITHUB_TOKEN:-}" ]; then set -- -H "Authorization: Bearer $DISK_WATCH_GITHUB_TOKEN" "$@"; fi
  /usr/bin/curl "$@"
}
fetch "https://api.github.com/repos/$repo/releases/latest" "$stage/release.json" application/vnd.github+json
# plutil reads GitHub JSON without requiring Python, jq, Node or a checkout.
/usr/bin/plutil -convert xml1 "$stage/release.json" -o "$stage/release.plist"
field() { /usr/bin/plutil -extract "$1" raw -o - "$stage/release.plist"; }
tag=$(field tag_name)
[[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo 'Invalid release version.' >&2; exit 1; }
[ "$(field draft)" = false ] && [ "$(field prerelease)" = false ] || { echo 'Expected a stable release.' >&2; exit 1; }
asset='Disk-Watch-mac-arm64.tar.gz'
asset_url="https://github.com/$repo/releases/download/$tag/$asset"
checksum_url="https://github.com/$repo/releases/download/$tag/SHA256SUMS"
for i in 0 1 2 3 4; do
  name=$(field "assets.$i.name")
  case "$name" in
    "$asset"|"Disk-Watch-${tag#v}-x64-Setup.exe"|dw-scan-linux-x64|dw-scan-linux-arm64|SHA256SUMS) ;;
    *) echo 'Unexpected release asset.' >&2; exit 1 ;;
  esac
  [ "$(field "assets.$i.state")" = uploaded ] || exit 1
  [ "$(field "assets.$i.browser_download_url")" = "https://github.com/$repo/releases/download/$tag/$name" ] || exit 1
  if [ -n "${DISK_WATCH_GITHUB_TOKEN:-}" ]; then
    asset_id=$(field "assets.$i.id")
    [[ "$asset_id" =~ ^[1-9][0-9]*$ ]] || exit 1
    [ "$name" != "$asset" ] || asset_url="https://api.github.com/repos/$repo/releases/assets/$asset_id"
    [ "$name" != SHA256SUMS ] || checksum_url="https://api.github.com/repos/$repo/releases/assets/$asset_id"
  fi
  printf '%s\n' "$name" >> "$stage/assets"
done
[ "$(/usr/bin/sort -u "$stage/assets" | /usr/bin/wc -l | /usr/bin/tr -d ' ')" = 5 ] || exit 1
if field assets.5.name >/dev/null 2>&1; then echo 'Unexpected release asset.' >&2; exit 1; fi
base="https://github.com/$repo/releases/download/$tag"
fetch "$checksum_url" "$stage/SHA256SUMS"
# Exactly four hashes, no paths, duplicates or additional assets.
/usr/bin/awk -v win="Disk-Watch-${tag#v}-x64-Setup.exe" '
  NF != 2 || length($1) != 64 || $1 ~ /[^a-fA-F0-9]/ { exit 1 }
  { sub(/^\*/, "", $2); if ($2 != "Disk-Watch-mac-arm64.tar.gz" && $2 != win && $2 != "dw-scan-linux-x64" && $2 != "dw-scan-linux-arm64") exit 1; if (seen[$2]++) exit 1; n++ }
  END { if (n != 4) exit 1 }
' "$stage/SHA256SUMS" || { echo 'Invalid checksum manifest.' >&2; exit 1; }
fetch "$asset_url" "$stage/$asset"
expected=$(/usr/bin/awk '$2 == "Disk-Watch-mac-arm64.tar.gz" || $2 == "*Disk-Watch-mac-arm64.tar.gz" {print tolower($1)}' "$stage/SHA256SUMS")
actual=$(/usr/bin/shasum -a 256 "$stage/$asset")
[ "${actual%% *}" = "$expected" ] || { echo 'SHA256 verification failed. Installed app was not changed.' >&2; exit 1; }
/usr/bin/tar -tzf "$stage/$asset" > "$stage/entries"
/usr/bin/awk '$0 !~ /^Disk Watch.app(\/|$)/ || $0 ~ /(^|\/)\.\.(\/|$)/ {exit 1}' "$stage/entries" || { echo 'Unsafe app archive.' >&2; exit 1; }
/usr/bin/tar -xzf "$stage/$asset" -C "$stage"
candidate="$stage/Disk Watch.app"
[ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$candidate/Contents/Info.plist")" = com.irudd.diskwatch ] || exit 1
[ "$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$candidate/Contents/Info.plist")" = "${tag#v}" ] || exit 1
# Clean inherited Node injection variables before using the verified app's runtime.
/usr/bin/env -u NODE_OPTIONS -u NODE_PATH PATH=/usr/bin:/bin:/usr/sbin:/sbin ELECTRON_RUN_AS_NODE=1 "$candidate/Contents/MacOS/Disk Watch" "$candidate/Contents/Resources/install-mac.mjs" --source "$candidate" --skip-build --install-directory /Applications
