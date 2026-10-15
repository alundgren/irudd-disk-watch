# Disk Watch

A desktop app for Windows and Mac that shows where your disk space went, and what changed since the last time you looked.

You choose which drives or folders to track. One click scans all of them. Nothing runs in the background, so the app costs nothing while you work. Every scan is kept, so you can browse any earlier scan as a full tree. You can also compare any two scans to see which folders grew, which are new, and which are gone.

## Run it

For an installed Windows app, download the x64 Setup executable from a successful Windows workflow artifact and run it. It installs for your user, adds Disk Watch to Start search, and does not create a desktop shortcut or launch the app automatically. The build is unsigned, so Windows may show an unknown-publisher warning. Existing scans remain in `%APPDATA%\disk-watch`.

To build and install it locally:

```sh
vp install --frozen-lockfile
vp run install:local
```

The install goes to `%LOCALAPPDATA%\Programs\Disk Watch`. Close an existing installed copy first, and run the installer normally as your Windows user. The app starts without elevation; its optional Restart as administrator action enables faster MFT scans.

`vp run dist:win` builds `dist/Disk-Watch-VERSION-x64-Setup.exe` and a self-contained unpacked app in `dist/win-unpacked`. Build machines need Vite+ and Rust with the MSVC target. Installed machines need neither Node nor Rust nor a separate Visual C++ runtime for the scanner. The scanner links its C runtime statically.

Install an existing build without rebuilding:

```powershell
vp run install:local -SkipBuild -Installer "dist\Disk-Watch-0.1.0-x64-Setup.exe"
```

The install script also accepts an absolute `-InstallDirectory`. `vp run verify:packaged` tests the unpacked executable, its bundled scanner, branding and a real fixture scan in a hidden window with isolated temporary data. Append another executable path to test an installed copy. The Windows workflow runs the full checks and retains the installer artifact for seven days.

To run from source:

Install [Vite+](https://viteplus.dev/guide/global-cli) and Rust. Windows builds need the MSVC toolchain. Mac builds use the native ARM64 Rust toolchain and Xcode command-line tools. Vite+ downloads and selects the project's pinned Node 24.21.0 and pnpm 12.6.0 from `package.json`; neither needs a separate installation. The project uses Vite+ 1.1.0.

`vp install --frozen-lockfile` installs the committed pnpm lockfile and downloads the Electron development runtime through the project's postinstall hook. The scanner build uses Cargo from PATH, or from `CARGO_HOME/bin` or the standard user `.cargo/bin` installation when PATH has not refreshed.

```sh
vp install --frozen-lockfile
vp run app
```

On Windows, `vp run app` builds and starts the app as administrator after a UAC prompt. As administrator, scans read the NTFS master file table, which is the fast path. Without administrator rights the app still works, but it lists folders one by one. `vp run dev` starts it that way with hot reload.

On Mac, `vp run app` builds and starts Electron normally. Native scans use the Mac account's existing filesystem permissions. Choose a folder to track locally, or use Track over SSH for a Linux worker. Forward a separate profile directory when needed, for example `vp run app -- --user-data-dir=/absolute/profile-directory`. The Windows UAC launch retains those arguments too.

Build a personal unsigned Mac ARM64 app without launching or installing it:

```sh
vp run dist:mac
```

The result is `dist/mac-arm64/Disk Watch.app`. The native `dw-scan` executable is bundled outside the ASAR archive in `Contents/Resources`, and the icon is generated from the existing artwork with the macOS `sips` and `iconutil` tools. This build is not signed or notarized. It does not replace an installed app. The Native workflow builds the app on an ARM64 Mac runner and uploads an archive that retains executable permissions.

For SSH tracking, install a matching native Linux worker at the fixed per-account path `$HOME/.local/share/disk-watch/worker-v1`. Build it on the Linux machine, or use the matching Linux workflow artifact. Existing SSH key authentication and a previously verified host key are required; the app refuses password and host-key prompts. A generic installation on that Linux account is:

```sh
cargo build --release --locked --manifest-path scanner/Cargo.toml
install -d -m 700 "$HOME/.local/share/disk-watch"
install -m 700 scanner/target/release/dw-scan "$HOME/.local/share/disk-watch/worker-v1"
```

Inspect existing destination ownership and preserve an existing worker before replacing it. Then enter an SSH configuration alias or `user@host` and an absolute remote root in Track over SSH. The app uses the fixed worker command, disables forwarding and SSH connection sharing, and records worker/account identity. An alias pointing to a different machine is refused. No remote daemon or Go runtime is needed.

Unix cleanup starts disabled. Enable it only for an owner-controlled root after stopping writers. Native guards reject symlink ancestors, changed object identities and mount crossings, but Unix does not provide an atomic identity-check-and-unlink operation. Concurrent hostile writers are outside the supported cleanup contract. Interrupted deletions are checked by operation ID; they are never automatically repeated. See [native behavior and limitations](scanner/README.md).

The app imports legacy `disk-watch.db` history into a checked, separate `disk-watch-native.db` using a read-only SQLite backup, including committed WAL rows. The legacy file is retained. Older releases continue using the legacy history; histories diverge after downgrade and are not automatically merged. Windows histories viewed on Mac remain historical and cannot become local deletion targets.

Before replacing a Windows build, use the [Windows agent verification guide](docs/windows-verification.md). It includes administrator/MFT checks and same-machine baseline comparisons; successful Mac tests do not establish Windows performance.

Other scripts:

- `vp run test` builds the scanner and runs the scanner and store tests through Vite+ against temp folders.
- `vp run test:rust` runs the Rust scanner tests.
- `vp run typecheck` checks TypeScript.
- `vp run build` builds the scanner and Electron app.
- `vp run test:renderer` runs the pure renderer tests without Electron.
- `vp run dist:mac` builds the personal unsigned ARM64 Mac app without launching it.
- `vp run verify:windows` and its existing `verify` alias build the app, drive it with Playwright through two scans, and save screenshots.
- `vp run verify:packaged:windows` and its existing `verify:packaged` alias test the Windows executable.
- `vp run ready` is the Windows release check. It runs tests, typecheck, UI verification, Windows packaging, and packaged verification.
- `vp run bench D:\` scans a real drive twice into a temp database and prints timings.

Use `vp run build` and `vp run dev` for this Electron app. These scripts run `electron-vite` with Vite 7, the version supported by stable electron-vite. Vite+ uses its own Vite core for the test runner. `vp build` and `vp dev` directly start Vite+'s web tooling, so use the project scripts instead.

If you start the app from a terminal inside another Electron app, unset `ELECTRON_RUN_AS_NODE` first. With that variable set, Electron starts as plain Node and fails with `does not provide an export named 'BrowserWindow'`.

## How it works

The Treemap tab draws folders and files as rectangles sized by their visible logical bytes. Click a folder to zoom in, use breadcrumbs to return, and choose any saved scan. Nested rectangles preview the largest folders. Colors distinguish folders; striped rectangles represent captured files below 1 MiB. Large sets of entries collect into an other-items tile that you can open. The map respects the same hides and exclusions as Space and offers the same right-click file actions.

Right-click a file, folder or Changes hotspot to hide it from views. Edit the full path or choose a containing folder, then save. The rule applies immediately to all scans of that tracked drive or folder. Settings lists the saved rules for editing or removal, and Undo restores the previous rules unless a later edit has superseded it.

Excluding a file or folder hides it immediately from Space, Changes and the top hotspot lists, and skips it on future scans. Settings can add either kind and remove exclusions. Small files below 1 MiB remain included in folder totals and changes but are not listed individually; there is no grouped small-files row. Old scans keep their captured totals, and an individual small file cannot be subtracted from a historical group.

Right-click a row for Show in Explorer, Hide, Exclude and eligible deletion actions. Keyboard users can focus a file, folder or Changes hotspot and press the Menu key or Shift+F10. Escape returns focus to the row.

Space's Age column pairs the latest write, marked with a pencil, with the smaller creation age, marked with a circled plus. Ages use seconds, minutes, hours, days, 30-day months and 365-day years. Creation belongs to the folder itself; latest write is the newest file-system write timestamp captured in that folder or its scanned descendants, including small files. Both scan methods collect these times during their existing reads. Missing or future-dated timestamps stay blank, and earlier scans need a fresh scan to capture them. View hides do not change captured timestamps; future scan exclusions remove those entries from the captured scope. These are saved metadata observations, not live write monitoring. Writer attribution is omitted because the stored metadata does not identify the writing process reliably.

Files and folders at least two levels below a tracked root, such as `C:\foo\bar.txt` or `C:\foo\baz` and never `C:\` or `C:\foo`, can be queued for deletion from the context menu. The staged summary shows the queued item count and total disk space, and Execute delete removes them in parallel through `dw-scan --delete`.

Known NTFS metadata files and the `$Extend` folder at a drive root are hidden by default only after a completed MFT scan confirms eligibility. Settings can restore them. `System Volume Information`, Recycle Bin and WindowsApps remain visible unless you hide them yourself.

Queue files or folders for permanent deletion, then review the combined count and estimated size before choosing Execute delete. Estimates use full logical sizes from the latest saved scan, including hidden and excluded descendants, and do not promise how much physical space will be freed. Overlapping paths count once. The tracked root and its immediate children cannot be queued. A new scan requires restaging queued items. Deletion refuses to pass through ancestor reparse points and removes links inside a selected folder without traversing their targets. Saved scans remain unchanged; scan again to capture current disk contents. Failed paths stay queued for retry or removal.

When deletion fails, a large popup shows every failed queued path, the exact operation path and Windows error. For sharing, lock, access-denied and directory-not-empty errors, it looks up processes using that path and shows their PID, process name, program name, executable path and service name where available. Each value is selectable and has a Copy button; Copy report copies the complete failure report. Close leaves View details in the notice so you can reopen it.

The lookup uses Windows file/directory handle queries and Restart Manager for files. It runs after deletion workers release their guards and excludes the scanner's own process. Results are a snapshot of path users, which can include processes whose handles allow deletion. Windows may hide protected processes, and some file systems cannot report owners. One failed operation is reported per queued path, so a folder may have further blocked items. Close a program yourself or locate its PID in Task Manager, then retry. Disk Watch does not stop processes. A failed folder can already have had some of its contents removed.

`scanner/` is `dw-scan.exe`, a small Rust program that prints a tree as NDJSON. It runs in Windows background mode, which lowers its CPU, disk, and memory priority. It has two ways to build the tree:

- **MFT.** Every file and folder on an NTFS volume has a record in the master file table, holding its names, its parent folder, and its size. The scanner reads the raw table front to back in 16 MiB chunks and builds the tree from the parent links. This needs administrator rights.
- **Folder walk.** Lists folders in parallel, one thread per core. File sizes come with each listing, so there is no extra system call per file. Junctions and symlinks are skipped so that nothing is counted twice. This works on any file system without administrator rights.

`--method auto`, the default, reads the MFT and falls back to the walk when it can't, for example without administrator rights or on an exFAT drive. Each scan records which method ran, shown in Settings under Scan history.

The Electron main process runs each scan in a worker thread. The worker reads the scanner's output and writes it to SQLite in one transaction. A scan is saved completely or not at all.

The database stores each path once in `node`, as a parent, a name, and a kind. Each scan adds one compact `entry` row per folder, one per file of 1 MiB or more, and one row per folder for the total of its smaller files. A diff joins two scans' entries on the node id. Old scans keep their full tree without storing anything twice.

## Numbers

These were measured with the folder walk on this machine's `C:` drive, which has 1.09 million files in 305,000 folders and about 690 GB used.

| | Time |
| --- | --- |
| First scan, folder metadata not yet in OS cache | 45 s walk |
| Later scan | about 4 s walk and 3 s save |
| Database after one scan | 96 MB |
| Each additional scan | +8 MB |
| Comparing two scans | under 0.4 s |

## Why every scan is a full scan

Folder timestamps would allow a cheap partial rescan, but they are not reliable. A file that grows in place, such as a render being written, does not update its folder's timestamp, so a partial scan would miss exactly the growth this app exists to show. Reading the whole MFT costs a few large sequential reads, so a full scan stays cheap.

## Limits

- Sizes are logical file sizes, as Explorer's "Size" column shows them, not "Size on disk". Compressed files and cloud placeholders such as OneDrive files report their full size.
- With the MFT, a file with several hard links is counted once, under the first of its names. The other names do not show in the tree. The folder walk cannot tell links apart and counts each one, which can add up to more than the drive holds. On this machine, AI model files hard-linked between two apps made the walk report 825 GB on a drive with 689 GB used.
- The MFT scan adds NTFS metadata files such as `$MFT` at the root, and includes `System Volume Information`, which holds restore points. The folder walk can't read either. The first MFT scan after earlier walk scans therefore shows them as new.
- Files smaller than 1 MiB contribute to folder totals and hotspot growth without appearing as rows. Folder totals can exceed the sum of listed files. An exact file exclusion skips even a small file on future scans, but cannot subtract it individually from an older captured group.
- Excludes hide matching folders from existing scans immediately and skip them during future scans.
