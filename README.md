# Disk Watch

A Windows desktop app that shows where your disk space went, and what changed since the last time you looked.

You choose which drives or folders to track. One click scans all of them. Nothing runs in the background, so the app costs nothing while you work. Every scan is kept, so you can browse any earlier scan as a full tree. You can also compare any two scans to see which folders grew, which are new, and which are gone.

## Run it

For an installed Windows app, download the x64 Setup executable from a successful Windows workflow artifact and run it. It installs for your user, adds Disk Watch to Start search, and does not create a desktop shortcut or launch the app automatically. The build is unsigned, so Windows may show an unknown-publisher warning. Existing scans remain in `%APPDATA%\disk-watch`.

To build and install it locally:

```sh
npm ci
npm run install:local
```

The install goes to `%LOCALAPPDATA%\Programs\Disk Watch`. Close an existing installed copy first, and run the installer normally as your Windows user. The app starts without elevation; its optional Restart as administrator action enables faster MFT scans.

`npm run dist:win` builds `dist/Disk-Watch-VERSION-x64-Setup.exe` and a self-contained unpacked app in `dist/win-unpacked`. Build machines need Node 24 and Rust with the MSVC target. Installed machines need neither Node nor Rust nor a separate Visual C++ runtime for the scanner. The scanner links its C runtime statically.

Install an existing build without rebuilding:

```powershell
npm run install:local -- -SkipBuild -Installer "dist\Disk-Watch-0.1.0-x64-Setup.exe"
```

The install script also accepts an absolute `-InstallDirectory`. `npm run verify:packaged` tests the unpacked executable, its bundled scanner, branding and a real fixture scan in a hidden window with isolated temporary data. Pass another executable path after `--` to test an installed copy. The Windows workflow runs the full checks and retains the installer artifact for seven days.

To run from source:

You need Node 24 and a Rust toolchain with the MSVC target.

The scanner build uses Cargo from PATH, or from `CARGO_HOME/bin` or the standard user `.cargo/bin` installation when PATH has not refreshed.

```sh
npm install
npm run app
```

`npm run app` builds the scanner and the app, then starts the app as administrator after a UAC prompt. As administrator, scans read the NTFS master file table, which is the fast path. Without administrator rights the app still works, but it lists folders one by one. `npm run dev` starts it that way with hot reload. Data is stored in `%APPDATA%\disk-watch\disk-watch.db`.

Other scripts:

- `npm test` runs the scanner and store tests against a temp folder.
- `npm run verify` builds the app, drives it with Playwright through two scans, and saves screenshots.
- `npm run bench -- D:\` scans a real drive twice into a temp database and prints timings.

If you start the app from a terminal inside another Electron app, unset `ELECTRON_RUN_AS_NODE` first. With that variable set, Electron starts as plain Node and fails with `does not provide an export named 'BrowserWindow'`.

## How it works

Right-click a file, folder or Changes hotspot to hide it from views. Edit the full path or choose a containing folder, then save. The rule applies immediately to all scans of that tracked drive or folder. Settings lists the saved rules for editing or removal, and Undo restores the previous rules unless a later edit has superseded it.

Excluding a folder hides it immediately from Space, Changes and the top hotspot lists, and skips that folder on future scans.

Files and folders at least two levels below a tracked root, such as `C:\foo\bar.txt` or `C:\foo\baz` and never `C:\` or `C:\foo`, can be queued for deletion from the row actions or context menu. The staged summary shows the queued item count and total disk space, and Execute delete removes them in parallel through `dw-scan --delete`.

Known NTFS metadata files and the `$Extend` folder at a drive root are hidden by default only after a completed MFT scan confirms eligibility. Settings can restore them. `System Volume Information`, Recycle Bin and WindowsApps remain visible unless you hide them yourself.

Queue files or folders for permanent deletion, then review the combined count and estimated size before choosing Execute delete. Estimates use full logical sizes from the latest saved scan, including hidden and excluded descendants, and do not promise how much physical space will be freed. Overlapping paths count once. The tracked root and its immediate children cannot be queued. A new scan requires restaging queued items. Deletion refuses to pass through ancestor reparse points and removes links inside a selected folder without traversing their targets. Saved scans remain unchanged; scan again to capture current disk contents. Failed paths stay queued for retry or removal.

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
- Files smaller than 1 MiB are grouped per folder as "N smaller files", so a diff shows their total change but not which small file changed. These grouped rows have no individual paths to hide. Hide their containing folder instead; rules for an individual grouped file cannot subtract that file from a captured group.
- Excludes hide matching folders from existing scans immediately and skip them during future scans.
