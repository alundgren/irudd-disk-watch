import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, test as platformTest, vi } from 'vite-plus/test'
import { installRemoteScanner, remoteInstallScript } from './sshInstall'

vi.mock('node:child_process', { spy: true })

const docker = process.env.DISK_WATCH_TEST_SSH_DOCKER === '1'
const test = process.platform === 'linux' || docker ? platformTest : platformTest.skip
const candidate = Buffer.from(`#!/bin/sh
printf '%s\\n' '{"t":"hello","v":1,"requestId":"install","worker":{"id":"fixture","account":"fixture","os":"linux","version":1,"capabilities":{"scan":true,"delete":true,"linuxPathTrust":true}}}'
printf '%s\\n' '{"t":"result","value":{"id":"fixture","account":"fixture","os":"linux","version":1,"capabilities":{"scan":true,"delete":true,"linuxPathTrust":true}}}'
`)
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function fixture({ old = false, badDigest = false, activate = true, setup = '' } = {}) {
  const home = docker ? '/home/disk-watch-test' : mkdtempSync(join(homedir(), '.disk-watch-ssh-test-'))
  const oldBytes = Buffer.from('previous scanner')
  const script = `
mkdir -p -m 700 "$HOME/.local/share/disk-watch"
${old ? `printf 'previous scanner' > "$HOME/.local/share/disk-watch/worker-v1"` : ''}
${setup}
(
${remoteInstallScript(process.arch === 'arm64' ? 'arm64' : 'x64', candidate.length, badDigest ? '0'.repeat(64) : digest(candidate), old ? digest(oldBytes) : null)}
)
code=$?
if [ -f "$HOME/.local/share/disk-watch/worker-v1" ]; then
  hash=$(sha256sum "$HOME/.local/share/disk-watch/worker-v1"); printf 'AFTER:%s\\n' "\${hash%% *}"
fi
if [ -f "$HOME/.local/share/disk-watch/worker-v1.previous" ]; then
  hash=$(sha256sum "$HOME/.local/share/disk-watch/worker-v1.previous"); printf 'BACKUP:%s\\n' "\${hash%% *}"
fi
exit "$code"
`
  const child = docker
    ? spawn('docker', [
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '--env',
        `HOME=${home}`,
        'node:24-bookworm-slim',
        'sh',
        '-c',
        script,
      ])
    : spawn('sh', ['-c', script], { env: { ...process.env, HOME: home } })
  let output = ''
  let errors = ''
  let approved = false
  child.stdin.on('error', () => {})
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString()
  })
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
    if (output.includes('DW_READY') && !approved) {
      approved = true
      child.stdin.end(activate ? 'activate\n' : 'reject\n')
    }
  })
  const timer = setTimeout(() => child.kill(), 20_000)
  child.stdin.write(candidate)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    return { code, output, errors, oldHash: digest(oldBytes) }
  } finally {
    clearTimeout(timer)
    if (!docker) rmSync(home, { recursive: true, force: true })
  }
}

test('verified transfer activates atomically and keeps the previous executable', async () => {
  const result = await fixture({ old: true })
  expect(result.code, result.errors).toBe(0)
  expect(result.output).toContain('DW_READY')
  expect(result.output).toContain('DW_INSTALLED')
  expect(result.output).toContain(`AFTER:${digest(candidate)}`)
  expect(result.output).toContain(`BACKUP:${result.oldHash}`)
})

test('a corrupt transfer preserves the installed executable', async () => {
  const result = await fixture({ old: true, badDigest: true })
  expect(result.code).not.toBe(0)
  expect(result.errors).toContain('checksum does not match')
  expect(result.output).toContain(`AFTER:${result.oldHash}`)
  expect(result.output).not.toContain('DW_READY')
})

test('the controller can reject candidate identity without replacing the worker', async () => {
  const result = await fixture({ old: true, activate: false })
  expect(result.code).not.toBe(0)
  expect(result.output).toContain(`AFTER:${result.oldHash}`)
  expect(result.output).not.toContain('DW_INSTALLED')
})

test('symbolic-link targets are rejected before transfer', async () => {
  const result = await fixture({ setup: 'ln -s /outside "$HOME/.local/share/disk-watch/worker-v1"' })
  expect(result.code).not.toBe(0)
  expect(result.errors).toContain('symbolic link')
  expect(result.output).not.toContain('DW_READY')
})

test('a concurrent installation retains the existing executable', async () => {
  const result = await fixture({ old: true, setup: 'exec 8>"$HOME/.local/share/disk-watch/.install.lock"; flock -n 8' })
  expect(result.code).not.toBe(0)
  expect(result.errors).toContain('Another scanner installation is running')
  expect(result.output).toContain(`AFTER:${result.oldHash}`)
})

test('a scanner changed after the probe is not overwritten', async () => {
  const result = await fixture({ old: true, setup: 'printf changed > "$HOME/.local/share/disk-watch/worker-v1"' })
  expect(result.code).not.toBe(0)
  expect(result.errors).toContain('installed scanner changed')
  expect(result.output).toContain(`AFTER:${digest(Buffer.from('changed'))}`)
})

platformTest('installer arguments cannot inject shell code or select unbounded payloads', () => {
  expect(() => remoteInstallScript('x64', 0, digest(candidate), null)).toThrow()
  expect(() => remoteInstallScript('x64', 2 ** 30, digest(candidate), null)).toThrow()
  expect(() => remoteInstallScript('x64', 1, '; echo unsafe', null)).toThrow()
})

platformTest('a changed worker identity is rejected before activation is sent', async () => {
  const actualSpawn = spawn
  vi.mocked(spawn).mockImplementationOnce(() =>
    actualSpawn(
      process.execPath,
      [
        '-e',
        `
    const worker = {id:'different',account:'fixture',os:'linux',version:1,capabilities:{scan:true,delete:true,linuxPathTrust:true}};
    process.stdin.resume();
    console.log(JSON.stringify({t:'hello',v:1,requestId:'install',worker}));
    console.log(JSON.stringify({t:'result',value:worker}));
    console.log('DW_READY');
    setInterval(()=>{},1000);
  `,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    ),
  )
  await expect(
    installRemoteScanner(
      {
        id: 'saved',
        kind: 'ssh',
        os: 'linux',
        name: 'Fixture',
        destination: 'fixture',
        workerId: 'original',
        account: 'fixture',
      },
      { arch: 'x64', sha256: null },
      candidate,
    ),
  ).rejects.toThrow('Worker identity changed')
})
