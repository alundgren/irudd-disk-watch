# Windows verification before release

Use this procedure when verifying the native-worker changes on Windows. Keep the release draft until every required check below has recorded evidence. A passing walk scan, a Mac build or a Windows compile does not prove that elevated MFT scanning still works.

## Prepare an isolated Windows run

1. Read the Windows machine's applicable `AGENTS.md` and inspect each command and its launch helpers. GUI, UAC, clipboard and Explorer checks require a dedicated Windows graphical session, such as a test VM or a remote test desktop. A hidden Electron window is not desktop isolation. If that session is unavailable, run only inspected non-GUI checks and report the GUI gates as pending.
2. Use an ordinary test account that can approve elevation in that session. Record Windows build, CPU architecture, filesystem, Node/Vite+/Rust versions and elevation state locally. Record whether encryption, antivirus, compression or power settings differ between runs. Publish anonymized facts only.
3. Create two clean, detached worktrees under a new temporary audit directory. Pin baseline to `878498541b42e7eba0c17474f63d8912a240bd0b`. Pin candidate to the exact committed integration revision under review. Keep both checkouts, build outputs, scanner executables and application profiles separate. Use the same Node runtime and Rust toolchain for both.

For example, from the repository in PowerShell:

```powershell
$Audit = Join-Path $env:TEMP ('disk-watch-windows-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Audit | Out-Null
$Baseline = Join-Path $Audit 'baseline'
$Candidate = Join-Path $Audit 'candidate'
$CandidateCommit = git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify candidate commit' }
git worktree add --detach $Baseline 878498541b42e7eba0c17474f63d8912a240bd0b
if ($LASTEXITCODE -ne 0) { throw 'Baseline worktree failed' }
git worktree add --detach $Candidate $CandidateCommit
if ($LASTEXITCODE -ne 0) { throw 'Candidate worktree failed' }
```

Inspect the candidate's native changes before execution. Review any diff in `scanner/src/mft.rs`, `scanner/src/delete.rs`, Windows priority handling and `.cargo/config.toml`. Preserve sequential raw MFT reads, record-derived timestamps, metadata coverage, hard-link attribution, background priority, reparse guards and static CRT linkage. Do not add per-entry filesystem metadata calls to fill Unix identity fields.

Completion evidence is two exact commit IDs, two clean tracked-file statuses, the relevant source diff and the isolated desktop identity recorded privately. Stop if either worktree contains unexplained tracked edits.

## Build and run the original Windows tests

In each worktree, install the committed dependencies and run the inspected test, Rust test, typecheck and build scripts from its `package.json`. Check each exit code before continuing. Dependency installation may download Electron; building must not launch it. Use the pinned project runtime through `vp` and build each worktree's own release `dw-scan.exe`. An executable left from another revision invalidates the comparison.

Run these literal commands in each worktree and stop at the first nonzero exit:

```powershell
foreach ($Checkout in @($Baseline, $Candidate)) {
    Set-Location $Checkout
    vp install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency install failed' }
    vp run test
    if ($LASTEXITCODE -ne 0) { throw 'Windows scanner/store tests failed' }
    vp run test:rust
    if ($LASTEXITCODE -ne 0) { throw 'Rust tests failed' }
    vp run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
    vp run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
}
```

Run the entire existing Windows scanner and Store suite. In particular, retain these fixture assertions:

- `src/main/scan.test.ts` exercises ancestor junction refusal, leaf junction unlinking and a junction inside a selected directory. Its outside sentinel must survive byte-for-byte. It also tests stale staging, type replacement and lock diagnostics across the scanner boundary.
- `scanner/src/delete.rs` tests nested read-only files and an open file that denies deletion sharing. Good siblings may be removed while the locked child remains. Ancestor handles must prevent detectable replacement.
- Preserve directory symbolic links and hard-link coverage where available. A junction test does not prove every reparse type. If Windows policy prevents creating symbolic links, record that test as unavailable rather than silently substituting a junction.

All mutations in these tests must remain inside their own generated fixture directories and their own generated outside-sentinel directories. Never point deletion fixtures at a representative performance root or real application data. Release all lock-holder subprocesses before cleanup. Record test counts, skips, exit codes and unchanged outside-sentinel contents. Existing TypeScript scan helpers force `walk`, so their passing result is a separate gate from MFT proof.

## Compare actual elevated MFT scans

Open an elevated terminal inside the dedicated Windows session. The comparison harness does not prompt for UAC, install software, launch Electron or request deletion.

```powershell
Set-Location $Candidate
vp exec node scripts/windows-regression.mjs --baseline $Baseline --candidate $Candidate > (Join-Path $Audit 'fixture-mft.json')
if ($LASTEXITCODE -ne 0) { throw 'MFT fixture comparison failed' }
```

The default root is an owned temporary fixture. The harness launches each worktree's direct CLI and its `runScan`/SQLite ingestion in separate Node subprocesses. Every request forces `method: 'mft'`; every result must report actual method `mft`, null fallback and zero errors. It compares root sizes, file/directory counts and captured entry counts across CLI, SQLite, repeated scans and both revisions. Two scans in each fresh database measure first and repeated storage plus a Changes query. A walk fallback, nonzero exit, incomplete scan or changed totals fails the run.

Then select an accessible, quiescent NTFS folder with representative file and directory counts. Obtain the operator's explicit read-only root choice. Keep other writers stopped for this measurement. Pass its absolute path through `--root`:

```powershell
$RepresentativeRoot = Read-Host 'Absolute NTFS folder for read-only performance scans'
vp exec node scripts/windows-regression.mjs --baseline $Baseline --candidate $Candidate --root $RepresentativeRoot --rounds 5 > (Join-Path $Audit 'representative-mft.json')
if ($LASTEXITCODE -ne 0) { throw 'Representative MFT comparison failed' }
```

The harness rejects roots containing its scratch directory or either checkout, and never removes `--root`. It creates databases under a separate generated temporary directory and removes only that directory. Root reads can still update OS access bookkeeping. Do not choose a live production volume or a root whose contents cannot remain stable. Failure may expose paths in local stderr; inspect and redact reports before sharing.

The JSON records exact commit IDs and scanner SHA-256 hashes. Warmup rounds precede measured rounds, and variant order alternates each round. Compare measured medians and ranges for CLI elapsed/scanner time, SQLite first/repeated elapsed/scanner time, comparison query time, database plus WAL bytes and Node peak RSS. A ratio above one means the candidate used more of that measure. This is a warm-cache comparison without cache flushing. Node peak RSS excludes native scanner memory; measure native peak working set separately with a Windows process tool if memory approval requires it. Do not label Node memory as total application memory.

Agree the acceptable regression budget before representative measurement. Investigate repeatable timing or memory increases with the same root and settings. A correctness mismatch blocks approval even if timing improves. Save raw measurements, the pre-agreed budget and the conclusion. Do not infer cold-cache behavior or broad performance preservation from the tiny fixture.

## Import a copied legacy history

Use an operator-selected legacy test snapshot or create a consistent SQLite backup from an authorized source opened read-only. SQLite backup must include committed WAL rows; copying a live `.db` alone is insufficient. Close the backup connection before copying that snapshot into test profiles. Keep the source profile and source database untouched by either application.

1. Create separate baseline and candidate profile directories under `$Audit`. Put an independent copy of the closed snapshot at each profile's `disk-watch.db`. Record SHA-256 hashes before application startup.
2. On copied data, capture original IDs, node parent/name/kind, roots, scans, totals, timestamp nulls, methods/fallbacks, exclusions, hides and revisions. Compare browse trees, totals and Changes results before and after candidate migration. Preserve every existing Windows ID and Windows comparison rule. A migration collision must stop with a useful error, never combine IDs.
3. Start the candidate with only its explicit temporary profile. Confirm `disk-watch-native.db` appears after successful staged import. The copied legacy `disk-watch.db` must retain its hash, and the operator's original profile must remain unused. Candidate Windows history must retain Windows machine ownership. On Windows startup the imported Windows machine binds to the inspected local Windows worker before the first window appears. Verify Scan all drives is enabled without adding a root again, IDs stay unchanged, and an already bound different worker is refused. The same Windows history opened on Mac must remain historical.
4. Close and reopen the candidate using the same temporary profile. Confirm it reuses native history. Open the baseline using its own legacy profile and verify its history still works. New native scans do not merge back into the legacy database on downgrade.
5. Run the existing history tests for committed WAL import, v0/v1/v2/v3 migration, collision/future-version refusal, invalid final preservation, concurrent initialization and interruption before atomic install. Retain each failure result as evidence, not as a successful empty history.

Completion requires preserved source hashes, preserved historical IDs/rules/query results and a successful candidate reopen. Keep copied private paths and scan content out of commits, screenshots and public reports.

## Verify app auto mode and UAC profile preservation

Use a fresh temporary profile for these checks. Build the app first. Inspect candidate startup and elevation code to confirm `--user-data-dir` survives every relaunch. Keep `DISK_WATCH_VERIFY` unset for MFT assertions, because that verification mode forces walk.

Open a separate **ordinary, unelevated PowerShell terminal** in the dedicated test desktop after the elevated benchmark. This command asserts that it is unelevated, allocates its own profile (including spaces to test quoting), and launches only the candidate source build:

```powershell
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
if ($Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Use a separate ordinary terminal for this first launch' }
Set-Location 'ABSOLUTE_CANDIDATE_CHECKOUT'
$env:DISK_WATCH_VERIFY = $null
$env:ELECTRON_RUN_AS_NODE = $null
$TestProfile = Join-Path $env:TEMP ('disk watch uac ' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $TestProfile | Out-Null
& .\node_modules\electron\dist\electron.exe . "--user-data-dir=$TestProfile"
```

Replace only `ABSOLUTE_CANDIDATE_CHECKOUT` with the recorded candidate worktree path. The explicit profile is mandatory. Verify the process/profile inside the app or debugger before adding any fixture.

In the dedicated session, launch the development Electron executable directly without elevation using the built checkout and an explicit temporary `--user-data-dir`. Do not use `vp run app` for the initial unelevated step because it starts elevated. Add only an owned NTFS fixture root, save a hide/exclusion and scan once. Record the profile path, root ID and scan ID. Choose **Restart as administrator**, approve its UAC prompt in the test session, then confirm:

- The elevated copy uses exactly the same temporary profile and preserves the saved root, history and rule revision. No default installed profile was opened or changed.
- The app's actual auto scan reports `method === 'mft'` with null fallback in saved SQLite scan rows, rather than relying on an elevation badge or successful GUI completion.
- A new scan adds history to the same root. A declined UAC prompt reports failure without moving to another profile or losing the current data. Retry elevation, approve it and confirm the same profile and IDs again.

Separately exercise the source launcher with an explicit profile, for example `vp exec node scripts/start-app.mjs -- --user-data-dir=ABSOLUTE_TEMP_PROFILE`. Confirm argument quoting for a profile path containing spaces, and inspect the actual launched process/profile. Test the packaged executable's restart path with another temporary profile. Never replace an installed user application to perform these checks.

Use Space, Changes, Treemap, hide/exclude editing, Undo, keyboard context menus and deletion failure details on fixtures. Assert auto-mode MFT separately from the existing GUI script, which deliberately selects walk. Capture visible screenshots only in the dedicated graphical session. Failure reports must retain the selected path, exact failed operation, native Windows error, lock-holder PID/name where available, selectable values and copy actions. Finish by releasing fixture locks and closing only test-owned windows/processes.

## Verify packaging and installation without replacement

Inspect the Windows workflow and packaging scripts at the candidate commit, then run the existing Windows GUI verification and packaged verification in the isolated session. Run `ready` only after inspecting its complete command tree and confirming every GUI step uses that session.

Inside the isolated Windows session, run the candidate commands below, checking every exit. These commands launch Electron during verification. Baseline uses `vp run verify` and `vp run verify:packaged`, which are also retained aliases in the candidate.

```powershell
Set-Location $Candidate
vp run verify:windows
if ($LASTEXITCODE -ne 0) { throw 'Windows GUI fixture verification failed' }
vp run dist:win
if ($LASTEXITCODE -ne 0) { throw 'NSIS/unpacked build failed' }
vp run verify:packaged:windows
if ($LASTEXITCODE -ne 0) { throw 'Packaged fixture verification failed' }
```

Build the NSIS installer and unpacked app. Verify the bundled scanner runs from outside ASAR, static CRT linkage remains configured, icon/startup identity is correct and the unpacked executable uses an explicit temporary profile. The original packaged verification also forces walk, so retain the separate elevated packaged auto-mode MFT result.

If testing installer/UAC behavior, use a disposable Windows test account or VM and a new installation directory. Check per-user installation, Start entry, no unwanted desktop shortcut and no automatic launch. Do not replace, upgrade, uninstall or redirect the human's installed application. After installation, launch the test copy with another explicit temporary profile, verify bundled scanning, then remove only that test installation through its normal uninstaller.

## Report and cleanup

Check the final integration PR's latest Windows CI results after all fixes land. A child branch check or an earlier successful run does not establish the final candidate. Report each gate as passed, failed or pending with its exact command, commit, method and evidence location. Include original Windows suite results, elevated CLI and app MFT results, baseline/candidate performance, junction/lock/read-only outcomes, import preservation, UAC profile continuity, static CRT and NSIS/package evidence. State explicitly when native memory, symbolic-link policy, GUI isolation or actual elevated execution was unavailable. Any required pending gate keeps Windows release approval pending.

Review reports and screenshots for private hostnames, accounts, paths and file content before publishing. Keep raw profiles and representative measurements in the private audit directory. Remove the two worktrees through `git worktree remove` only after their test-owned processes have exited and required artifacts have been saved. Clean up only named directories and installations created by this run. The representative root and the original application/profile remain outside cleanup.

A completion report should include this table and link to private evidence. Do not merge the PR or replace the installed app as part of verification.

| Gate | Passed / failed / pending | Commit, command and evidence |
| --- | --- | --- |
| Original Windows TS + Rust suites and typecheck | | |
| Elevated forced CLI MFT and null fallback | | |
| App auto-mode MFT before/after UAC | | |
| UAC cancellation, retry and same temporary profile | | |
| Baseline/candidate representative correctness and performance budget | | |
| Native scanner peak working set measured separately | | |
| Junction, link, locked/read-only deletion fixtures and sentinels | | |
| Copied legacy import, IDs/rules/queries, source hashes and reopen | | |
| GUI, bundled scanner, NSIS and static CRT | | |
| Latest final-integration Windows CI | | |
