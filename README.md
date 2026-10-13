# Disk Watch

A Windows desktop app that shows where your disk space went, and what changed since the last time you looked.

You choose which drives or folders to track. You start each scan by hand. Nothing runs in the background, so the app costs nothing while you work. Every scan is kept, so you can browse any earlier scan as a full tree. You can also compare any two scans to see which folders grew, which are new, and which are gone.

## Run it

You need Node 24 and a Rust toolchain with the MSVC target.

```sh
npm install
npm run dev
```

`npm run dev` builds the scanner and opens the app. Data is stored in `%APPDATA%\disk-watch\disk-watch.db`.

Other scripts:

- `npm test` runs the scanner and store tests against a temp folder.
- `npm run verify` builds the app, drives it with Playwright through two scans, and saves screenshots.
- `npm run bench -- D:\` scans a real drive twice into a temp database and prints timings.

If you start the app from a terminal inside another Electron app, unset `ELECTRON_RUN_AS_NODE` first. With that variable set, Electron starts as plain Node and fails with `does not provide an export named 'BrowserWindow'`.

## How it works

`scanner/` is `dw-scan.exe`, a small Rust program. It walks a tree in parallel, one thread per core, and runs in Windows background mode, which lowers its CPU, disk, and memory priority. It reads file sizes from the directory listing, so it makes no extra system call per file. It skips junctions and symlinks so that nothing is counted twice. It prints the tree as NDJSON.

The Electron main process runs each scan in a worker thread. The worker reads the scanner's output and writes it to SQLite in one transaction. A scan is saved completely or not at all.

The database stores each path once in `node`, as a parent, a name, and a kind. Each scan adds one compact `entry` row per folder, one per file of 1 MiB or more, and one row per folder for the total of its smaller files. A diff joins two scans' entries on the node id. Old scans keep their full tree without storing anything twice.

## Numbers

These were measured on this machine's `C:` drive, which has 1.09 million files in 305,000 folders and about 690 GB used.

| | Time |
| --- | --- |
| First scan, folder metadata not yet in OS cache | 45 s walk |
| Later scan | about 4 s walk and 3 s save |
| Database after one scan | 96 MB |
| Each additional scan | +8 MB |
| Comparing two scans | under 0.4 s |

## Why every scan is a full scan

Reading the NTFS change journal (USN) or the MFT directly would be faster. Both need the app to run as administrator. Folder timestamps would allow a cheap partial rescan, but they are not reliable. A file that grows in place, such as a render being written, does not update its folder's timestamp, so a partial scan would miss exactly the growth this app exists to show. Because a warm full scan of a million files takes seconds, full scans are the honest default.

## Limits

- Sizes are logical file sizes, as Explorer's "Size" column shows them, not "Size on disk". Compressed files and cloud placeholders such as OneDrive files report their full size.
- A file with several hard links is counted once for each link.
- Files smaller than 1 MiB are grouped per folder as "N smaller files", so a diff shows their total change but not which small file changed.
- Excludes apply from the next scan on. A newly excluded folder shows as gone when you compare a scan from before the exclude with one from after it.
