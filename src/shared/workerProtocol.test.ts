import { expect, test } from 'vite-plus/test'
import { bytes, decodeFrame, framedLines, MAX_FRAME_BYTES, ScanSequence, type ScanLine } from './workerProtocol'

const root: ScanLine = {
  t: 'dir',
  id: 1,
  parent: null,
  name: 'fixture',
  size: 3,
  files: 1,
  createdAt: null,
  lastWrittenAt: 1000,
}
const leaf: ScanLine = { t: 'file', parent: 1, name: 'a', size: 3, createdAt: null, lastWrittenAt: 1000 }
const done: ScanLine = { t: 'done', size: 3, files: 1, dirs: 1, errors: 0, ms: 1, method: 'walk', fallback: null }

test('decoder rejects unsupported records, numeric loss, missing timestamps and ambiguous byte names', () => {
  for (const row of [
    { t: 'banner' },
    { ...leaf, size: Number.MAX_SAFE_INTEGER + 1 },
    { ...leaf, createdAt: undefined },
    { ...done, method: 'other' },
  ])
    expect(() => decodeFrame(JSON.stringify(row))).toThrow()
  for (const component of ['YQ', 'Lw==', 'AA==', 'Li4=', '', 'YQ==\n']) expect(() => bytes(component, true)).toThrow()
  expect(bytes(Buffer.from('literal\\name\n').toString('base64'), true)).toBe(
    Buffer.from('literal\\name\n').toString('base64'),
  )
})

test('scan completion requires unique ordered records and exact aggregate totals', () => {
  const sequence = new ScanSequence(false)
  for (const row of [root, leaf, done]) sequence.accept(row)
  expect(sequence.done).toBe(true)
  expect(() => sequence.accept(done)).toThrow(/after/)
  expect(() => new ScanSequence(false).accept(leaf)).toThrow(/parent/)
  for (const invalid of [
    { ...done, size: 4 },
    { ...done, files: 2 },
    { ...done, dirs: 2 },
  ]) {
    const candidate = new ScanSequence(false)
    candidate.accept(root)
    candidate.accept(leaf)
    expect(() => candidate.accept(invalid as ScanLine)).toThrow()
  }
  const duplicate = new ScanSequence(false)
  duplicate.accept(root)
  duplicate.accept(leaf)
  expect(() => duplicate.accept(leaf)).toThrow(/duplicate/)
})

test('framing handles split UTF-8 and rejects truncated, malformed, empty or oversized frames', async () => {
  const encoded = Buffer.from('{"name":"é"}\n')
  async function* chunks() {
    yield encoded.subarray(0, 10)
    yield encoded.subarray(10)
  }
  const lines = []
  for await (const line of framedLines(chunks())) lines.push(JSON.parse(line))
  expect(lines).toEqual([{ name: 'é' }])
  for (const input of [
    Buffer.from('partial'),
    Buffer.from('\n'),
    Buffer.from([0xff, 10]),
    Buffer.alloc(MAX_FRAME_BYTES + 1, 97),
  ]) {
    async function read() {
      for await (const _ of framedLines(
        (async function* () {
          yield input
        })(),
      )) {
        /* Consume bounded input. */
      }
    }
    await expect(read()).rejects.toThrow()
  }
})
