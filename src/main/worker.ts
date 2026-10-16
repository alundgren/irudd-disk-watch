import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Machine, WorkerInfo } from '../shared/types'
import {
  decodeFrame,
  framedLines,
  MAX_DIAGNOSTIC_BYTES,
  MAX_FRAME_BYTES,
  type WorkerFrame,
} from '../shared/workerProtocol.ts'

export interface WorkerConnection {
  machine: Machine
  scannerExe: string
  stateDir?: string
}

/** Linux workers built before per-folder trust checks refuse most real roots, such as `/`. */
export const LINUX_WORKER_UPDATE =
  'The Linux worker on this machine is out of date, so deletion is unavailable. Update the worker (see "Update the Linux worker" in the README), then try again.'

export type WorkerOperation =
  'hello' | 'volumes' | 'inspect' | 'resolve' | 'scan' | 'cleanup' | 'delete' | 'deleteStatus'

export function sshArguments(destination: string): string[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,252}$/.test(destination))
    throw new Error('Choose an SSH configuration alias or user@host without options.')
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'UpdateHostKeys=no',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'RemoteCommand=none',
    '-o',
    'ConnectTimeout=8',
    '-o',
    'ConnectionAttempts=1',
    '-o',
    'ServerAliveInterval=10',
    '-o',
    'ServerAliveCountMax=3',
    destination,
    'exec "$HOME/.local/share/disk-watch/worker-v1" --worker',
  ]
}

export function workerCommand(connection: WorkerConnection): { executable: string; args: string[] } {
  const { machine, scannerExe, stateDir } = connection
  if (machine.kind === 'historical') throw new Error('This machine is historical. Its scans remain available offline.')
  if (machine.kind === 'ssh') {
    if (!machine.destination) throw new Error('Missing SSH destination.')
    return {
      executable:
        process.platform === 'win32'
          ? join(process.env.WINDIR || 'C:\\Windows', 'System32/OpenSSH/ssh.exe')
          : '/usr/bin/ssh',
      args: sshArguments(machine.destination),
    }
  }
  return { executable: scannerExe, args: ['--worker', ...(stateDir ? ['--state-dir', stateDir] : [])] }
}

/** One owned subprocess per operation. Stdin remains a live control channel. */
export async function* workerFrames(
  connection: WorkerConnection,
  op: WorkerOperation,
  parameters: Record<string, unknown> = {},
  signal?: AbortSignal,
): AsyncGenerator<Exclude<WorkerFrame, { t: 'hello' }>> {
  if (signal?.aborted) throw new Error('Cancelled')
  const { machine } = connection
  const requestId = randomUUID()
  const expectedWorker =
    machine.workerId && machine.account ? { id: machine.workerId, account: machine.account } : undefined
  if (op !== 'hello' && !expectedWorker) throw new Error('Inspect and bind the worker identity before live operations.')
  const request =
    JSON.stringify({ ...parameters, v: 1, requestId, op, ...(expectedWorker ? { expectedWorker } : {}) }) + '\n'
  if (Buffer.byteLength(request) > MAX_FRAME_BYTES) throw new Error('Worker request exceeds its size limit.')
  const command = workerCommand(connection)
  const child = spawn(command.executable, command.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  })
  let diagnostic = Buffer.alloc(0)
  let inputError: Error | undefined
  child.stdin.on('error', (error) => {
    inputError = error
  })
  child.stderr.on('data', (chunk: Buffer) => {
    if (diagnostic.length < MAX_DIAGNOSTIC_BYTES)
      diagnostic = Buffer.concat([diagnostic, chunk.subarray(0, MAX_DIAGNOSTIC_BYTES - diagnostic.length)])
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  // Attach immediately so a failed spawn cannot become an unhandled rejection.
  void exited.catch(() => {})
  const control = (operation: 'ping' | 'cancel') => {
    if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ op: operation, requestId }) + '\n')
  }
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    control('cancel')
    child.stdin.end()
    killTimer ??= setTimeout(() => child.kill(), 3000)
    killTimer.unref()
  }
  signal?.addEventListener('abort', cancel, { once: true })
  const heartbeat = setInterval(() => control('ping'), 5000)
  heartbeat.unref()
  const deadline = op === 'scan' || op === 'delete' ? undefined : setTimeout(cancel, 30_000)
  deadline?.unref()
  let sawHello = false
  let terminal = false
  try {
    child.stdin.write(request)
    if (signal?.aborted) cancel()
    for await (const line of framedLines(child.stdout)) {
      if (terminal) throw new Error('Worker sent data after its terminal record.')
      const frame = decodeFrame(line, machine.os !== 'windows')
      if (frame.t === 'hello') {
        if (sawHello || frame.requestId !== requestId || frame.worker.os !== machine.os)
          throw new Error('Worker handshake does not match the requested machine or operation.')
        if (
          expectedWorker &&
          (frame.worker.id !== expectedWorker.id || frame.worker.account !== expectedWorker.account)
        )
          throw new Error('Worker identity changed. Reconnect deliberately before continuing.')
        if (op === 'scan' && !frame.worker.capabilities.scan) throw new Error('This worker cannot scan.')
        if (op === 'delete' && !frame.worker.capabilities.delete)
          throw new Error('This worker does not support cleanup.')
        if (
          frame.worker.os === 'linux' &&
          !frame.worker.capabilities.linuxPathTrust &&
          (op === 'delete' || (op === 'cleanup' && parameters.enabled === true))
        )
          throw new Error(LINUX_WORKER_UPDATE)
        sawHello = true
        continue
      }
      if (!sawHello) throw new Error('Missing worker handshake.')
      if (frame.t === 'fatal') throw new Error(frame.message)
      terminal = frame.t === 'result' || frame.t === 'done'
      yield frame
    }
    const code = await exited
    if (signal?.aborted) throw new Error('Cancelled')
    if (!sawHello || !terminal || code !== 0)
      throw new Error(
        diagnostic.toString('utf8').trim() ||
          inputError?.message ||
          `Worker did not complete successfully, exit ${code}.`,
      )
  } finally {
    clearInterval(heartbeat)
    if (deadline) clearTimeout(deadline)
    signal?.removeEventListener('abort', cancel)
    if (!child.stdin.destroyed) child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) {
      const timeout = setTimeout(() => child.kill(), 3000)
      timeout.unref()
      try {
        await exited
      } catch {
        /* The original spawn/stream error is retained. */
      }
      clearTimeout(timeout)
    }
    if (killTimer) clearTimeout(killTimer)
  }
}

export async function workerOperation(
  connection: WorkerConnection,
  op: Exclude<WorkerOperation, 'scan'>,
  parameters: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  let result: unknown
  let complete = false
  for await (const frame of workerFrames(connection, op, parameters, signal)) {
    if (frame.t !== 'result') throw new Error('Unexpected worker operation response.')
    result = frame.value
    complete = true
  }
  if (!complete) throw new Error('Missing worker operation result.')
  return result
}

export function bindWorker(machine: Machine, worker: WorkerInfo): Machine {
  if (worker.os !== machine.os) throw new Error('Worker OS does not match this machine.')
  if (machine.workerId && (worker.id !== machine.workerId || worker.account !== machine.account))
    throw new Error('Worker identity changed. Existing history has not been reassigned.')
  return { ...machine, workerId: worker.id, account: worker.account }
}
