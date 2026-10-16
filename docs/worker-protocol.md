# Native worker protocol v1

The desktop owns history and display. Native workers own observation and mutation of tracked files. Windows keeps its existing direct scanner CLI, native MFT implementation, deletion guards, and diagnostics. The stdio protocol adds Unix operations and native root inspection without replacing Windows scanning.

## Framing and ownership

Run `dw-scan --worker`, optionally with `--state-dir ABSOLUTE_PRIVATE_DIRECTORY` for an isolated local profile. The default state directory is private per-user application state and persists across worker upgrades. One process handles one operation. A request is one JSON line, at most 4 MiB. Responses are JSON lines, each at most 4 MiB. Stderr is diagnostic only and the controller retains at most 64 KiB. Limit deletion to 1,000 selected targets per request. Numeric measures are nonnegative JavaScript-safe integers. Native identifiers are decimal strings.

Every request has `v: 1`, `requestId`, and `op`. All operations first emit `{t:"hello",v:1,requestId,worker}`. `worker` has `id`, `account`, `os`, `version:1`, and `capabilities` with `scan` and `delete` booleans. `os` is `windows`, `macos`, or `linux`. The persistent installation ID and native account identify execution; a destination alias does not.

Initial `hello` discovers identity. Subsequent requests include `expectedWorker:{id,account}` and must refuse mismatches before filesystem work. The native process owns its lifecycle. Keep stdin open after the request. The controller sends `{op:"ping",requestId}` every five seconds and may send `{op:"cancel",requestId}`. EOF, cancellation, or 20 seconds without input stops further traversal/deletion. Completion is a valid terminal record AND zero process exit. A failed/disconnected/cancelled scan never commits entries.

For non-scan success, the terminal record is `{t:"result",value:...}`. Failure is `{t:"fatal",message}` followed by nonzero exit. Reject duplicate terminal records and all data after a terminal record.

## Paths and observations

A Unix component is canonical base64 of exact native bytes. It cannot be empty, `.` or `..`, or contain slash or NUL. Relative paths are component arrays. Never reconstruct operational paths from displayed labels. `name` labels escape backslashes, controls and invalid UTF-8 unambiguously, while `nameBytes` retains identity. A root's absolute `pathBytes` uses canonical base64. User-entered `path` is initial UTF-8 input only, resolved natively by `inspect`.

`NativeIdentity` is `{device:string,inode:string,mount?:string}`. `NativeRoot` is `{path:string,pathBytes:string,identity:NativeIdentity,filesystem:string,capacity:{total:number,free:number}|null,observedAt:number,readOnly:boolean}`. Root inspection resolves intentional setup aliases once and displays the result. Later requests carry that observation as `root` and must refuse a changed live root or mount. Record root observations on scans and native entry identities on each Unix scan entry. Unknown identity cannot be staged for Unix deletion.

History nodes retain a display name and exact component bytes independently. Windows preserves its existing comparison rules. Unix comparisons, rules and overlap checks use encoded components. Hides and exclusions carry `components` along with display `path`; optional Windows-only legacy string APIs remain supported. Unix user text must be resolved by the worker before becoming a rule.

## Operations

- `hello`: inspect installation and capabilities. The result repeats `worker`.
- `volumes`: discover mounted volumes from native OS metadata without traversing their contents. Result is `{observedAt,volumes,truncated,errors}`, with at most 1,024 rows. Each row has `id,name,path,os,filesystem,kind,readOnly,capacity,recommended`, plus captured `mount` and `device` decimal identifiers when available. Unix rows require absolute `pathBytes` and `mount`; display paths are never operational authority. `kind` is `local`, `network`, `removable`, or `system`. Unavailable metadata is null. Network enumeration must not probe unavailable shares. Row IDs identify discovery choices, not persistent volume identities. The desktop retains the returned rows, reinspects the selected exact path and compares every captured mount/device identifier before registration. Stale selections require Refresh. Windows inspection must resolve to the same root under the existing Windows path comparison policy; mappings that resolve elsewhere require deliberate custom-folder inspection. A Windows network row with no cached identifiers instead requires deliberate custom-path inspection.
- `inspect`: accepts `path` for setup, or an existing `root`. Result is `NativeRoot`.
- `resolve`: accepts `root` and either `path` as entered UTF-8 text or `components`. Result is `{path,components,kind,identity}`. It validates the target natively without traversing a symlink ancestor or unexpected mount. This also resolves typed hide/exclude input. `kind` is `file` or `dir`.
- `scan`: accepts `root`, `excludes` as relative component arrays, and `minFileSize`. Emit `{t:"root",root}`, then existing `progress`, `dir`, `file`, `rest`, `error` records, ending with `done`. Unix `dir` and `file` include `nameBytes`, `identity`, `createdAt` and `lastWrittenAt`. Timestamps are milliseconds or null, never Unix ctime as birth time. `done` retains existing counters/method/fallback/ms and adds `coverage:"complete"|"partial"`. Preserve total error count even when samples are bounded. Unavailable roots fail. Partial observations remain browseable but cannot participate in Changes comparisons.
  The optional `incremental: true` request enables experimental local APFS change tracking. Its result still emits the complete tree. `method: "incremental"` means some directories were reused; `method: "walk"` means every folder was read. `fallback` explains baseline creation, full refresh, or a disabled optimization. Omitted or false requests always perform a full scan. The desktop sends this option only to local Mac workers; Linux, SSH and Windows scanning retain their current methods. Deletion independently validates selected saved identities against live objects and never reads this cache.
- `cleanup`: accepts `root` and `enabled`. Native validation and a persistent allowlist implement explicit cleanup opt-in. Default disabled. Only owner-controlled writable roots qualify. The UI explains the quiescent-tree precondition. Return `{enabled}`.
- `delete`: accepts `root`, `operationId`, and `targets:[{path,components,kind,identity}]`. Bind target identities to the selected saved scan, never newly accepted replacement observations. Minimum depth is two components. Native allowlist, account/installation/root/mount/kind/identity validation is authoritative. Return a durable receipt as result.
- `deleteStatus`: accepts `operationId`. Return a prior durable receipt or an explicit unknown status. Never restart work.

A deletion receipt has `operationId`, `digest`, `state:"running"|"completed"|"interrupted"|"unknown"`, `deleted:string[]`, and `failed` with selected `path`, exact `failedPath`, native error information/domain, and explanatory text. Native storage must durably record started state before mutation. Matching repeated IDs return status without replay; differing payloads fail. A single per-user process lock serializes overlapping roots and controllers. Keep receipts through upgrades and bound retention without deleting running/uncertain records. The desktop also records operation state before dispatch and queries status after uncertainty.

## Unix deletion contract

Cleanup supports owner-controlled quiescent trees and cooperative writers. Open descriptors and native non-following operations protect against symlink traversal and detectable root/mount/ancestor/target changes. Abort subsequent work when a change is detected. Symlink leaves may be unlinked without visiting their targets. Bound parallelism and do not pre-count all descendants.

There is no atomic identity-check-plus-unlink guarantee and no promise of strict namespace containment against a hostile concurrent writer. An already opened directory can be renamed. Test deterministic ancestor moves and leaf replacement detection independently on macOS and Linux. Roots requiring stronger guarantees remain scan-only. Interrupted work may already have removed files; never automatically replay unresolved targets. Saved scans are immutable.

## History compatibility

Use a new database basename and consistent one-time legacy import through a private staging file. Migrate and validate before installing it atomically. Preserve original IDs/history/rules and leave the old file untouched. Reject future schema versions before writes. A downgrade uses the original file; histories do not automatically merge. Existing Windows roots remain Windows roots even when their history is opened on a Mac.

## Windows release gate

A changed Windows release requires real elevated MFT access, app auto-mode MFT assertions, original link/diagnostic/NSIS/UAC tests, and same-machine baseline/candidate performance measurements. Walk-only GUI checks do not establish this. Keep Windows release pending when that evidence is unavailable.

Native completed scans also include `policy: "regular-files-single-mount-no-symlink-traversal"` and `skipped: { symlinks, special, mounts }`. These counters describe intentional policy skips. Permission errors and other unknown coverage gaps produce `coverage: "partial"`; Changes refuses comparisons involving partial scans. The root directory record omits component `nameBytes`, since the absolute root is carried separately in `root.pathBytes`.

On macOS, the read-only system volume at `/` and the writable Data volume at `/System/Volumes/Data` are separate scan roots. Finder presents their combined contents as Macintosh HD. Recommend Data for applications and user files; keep system volumes available explicitly. The scanner stays within the selected mounted filesystem. Regular-file metadata must request the mounted filesystem ID with `FSOPT_RETURN_REALDEV` so sealed system snapshots agree with descriptor-based mount observations. Device and inode identity still come from native stat metadata.

Saved diagnostics come from history, without consulting a live worker. The issue view returns the original scan error total and at most 500 saved path/message samples. Scan messages, skipped counts and traversal policy remain visible even if the machine is offline. Partial zero-byte scans describe missing observations, not empty disks. Capacity is a separate filesystem observation and does not equal captured logical file sizes.

For deliberate setup reinspection, `inspect` also accepts `pathBytes` containing the captured absolute root bytes without an old identity. It returns a new observation for operator acceptance. Ordinary live operations still supply and validate the saved `root`. Desktop reinspection preserves history, disables cleanup and requires a later scan ID before deletion; a stale mount observation is never silently replaced during scanning. Native cleanup is restricted to APFS and mount-table-confirmed ext4.
