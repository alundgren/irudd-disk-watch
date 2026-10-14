import { spawn } from 'node:child_process'
import { join } from 'node:path'

export async function holdFile(path: string) {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-File', join(import.meta.dirname, 'hold-file.ps1')],
    {
      windowsHide: true,
      env: { ...process.env, DISK_WATCH_LOCK_PATH: path },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('File lock fixture did not start.')), 10_000)
      let stderr = ''
      child.stderr.setEncoding('utf8').on('data', (data: string) => (stderr += data))
      child.stdout.setEncoding('utf8').on('data', (data: string) => {
        if (data.includes('LOCK_READY')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', () => {
        clearTimeout(timer)
        reject(new Error(`File lock fixture exited: ${stderr}`))
      })
    })
  } catch (error) {
    child.kill()
    await closed
    throw error
  }
  return {
    pid: child.pid!,
    release: async () => {
      child.stdin.end('\n')
      await closed
    },
  }
}
