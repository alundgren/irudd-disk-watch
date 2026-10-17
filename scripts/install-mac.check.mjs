import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installBundle, replaceBundle, selectSigningIdentity } from './install-mac.mjs'

const mac = { skip: process.platform !== 'darwin' }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'disk-watch-install-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return realpathSync(root)
}

function bundle(path, identifier = 'com.irudd.diskwatch') {
  mkdirSync(join(path, 'Contents/MacOS'), { recursive: true })
  mkdirSync(join(path, 'Contents/Resources'), { recursive: true })
  writeFileSync(
    join(path, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
    <plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string></dict></plist>`,
  )
  for (const file of ['Contents/MacOS/Disk Watch', 'Contents/Resources/dw-scan'])
    writeFileSync(join(path, file), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
}

test(
  'install and reinstall replace the whole bundle without touching other files or launching the fixture',
  mac,
  async (t) => {
    const root = fixture(t)
    const source = join(root, 'Source with spaces.app')
    const directory = join(root, 'Applications')
    bundle(source)
    mkdirSync(directory)
    writeFileSync(join(directory, 'unrelated'), 'keep')
    const target = await installBundle(source, directory, { register: false })
    assert.equal(target, join(directory, 'Disk Watch.app'))
    assert.equal(
      readFileSync(join(target, 'Contents/Info.plist'), 'utf8'),
      readFileSync(join(source, 'Contents/Info.plist'), 'utf8'),
    )
    writeFileSync(join(target, 'obsolete'), 'old')
    writeFileSync(join(source, 'current'), 'new')
    await installBundle(source, directory, { register: false })
    assert.equal(existsSync(join(target, 'obsolete')), false)
    assert.equal(readFileSync(join(target, 'current'), 'utf8'), 'new')
    assert.equal(readFileSync(join(directory, 'unrelated'), 'utf8'), 'keep')
    assert.deepEqual(readdirSync(directory).sort(), ['.disk-watch-managed', 'Disk Watch.app', 'unrelated'])
  },
)

test('an incomplete source leaves the installed app intact', mac, async (t) => {
  const root = fixture(t)
  const source = join(root, 'source.app')
  const directory = join(root, 'Applications')
  const target = join(directory, 'Disk Watch.app')
  bundle(source)
  bundle(target)
  writeFileSync(join(target, 'sentinel'), 'keep')
  rmSync(join(source, 'Contents/Resources/dw-scan'))
  await assert.rejects(() => installBundle(source, directory, { register: false }))
  assert.equal(readFileSync(join(target, 'sentinel'), 'utf8'), 'keep')
})

test('a different app or symlink at the destination is never replaced', mac, async (t) => {
  const root = fixture(t)
  const source = join(root, 'source.app')
  const directory = join(root, 'Applications')
  const target = join(directory, 'Disk Watch.app')
  bundle(source)
  bundle(target, 'example.other.app')
  writeFileSync(join(target, 'sentinel'), 'keep')
  await assert.rejects(() => installBundle(source, directory, { register: false }), /different bundle identifier/)
  assert.equal(readFileSync(join(target, 'sentinel'), 'utf8'), 'keep')
  rmSync(target, { recursive: true })
  symlinkSync(source, target)
  await assert.rejects(() => installBundle(source, directory, { register: false }), /not a link/)
  assert.equal(existsSync(join(source, 'Contents/Resources/dw-scan')), true)
})

test('certificate selection includes self-signed identities and refuses missing or ambiguous names', () => {
  const first = 'A'.repeat(40)
  const second = 'B'.repeat(40)
  const output = `Matching identities\n  1) ${first} "Local signer" (CSSMERR_TP_NOT_TRUSTED)\nValid identities only\n  1) ${first} "Local signer"\n`
  assert.equal(selectSigningIdentity(output, 'Local signer'), first)
  assert.equal(selectSigningIdentity(output, first.toLowerCase()), first)
  assert.throws(() => selectSigningIdentity(output, 'Missing'), /not found/)
  assert.throws(() => selectSigningIdentity(`${output}  2) ${second} "Local signer"`, 'Local signer'), /More than one/)
})

test('an unavailable signer fails before replacing the existing app', mac, async (t) => {
  const root = fixture(t)
  const source = join(root, 'source.app')
  const directory = join(root, 'Applications')
  const target = join(directory, 'Disk Watch.app')
  bundle(source)
  bundle(target)
  writeFileSync(join(target, 'sentinel'), 'keep')
  await assert.rejects(
    () => installBundle(source, directory, { register: false, signingIdentity: 'missing-fixture-certificate' }),
    /not found/,
  )
  assert.equal(readFileSync(join(target, 'sentinel'), 'utf8'), 'keep')
})

test('replacement failure and post-replacement verification restore the previous app', async (t) => {
  const root = fixture(t)
  for (const failure of ['rename', 'verification']) {
    const candidate = join(root, `candidate-${failure}`)
    const target = join(root, `target-${failure}`)
    const previous = join(root, `previous-${failure}`)
    mkdirSync(candidate)
    mkdirSync(target)
    writeFileSync(join(candidate, 'sentinel'), 'new')
    writeFileSync(join(target, 'sentinel'), 'old')
    const { renameSync } = await import('node:fs')
    const validate = (path) => {
      if (failure === 'verification' && readFileSync(join(path, 'sentinel'), 'utf8') === 'new')
        throw new Error('verification failure')
    }
    await assert.rejects(
      () =>
        replaceBundle(candidate, target, previous, validate, (from, to) => {
          if (failure === 'rename' && from === candidate) throw new Error('rename failure')
          renameSync(from, to)
        }),
      /failure/,
    )
    assert.equal(readFileSync(join(target, 'sentinel'), 'utf8'), 'old')
  }
})

test('a concurrent install lock leaves the existing app untouched', mac, async (t) => {
  const root = fixture(t)
  const source = join(root, 'source.app')
  const directory = join(root, 'Applications')
  bundle(source)
  bundle(join(directory, 'Disk Watch.app'))
  mkdirSync(join(directory, '.disk-watch-install.lock'))
  await assert.rejects(() => installBundle(source, directory, { register: false }), /Another install/)
  assert.equal(existsSync(join(directory, 'Disk Watch.app/Contents/Info.plist')), true)
})
