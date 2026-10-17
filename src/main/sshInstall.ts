import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Machine, WorkerInfo } from '../shared/types'
import { decodeFrame, framedLines, MAX_DIAGNOSTIC_BYTES, workerInfo } from '../shared/workerProtocol'
import { bindWorker, sshArguments, workerEnvironment, workerOperation } from './worker'

export interface RemoteScanner {
  arch: 'x64' | 'arm64'
  sha256: string | null
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const MAX_BINARY = 64 * 1024 * 1024

function command(destination: string, script: string) {
  const args = sshArguments(destination)
  args[args.length - 1] = `sh -c ${quote(script)}`
  return {
    executable:
      process.platform === 'win32'
        ? join(process.env.WINDIR || 'C:\\Windows', 'System32/OpenSSH/ssh.exe')
        : '/usr/bin/ssh',
    args,
  }
}

// Only account-owned, private installation files may be replaced. Parent directories
// may belong to root, but must not let another account redirect the installation.
export const remoteInstallChecks = `
set -eu
umask 077
fail() { echo "$1" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || fail 'SSH scanners require Linux.'
case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) fail 'This Linux CPU is not supported. Use x64 or ARM64.';; esac
kernel=$(uname -r)
major=\${kernel%%.*}; minor=\${kernel#*.}; minor=\${minor%%.*}
case "$major:$minor" in *[!0-9:]*) fail 'Could not determine the Linux kernel version.';; esac
[ "$major" -gt 4 ] || { [ "$major" -eq 4 ] && [ "$minor" -ge 14 ]; } || fail 'The scanner requires Linux 4.14 or later.'
[ -r /proc/self/mountinfo ] && [ -d /proc/self/fdinfo ] || fail 'The scanner requires a mounted /proc filesystem.'
uid=$(id -u)
case "$HOME" in /*) ;; *) fail 'The SSH account has no absolute home directory.';; esac
[ "$HOME" != / ] || fail 'The SSH home directory must not be /.'
check_directory() {
  [ ! -L "$1" ] && [ -d "$1" ] || fail 'An installation directory is a link or is not a directory.'
  owner=$(stat -c %u -- "$1")
  [ "$owner" = "$uid" ] || [ "$owner" = 0 ] || fail 'An installation directory belongs to another account.'
  mode=$(stat -c %a -- "$1")
  [ $((0$mode & 022)) -eq 0 ] || fail 'An installation directory is writable by another account.'
}
p=$HOME
while :; do check_directory "$p"; [ "$p" != / ] || break; p=\${p%/*}; [ -n "$p" ] || p=/; done
root="$HOME/.local/share/disk-watch"
for p in "$HOME/.local" "$HOME/.local/share" "$root"; do
  if [ -e "$p" ] || [ -L "$p" ]; then check_directory "$p"; fi
done
check_worker() {
  [ ! -L "$root/worker-v1" ] || fail 'The existing scanner is a symbolic link.'
  if [ -e "$root/worker-v1" ]; then
    [ -f "$root/worker-v1" ] && [ "$(stat -c %u -- "$root/worker-v1")" = "$uid" ] || fail 'The existing scanner is not an account-owned file.'
    mode=$(stat -c %a -- "$root/worker-v1")
    [ $((0$mode & 022)) -eq 0 ] || fail 'The existing scanner is writable by another account.'
    current=$(sha256sum -- "$root/worker-v1"); current=\${current%% *}
  else current=missing; fi
}
check_worker
`

export async function probeRemoteScanner(destination: string): Promise<RemoteScanner> {
  const script = `${remoteInstallChecks}\nprintf '%s\\n%s\\n' "$arch" "$current"`
  const invocation = command(destination, script)
  const child = spawn(invocation.executable, invocation.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: workerEnvironment(),
  })
  let output = ''
  let diagnostic = ''
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, 30_000)
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
    if (output.length > 4096) child.kill()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString('utf8')).slice(0, MAX_DIAGNOSTIC_BYTES)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                timedOut ? 'SSH scanner check timed out.' : diagnostic.trim() || 'Could not check the SSH scanner.',
              ),
            ),
      )
    })
    const rows = /^(x64|arm64)\n(missing|[0-9a-f]{64})\n$/.exec(output)
    if (!rows) throw new Error('The SSH scanner check returned an unexpected response.')
    return { arch: rows[1] as RemoteScanner['arch'], sha256: rows[2] === 'missing' ? null : rows[2]! }
  } finally {
    clearTimeout(timer)
  }
}

export function remoteInstallScript(
  arch: RemoteScanner['arch'],
  size: number,
  digest: string,
  previous: string | null,
) {
  if (
    !['x64', 'arm64'].includes(arch) ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_BINARY ||
    !/^[0-9a-f]{64}$/.test(digest) ||
    (previous !== null && !/^[0-9a-f]{64}$/.test(previous))
  )
    throw new Error('Invalid scanner installation payload.')
  return `${remoteInstallChecks}
[ "$arch" = ${quote(arch)} ] || fail 'The remote CPU changed. Check the connection and try again.'
for p in "$HOME/.local" "$HOME/.local/share" "$root"; do
  if [ ! -e "$p" ]; then mkdir -m 700 -- "$p"; fi
  check_directory "$p"
done
[ "$(stat -c %u -- "$root")" = "$uid" ] || fail 'The scanner directory must belong to this account.'
[ ! -L "$root/.install.lock" ] || fail 'The scanner installation lock is a symbolic link.'
if [ -e "$root/.install.lock" ]; then
  [ -f "$root/.install.lock" ] && [ "$(stat -c %u -- "$root/.install.lock")" = "$uid" ] && [ "$(stat -c %h -- "$root/.install.lock")" = 1 ] || fail 'The scanner lock is not a private account-owned file.'
fi
exec 9>"$root/.install.lock"
flock -n 9 || fail 'Another scanner installation is running. Try again when it finishes.'
check_worker
[ "$current" = ${quote(previous ?? 'missing')} ] || fail 'The installed scanner changed. Check it and try again.'
stage=$(mktemp -d "$root/.preparing.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
head -c ${size} > "$stage/worker"
[ "$(wc -c < "$stage/worker" | tr -d ' ')" = ${size} ] || fail 'The scanner transfer was interrupted.'
actual=$(sha256sum -- "$stage/worker"); actual=\${actual%% *}
[ "$actual" = ${quote(digest)} ] || fail 'The transferred scanner checksum does not match.'
chmod 700 "$stage/worker"
printf '%s\\n' '{"v":1,"requestId":"install","op":"hello"}' | "$stage/worker" --worker
printf 'DW_READY\\n'
IFS= read -r approval
[ "$approval" = activate ] || fail 'Scanner activation was not approved by the controller.'
check_worker
[ "$current" = ${quote(previous ?? 'missing')} ] || fail 'The installed scanner changed before activation.'
if [ "$current" != missing ]; then
  [ ! -L "$root/worker-v1.previous" ] || fail 'The scanner backup is a symbolic link.'
  [ ! -e "$root/worker-v1.previous" ] || [ -f "$root/worker-v1.previous" ] || fail 'The scanner backup is not a regular file.'
  cp -p -- "$root/worker-v1" "$stage/previous"
  mv -f -- "$stage/previous" "$root/worker-v1.previous"
fi
mv -f -- "$stage/worker" "$root/worker-v1"
printf 'DW_INSTALLED\\n'
`
}

/** The candidate must identify the same account/installation before any rename. */
export async function installRemoteScanner(
  machine: Machine,
  observed: RemoteScanner,
  binary: Buffer,
): Promise<WorkerInfo> {
  if (machine.kind !== 'ssh' || machine.os !== 'linux' || !machine.destination)
    throw new Error('Choose a Linux SSH machine.')
  const destination = machine.destination
  if (observed.sha256) {
    const prior = workerInfo(await workerOperation({ machine, scannerExe: '' }, 'hello'))
    machine = bindWorker(machine, prior)
  }
  const digest = createHash('sha256').update(binary).digest('hex')
  const invocation = command(destination, remoteInstallScript(observed.arch, binary.length, digest, observed.sha256))
  const child = spawn(invocation.executable, invocation.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: workerEnvironment(),
  })
  let diagnostic = ''
  let inputError: Error | undefined
  child.stdin.on('error', (error) => {
    inputError = error
  })
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString('utf8')).slice(0, MAX_DIAGNOSTIC_BYTES)
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  void exited.catch(() => {})
  const timer = setTimeout(() => child.kill(), 180_000)
  let candidate: WorkerInfo | undefined
  let hello: WorkerInfo | undefined
  let ready = false
  let installed = false
  try {
    child.stdin.write(binary)
    for await (const line of framedLines(child.stdout)) {
      if (line === 'DW_READY') {
        if (!hello || !candidate || ready) throw new Error('The candidate scanner did not complete its identity check.')
        bindWorker(machine, candidate)
        if (!candidate.capabilities.scan || !candidate.capabilities.linuxPathTrust)
          throw new Error('The candidate scanner lacks required capabilities.')
        ready = true
        child.stdin.end('activate\n')
      } else if (line === 'DW_INSTALLED') {
        if (!ready || installed) throw new Error('Unexpected scanner activation response.')
        installed = true
      } else {
        if (ready) throw new Error('Unexpected output after the candidate identity check.')
        const frame = decodeFrame(line, true)
        if (frame.t === 'hello' && !hello && frame.requestId === 'install' && frame.worker.os === 'linux') {
          bindWorker(machine, frame.worker)
          hello = frame.worker
        } else if (frame.t === 'result' && hello && !candidate) {
          candidate = workerInfo(frame.value)
          if (candidate.id !== hello.id || candidate.account !== hello.account || candidate.os !== hello.os)
            throw new Error('The candidate scanner returned conflicting identities.')
          bindWorker(machine, candidate)
        } else throw new Error(frame.t === 'fatal' ? frame.message : 'Unexpected candidate scanner handshake.')
      }
    }
    if ((await exited) !== 0 || !installed || !candidate)
      throw new Error(
        diagnostic.trim() || inputError?.message || 'Scanner installation did not finish. Check the scanner and retry.',
      )
    return candidate
  } finally {
    clearTimeout(timer)
    child.stdin.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited.catch(() => {})
  }
}

export async function synchronizeRemoteScanner(
  machine: Machine,
  loadVerifiedBinary: (arch: RemoteScanner['arch']) => Promise<Buffer>,
): Promise<{ machine: Machine; changed: boolean }> {
  if (machine.kind !== 'ssh' || !machine.destination || machine.os !== 'linux')
    throw new Error('Choose a Linux SSH destination.')
  const observed = await probeRemoteScanner(machine.destination)
  if (observed.sha256) {
    const prior = workerInfo(await workerOperation({ machine, scannerExe: '' }, 'hello'))
    machine = bindWorker(machine, prior)
  }
  const binary = await loadVerifiedBinary(observed.arch)
  if (observed.sha256 === createHash('sha256').update(binary).digest('hex')) return { machine, changed: false }
  const candidate = await installRemoteScanner(machine, observed, binary)
  machine = bindWorker(machine, candidate)
  const installed = workerInfo(await workerOperation({ machine, scannerExe: '' }, 'hello'))
  return { machine: bindWorker(machine, installed), changed: true }
}
