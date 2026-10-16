import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test as platformTest } from 'vite-plus/test'
import { LINUX_WORKER_UPDATE, sshArguments, workerOperation } from './worker'

const test = process.platform === 'win32' ? platformTest.skip : platformTest
const owned: string[] = []
afterEach(() => {
  for (const directory of owned.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function connection(mode: string) {
  const directory = mkdtempSync(join(tmpdir(), 'disk-watch-transport-test-'))
  owned.push(directory)
  const scannerExe = join(directory, 'worker')
  writeFileSync(
    scannerExe,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
const mode = ${JSON.stringify(mode)};
const worker = {id:'fixture-worker',account:'fixture-account',os:'linux',version:1,capabilities:mode === 'old-linux' ? {scan:true,delete:true} : {scan:true,delete:true,linuxPathTrust:true}};
createInterface({input:process.stdin}).once('line', (line) => {
 const request = JSON.parse(line);
 const send = (record) => process.stdout.write(JSON.stringify(record)+'\\n');
 if (mode !== 'no-hello') send({t:'hello',v:1,requestId:mode === 'wrong-request' ? 'different' : request.requestId,worker:{...worker,id:mode === 'changed-worker' ? 'changed' : worker.id}});
 if (mode === 'oversized') process.stdout.write('x'.repeat(4*1024*1024+1));
 else if (mode === 'truncated') process.stdout.write('{');
 else { send({t:'result',value:worker}); if (mode === 'after-terminal') send({t:'result',value:worker}); }
 process.stdout.end(() => process.exit(mode === 'failed-exit' ? 1 : 0));
});
`,
    { mode: 0o700 },
  )
  return {
    scannerExe,
    machine: {
      id: 'fixture',
      name: 'Fixture',
      kind: 'local' as const,
      os: 'linux' as const,
      workerId: 'fixture-worker',
      account: 'fixture-account',
    },
  }
}

test('transport requires a matching handshake, bounded complete frames, one terminal and a zero exit', async () => {
  await expect(workerOperation(connection('valid'), 'hello')).resolves.toMatchObject({ id: 'fixture-worker' })
  for (const mode of [
    'no-hello',
    'wrong-request',
    'changed-worker',
    'oversized',
    'truncated',
    'after-terminal',
    'failed-exit',
  ])
    await expect(workerOperation(connection(mode), 'hello')).rejects.toThrow()
})

test('a Linux worker without per-folder trust checks asks for an update before cleanup', async () => {
  await expect(workerOperation(connection('old-linux'), 'cleanup', { enabled: true })).rejects.toThrow(
    LINUX_WORKER_UPDATE,
  )
  await expect(workerOperation(connection('old-linux'), 'delete', {})).rejects.toThrow(LINUX_WORKER_UPDATE)
  // Turning cleanup off and other operations keep working with the older worker.
  await expect(workerOperation(connection('old-linux'), 'cleanup', { enabled: false })).resolves.toBeTruthy()
  await expect(workerOperation(connection('old-linux'), 'inspect')).resolves.toBeTruthy()
  await expect(workerOperation(connection('valid'), 'cleanup', { enabled: true })).resolves.toBeTruthy()
})

platformTest('SSH destination cannot supply shell or SSH options and the command is fixed', () => {
  for (const invalid of ['-oProxyCommand=bad', 'name;id', 'name root', '$(id)', 'user@host/path', ''])
    expect(() => sshArguments(invalid)).toThrow()
  expect(sshArguments('example-account@fixture-host').slice(-2)).toEqual([
    'example-account@fixture-host',
    'exec "$HOME/.local/share/disk-watch/worker-v1" --worker',
  ])
  expect(sshArguments('fixture-alias')).toContain('StrictHostKeyChecking=yes')
})
