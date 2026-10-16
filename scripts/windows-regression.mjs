import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const BASELINE = '878498541b42e7eba0c17474f63d8912a240bd0b'
const MB = 1024 * 1024
const help = `Usage: node scripts/windows-regression.mjs --baseline CHECKOUT --candidate CHECKOUT [--root FOLDER] [--rounds 3] [--warmups 1] [--timeout-ms 300000]

Run from an already elevated Windows terminal with Node 24.21+ and both release scanners built.
Scans only. The default fixture and all databases belong to a fresh temporary directory.
--root selects an existing, quiescent NTFS folder for read-only scans; it is never removed.
Each variant runs a direct CLI MFT scan and two MFT scans through its own runScan/Store.
Warmups and measured rounds alternate baseline/candidate order. JSON goes to stdout.
No GUI, elevation prompt, installation, deletion request, or cache flushing is performed.`

function git(checkout, args) {
  const result = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, `Git inspection failed: ${result.stderr || result.error?.message}`)
  return result.stdout.trim()
}

function checkedCheckout(input, pinned) {
  const checkout = realpathSync(resolve(input))
  const commit = git(checkout, ['rev-parse', 'HEAD'])
  if (pinned) assert.equal(commit, BASELINE, 'Baseline must be the exact pinned commit.')
  assert.equal(
    git(checkout, ['status', '--porcelain', '--untracked-files=no']),
    '',
    'Commit or discard tracked edits before comparing.',
  )
  const scannerExe = join(checkout, 'scanner', 'target', 'release', 'dw-scan.exe')
  for (const file of [scannerExe, join(checkout, 'src', 'main', 'scan.ts'), join(checkout, 'src', 'main', 'store.ts')])
    assert.ok(statSync(file).isFile(), 'Build both release scanners and use complete checkouts.')
  return {
    checkout,
    commit,
    scannerExe,
    scannerSha256: createHash('sha256').update(readFileSync(scannerExe)).digest('hex'),
  }
}

function validDone(done) {
  assert.ok(done && done.t === 'done', 'Scanner did not report completion.')
  assert.equal(done.method, 'mft', 'MFT is required. A walk fallback cannot pass this check.')
  assert.equal(done.fallback, null, 'An MFT run must not report a fallback.')
  for (const field of ['size', 'files', 'dirs', 'errors', 'ms'])
    assert.ok(Number.isSafeInteger(done[field]) && done[field] >= 0, `Invalid scanner total: ${field}`)
  assert.equal(done.errors, 0, 'Use an accessible, quiescent fixture with no scan errors.')
  return { size: done.size, files: done.files, dirs: done.dirs, errors: done.errors }
}

async function cli(job) {
  const started = performance.now()
  const child = spawn(job.scannerExe, [job.root, '--method', 'mft', '--min-file-size', String(MB)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = '',
    done,
    records = 0
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-65536)
  })
  const exited = new Promise((accept, reject) => {
    child.once('error', reject)
    child.once('close', (code) => accept(code))
  })
  void exited.catch(() => {})
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      assert.equal(done, undefined, 'Unexpected scanner output after completion.')
      const record = JSON.parse(line)
      if (record.t === 'done') done = record
      else if (['dir', 'file', 'rest'].includes(record.t)) records++
      else assert.ok(['progress', 'error'].includes(record.t), 'Unexpected scanner record.')
    }
    assert.equal(await exited, 0, `Scanner failed. Local diagnostic: ${stderr}`)
    return { totalMs: performance.now() - started, scannerMs: done?.ms, totals: validDone(done), entryRows: records }
  } finally {
    if (child.exitCode === null) child.kill()
    await exited.catch(() => {})
  }
}

async function sqlite(job) {
  const { runScan } = await import(pathToFileURL(join(job.checkout, 'src', 'main', 'scan.ts')).href)
  const { openDb, Store } = await import(pathToFileURL(join(job.checkout, 'src', 'main', 'store.ts')).href)
  const dbFile = join(job.scratch, 'history.db')
  const store = new Store(openDb(dbFile))
  const disk = store.addDisk(job.root)
  const scans = []
  try {
    for (let index = 0; index < 2; index++) {
      const started = performance.now()
      const outcome = await runScan({
        store,
        scannerExe: job.scannerExe,
        diskId: disk.id,
        minFileSize: MB,
        method: 'mft',
        signal: new AbortController().signal,
        onProgress() {},
      })
      const totalMs = performance.now() - started
      assert.equal(outcome.status, 'complete', `Scan failed. Local diagnostic: ${outcome.message}`)
      const scan = store.listScans(disk.id).find((row) => row.id === outcome.scanId)
      const totals = validDone({ ...scan, t: 'done', ms: scan.durationMs })
      if (scan.coverage !== undefined) assert.equal(scan.coverage, 'complete')
      const entryRows = store.db.prepare('SELECT count(*) AS count FROM entry WHERE scan_id=?').get(scan.id).count
      scans.push({ scanId: scan.id, totalMs, scannerMs: scan.durationMs, totals, entryRows })
    }
    assert.deepEqual(scans[0].totals, scans[1].totals, 'The selected root changed between scans.')
    assert.equal(scans[0].entryRows, scans[1].entryRows, 'Captured entries changed between scans.')
    const started = performance.now()
    store.compare(scans[0].scanId, scans[1].scanId)
    const compareMs = performance.now() - started
    const databaseBytes = [dbFile, `${dbFile}-wal`].reduce(
      (sum, file) => sum + (existsSync(file) ? statSync(file).size : 0),
      0,
    )
    return { scans, compareMs, databaseBytes }
  } finally {
    store.db.close()
  }
}

async function worker() {
  const job = JSON.parse(process.env.DISK_WATCH_REGRESSION_JOB ?? 'null')
  assert.ok(job && ['cli', 'sqlite'].includes(job.mode), 'Missing internal comparison job.')
  const result = await (job.mode === 'cli' ? cli(job) : sqlite(job))
  console.log(JSON.stringify({ ...result, nodePeakRssKiB: process.resourceUsage().maxRSS, nativePeakRssKiB: null }))
}

async function runWorker(job, timeoutMs) {
  return await new Promise((accept, reject) => {
    const env = { ...process.env, DISK_WATCH_REGRESSION_JOB: JSON.stringify(job) }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(process.execPath, [import.meta.filename, '--worker'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = '',
      stderr = '',
      settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.removeListener('SIGINT', interrupted)
      process.removeListener('SIGTERM', interrupted)
      if (error) reject(error)
      else accept(result)
    }
    const terminateTree = () => {
      if (settled || !child.pid || child.exitCode !== null) return null
      return spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      }).status
    }
    const interrupted = () =>
      finish(new Error(`Comparison interrupted; owned process-tree termination status ${terminateTree()}.`))
    process.once('SIGINT', interrupted)
    process.once('SIGTERM', interrupted)
    const timer = setTimeout(() => {
      finish(
        new Error(
          `Comparison timed out; owned process-tree termination status ${terminateTree()}. Inspect local processes before retrying.`,
        ),
      )
    }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > MB)
        finish(
          new Error(
            `Comparison result exceeded its output limit; owned process-tree termination status ${terminateTree()}.`,
          ),
        )
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-65536)
    })
    child.once('error', (error) => finish(error))
    child.once('close', (code) => {
      if (code !== 0) return finish(new Error(`Comparison failed. Local diagnostic: ${stderr}`))
      try {
        finish(null, JSON.parse(stdout))
      } catch (error) {
        finish(error)
      }
    })
  })
}

function comparison(runs) {
  const fields = {
    cli: { totalMs: (r) => r.totalMs, scannerMs: (r) => r.scannerMs, nodePeakRssKiB: (r) => r.nodePeakRssKiB },
    sqlite: {
      firstScanTotalMs: (r) => r.scans[0].totalMs,
      repeatScanTotalMs: (r) => r.scans[1].totalMs,
      firstScannerMs: (r) => r.scans[0].scannerMs,
      repeatScannerMs: (r) => r.scans[1].scannerMs,
      compareMs: (r) => r.compareMs,
      databaseBytes: (r) => r.databaseBytes,
      nodePeakRssKiB: (r) => r.nodePeakRssKiB,
    },
  }
  const summarize = (values) => {
    values.sort((a, b) => a - b)
    const mid = Math.floor(values.length / 2)
    return {
      min: values[0],
      median: values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2,
      max: values.at(-1),
    }
  }
  return Object.fromEntries(
    Object.entries(fields).map(([mode, metrics]) => [
      mode,
      Object.fromEntries(
        Object.entries(metrics).map(([name, read]) => {
          const baseline = summarize(
            runs.filter((r) => !r.warmup && r.mode === mode && r.variant === 'baseline').map(read),
          )
          const candidate = summarize(
            runs.filter((r) => !r.warmup && r.mode === mode && r.variant === 'candidate').map(read),
          )
          return [
            name,
            {
              baseline,
              candidate,
              candidateToBaselineMedianRatio: baseline.median ? candidate.median / baseline.median : null,
            },
          ]
        }),
      ),
    ]),
  )
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(help)
    return
  }
  assert.equal(process.platform, 'win32', 'This elevated MFT comparison runs only on Windows. Use --help elsewhere.')
  if (args.length === 1 && args[0] === '--worker') return await worker()
  const [major, minor] = process.versions.node.split('.').map(Number)
  assert.ok(major > 24 || (major === 24 && minor >= 21), 'Use the project Node runtime, version 24.21 or newer.')
  const options = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1]
    assert.ok(
      ['--baseline', '--candidate', '--root', '--rounds', '--warmups', '--timeout-ms'].includes(key) &&
        value &&
        !options.has(key),
      help,
    )
    options.set(key, value)
  }
  assert.ok(options.has('--baseline') && options.has('--candidate'), help)
  const rounds = Number(options.get('--rounds') ?? 3),
    warmups = Number(options.get('--warmups') ?? 1)
  const timeoutMs = Number(options.get('--timeout-ms') ?? 300000)
  assert.ok(Number.isSafeInteger(rounds) && rounds >= 3 && rounds <= 20, 'Use 3 to 20 measured rounds.')
  assert.ok(Number.isSafeInteger(warmups) && warmups >= 1 && warmups <= 5, 'Use 1 to 5 warmup rounds.')
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 3600000, 'Invalid subprocess timeout.')
  const variants = {
    baseline: checkedCheckout(options.get('--baseline'), true),
    candidate: checkedCheckout(options.get('--candidate'), false),
  }
  assert.notEqual(
    variants.baseline.checkout.toLowerCase(),
    variants.candidate.checkout.toLowerCase(),
    'Use separate checkouts.',
  )
  assert.notEqual(
    variants.baseline.commit,
    variants.candidate.commit,
    'Candidate must be the PR revision, not the baseline commit.',
  )
  const sandbox = mkdtempSync(join(tmpdir(), 'dw-windows-regression-'))
  try {
    let root
    if (options.has('--root')) {
      assert.ok(isAbsolute(options.get('--root')), 'Pass an explicit absolute NTFS folder.')
      root = realpathSync(options.get('--root'))
      assert.ok(statSync(root).isDirectory(), 'The representative root must be a directory.')
      for (const protectedPath of [sandbox, variants.baseline.checkout, variants.candidate.checkout]) {
        const child = relative(root, protectedPath)
        assert.ok(
          child.startsWith('..' + sep) || child === '..' || isAbsolute(child),
          'Select a representative folder outside the audit scratch directory and both checkouts. Scanning their parent would include changing test databases/builds.',
        )
      }
    } else {
      root = join(sandbox, 'fixture')
      mkdirSync(join(root, 'nested', 'cache'), { recursive: true })
      writeFileSync(join(root, 'nested', 'video.bin'), Buffer.alloc(4 * MB, 17))
      for (let index = 0; index < 128; index++)
        writeFileSync(join(root, 'nested', 'cache', `small-${index}.bin`), Buffer.alloc(4096, index))
    }
    const report = {
      baselineCommit: variants.baseline.commit,
      candidateCommit: variants.candidate.commit,
      baselineScannerSha256: variants.baseline.scannerSha256,
      candidateScannerSha256: variants.candidate.scannerSha256,
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      rootKind: options.has('--root') ? 'operator-selected-read-only-folder' : 'owned-fixture',
      rounds,
      warmups,
      memoryNote: 'Node child peak RSS only. Scanner native RSS is unmeasured. No cold-cache claim.',
      runs: [],
    }
    let expected = options.has('--root')
      ? undefined
      : { totals: { size: 4 * MB + 128 * 4096, files: 129, dirs: 3, errors: 0 }, entryRows: 5 }
    for (let round = 0; round < rounds + warmups; round++) {
      const order = round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
      for (const mode of ['cli', 'sqlite'])
        for (const variant of order) {
          const scratch = join(sandbox, `${round}-${mode}-${variant}`)
          mkdirSync(scratch)
          const metrics = await runWorker({ ...variants[variant], root, scratch, mode }, timeoutMs)
          const observations = mode === 'cli' ? [metrics] : metrics.scans
          for (const observed of observations) {
            const correctness = { totals: observed.totals, entryRows: observed.entryRows }
            if (expected)
              assert.deepEqual(
                correctness,
                expected,
                'Baseline/candidate CLI and SQLite observations differ. Quiesce the root and investigate.',
              )
            else expected = correctness
          }
          report.runs.push({ round, warmup: round < warmups, variant, mode, ...metrics })
        }
    }
    report.comparison = comparison(report.runs)
    console.log(JSON.stringify(report, null, 2))
  } finally {
    // Only this mkdtemp directory is removed. An operator-selected root is never removed.
    rmSync(sandbox, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
