# Install, update and remove Disk Watch

Disk Watch 0.2.0 releases provide a macOS ARM64 app, a Windows x64 installer and two raw Linux scanners. The installers download the latest stable version from the public `alundgren/irudd-disk-watch` repository, verify its SHA256SUMS, and keep app data separate. Installation, app updates and SSH scanner downloads require no GitHub token. The installed machine needs no Node, Rust, Git or source checkout. The installers require a published stable release.

On an Apple Silicon Mac, run as your normal account, without sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/alundgren/irudd-disk-watch/main/install.sh | bash
```

The app installs at `/Applications/Disk Watch.app`. Quit any running copy first. The destination must be writable by your account. Search Spotlight to open it when ready. The installer never launches it. macOS may require confirmation for this unsigned, unnotarized download. Review the download before allowing it through macOS security settings.

The downloaded candidate's Electron executable runs the bundled installer in Node mode. It copies the candidate to a temporary directory beside the destination, validates it, and swaps the whole app with rollback. The running source stays outside the replaced app. A directory lock prevents concurrent replacements. After an interrupted install, inspect `.disk-watch-install.lock` and any `.disk-watch-install-*` directory beside the app before removing a stale lock. A failed rollback retains the previous app there and logs its path.

If the installed app records a local signing certificate, updates require that certificate and its private key in your Keychain. A missing or invalid certificate stops installation before replacement. The fingerprint stays recorded in the installed app. For an initial locally signed install, set `DISK_WATCH_SIGNING_IDENTITY` to the exact existing certificate name or fingerprint before running the bootstrap. Keychain may ask for access. Grant Full Disk Access to the installed app in System Settings, then verify it after an update. Unsigned installation does not guarantee retained permissions.

In 64-bit Windows PowerShell on Windows x64, run:

```powershell
irm https://raw.githubusercontent.com/alundgren/irudd-disk-watch/main/install.ps1 | iex
```

The app installs per user at `%LOCALAPPDATA%\Programs\Disk Watch`. Search Start to open it. Initial installation never opens it or asks for elevation. The installer is unsigned, so Windows may show an unknown-publisher warning. PowerShell verifies the downloaded NSIS installer, takes an exclusive file lock beside the destination, backs up the previous app, and restores its files if installation fails. NSIS keeps user data during updates and uninstall. A failed rollback retains the `.disk-watch-previous-*` directory for recovery. Do not delete that backup until the installed app works.

# Update from the app

App updates show the running version and the latest stable release. Check for updates, choose Download update, then choose Install and restart. Download errors include a retry action. The app refuses restart while scans or other filesystem operations are active. Checking and downloading can run while a scan continues.

The updater verifies the downloaded asset, stages it in a private cache outside the installed app, and checks it again before handoff. The detached updater waits up to two minutes for the old PID to exit. On Mac, the system shell invokes the verified candidate's runtime and copied bundled helper, then opens the installed app only after success. Windows uses system PowerShell and NSIS. Both preserve a custom `--user-data-dir` profile. Development and unmanaged copies show installation guidance.

If the app does not reopen, open it manually from its stable installed path. Inspect `update.log` in the `updates/update-*` directory under your app profile when using the standard integration. The main process may choose another private update cache. Failed installs preserve the old app or retain a recovery backup. Successful update stages are retained for diagnostics and may be deleted after quitting the app and confirming the new version works.

# Linux scanner compatibility

The assets `dw-scan-linux-x64` and `dw-scan-linux-arm64` are raw, fully static executables built for `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`. No glibc or remote build tools are needed. Supported hosts need Linux kernel 4.14 or later on x86-64 or ARM64, a mounted `/proc` filesystem, and SSH, `sh`, `head`, `stat`, `sha256sum` and `flock` in the account's environment. The scanner reads `/proc/self/fdinfo` to validate mount identity. A minimal container without `/proc` cannot satisfy this requirement.

The app checks host compatibility and probes the downloaded candidate before activation. The previous scanner and its separate worker identity/state remain available if validation fails. Scanner updates use the exact running app version, so updating the app first may be necessary.

# Remove and reinstall later

Quit Disk Watch first. On Mac, remove only `/Applications/Disk Watch.app` using Finder. On Windows, uninstall Disk Watch through Installed apps. Neither action should remove scan history and settings. Reinstall using the same bootstrap command and launch manually. On Mac, retain any local signing certificate and grant or confirm Full Disk Access afterward.

The normal profile is `~/Library/Application Support/disk-watch` on Mac and `%APPDATA%\disk-watch` on Windows. A custom `--user-data-dir` uses the path you selected. Preserve the entire profile, including native worker state, to retain machine identity and history. App removal is separate from deleting that profile. Back it up before deliberately deleting it. Linux worker identity/state is separate from the executable and should remain during a worker update.

# Release maintainers

Set `package.json` to the stable version and create the matching `v<version>` tag only after review and approval. The tag workflow builds the two app assets and native x64/ARM64 musl scanners, and generates SHA256SUMS over the exact four files. Publication waits for both platform build jobs. GitHub Actions is release-only and runs no tests, linting, typechecks, smoke tests, GUI verification or compatibility validation. Run those checks outside Actions before approving a release. For each Linux scanner, run these commands in a Linux development environment and confirm there is no `INTERP` entry or `NEEDED` dependency:

```sh
readelf -h /absolute/path/to/dw-scan-linux-ARCH
readelf -l /absolute/path/to/dw-scan-linux-ARCH
readelf -d /absolute/path/to/dw-scan-linux-ARCH
```

The release workflow creates a draft, verifies the uploaded asset set, then publishes. An existing release causes failure; no asset overwrite or release replacement is attempted. An interrupted draft requires maintainer inspection before retrying. Pull requests and branch pushes do not run GitHub Actions.
