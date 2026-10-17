import { chmodSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { GitHubAccess } from './githubAccess'

const token = 'github_pat_fixture_1234567890'
vi.mock('node:fs', { spy: true })
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'dw-github-access-'))
  roots.push(root)
  return join(root, 'access')
}
// An opaque fixture cipher keeps the test independent of this Mac's actual Keychain.
const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 123)),
  decryptString: (value: Buffer) =>
    Buffer.from(value)
      .map((byte) => byte ^ 123)
      .toString(),
}

test('access survives a normal relaunch without returning or storing a plaintext token', () => {
  const file = fixture()
  const access = new GitHubAccess(file, storage, () => undefined)
  expect(access.save(token)).toEqual({ source: 'saved', hasSavedRecord: true, canSave: true })
  expect(readFileSync(file).includes(Buffer.from(token))).toBe(false)
  expect(JSON.stringify(access.getState())).not.toContain(token)
  const restarted = new GitHubAccess(file, storage, () => undefined)
  expect(restarted.token).toBe(token)
  expect(restarted.clear().source).toBe('none')
  expect(restarted.token).toBeUndefined()
})

test('unavailable encryption never falls back to plaintext persistence', () => {
  const file = fixture()
  const access = new GitHubAccess(file, { ...storage, isEncryptionAvailable: () => false }, () => undefined)
  expect(() => access.save(token)).toThrow('encryption is unavailable')
  expect(access.token).toBeUndefined()
  expect(() => readFileSync(file)).toThrow()
})

test('a failed encryption attempt retains the previous saved access', () => {
  const file = fixture()
  new GitHubAccess(file, storage, () => undefined).save(token)
  const access = new GitHubAccess(
    file,
    {
      ...storage,
      encryptString: () => {
        throw new Error('fixture')
      },
    },
    () => undefined,
  )
  expect(() => access.save('github_pat_replacement_1234567890')).toThrow('previous access was retained')
  expect(access.token).toBe(token)
  expect(new GitHubAccess(file, storage, () => undefined).token).toBe(token)
})

test('a corrupt encrypted record leaves scanning usable and allows credentials to be replaced', () => {
  const file = fixture()
  writeFileSync(file, 'corrupt', { mode: 0o600 })
  const access = new GitHubAccess(file, storage, () => undefined)
  expect(access.getState().message).toContain('could not be unlocked')
  expect(access.token).toBeUndefined()
  expect(access.save(token).source).toBe('saved')
})

test('saved access takes precedence over environment access and clearing restores the environment', () => {
  const access = new GitHubAccess(fixture(), storage, () => 'environment_token_fixture')
  expect(access.getState().source).toBe('environment')
  access.save(token)
  expect(access.token).toBe(token)
  expect(access.clear().source).toBe('environment')
  expect(access.token).toBe('environment_token_fixture')
})

test('token validation never repeats the supplied secret', () => {
  const access = new GitHubAccess(fixture(), storage)
  const invalid = token + '\nheader'
  expect(() => access.save(invalid)).toThrow('without spaces or line breaks')
  try {
    access.save(invalid)
  } catch (error) {
    expect(String(error)).not.toContain(token)
  }
})

test('malformed environment access is rejected before it can become an HTTP header', () => {
  const invalid = token + '\nsecret-tail'
  const access = new GitHubAccess(fixture(), storage, () => invalid)
  expect(() => access.token).toThrow('without spaces or line breaks')
  expect(access.getState().source).toBe('none')
  expect(access.getState().message).not.toContain(token)
  expect(access.getState().message).toContain('environment GitHub token is invalid')
})

test('an encrypted record can be removed even when decryption is unavailable', () => {
  const file = fixture()
  new GitHubAccess(file, storage).save(token)
  const access = new GitHubAccess(file, { ...storage, isEncryptionAvailable: () => false }, () => undefined)
  expect(access.getState()).toMatchObject({ source: 'none', hasSavedRecord: true, canSave: false })
  expect(access.clear()).toMatchObject({ source: 'none', hasSavedRecord: false })
  expect(() => readFileSync(file)).toThrow()
})

if (process.platform !== 'win32') {
  test('linked or shared credential directories are refused', () => {
    const file = fixture()
    const shared = join(file, '..', 'shared')
    mkdirSync(shared, { mode: 0o700 })
    const linked = join(file, '..', 'link')
    symlinkSync(shared, linked)
    expect(() => new GitHubAccess(join(linked, 'access'), storage).save(token)).toThrow('private')
    chmodSync(shared, 0o777)
    expect(() => new GitHubAccess(join(shared, 'access'), storage).save(token)).toThrow('private')
  })

  test('a link swapped in between metadata and open is never read', () => {
    const file = fixture()
    new GitHubAccess(file, storage).save(token)
    const outside = join(file, '..', 'outside')
    writeFileSync(outside, 'sentinel', { mode: 0o600 })
    const actualOpen = openSync
    vi.mocked(openSync).mockImplementationOnce((path, flags, mode) => {
      rmSync(file)
      symlinkSync(outside, file)
      return actualOpen(path, flags, mode)
    })
    const decryptString = vi.fn(storage.decryptString)
    const access = new GitHubAccess(file, { ...storage, decryptString }, () => undefined)
    expect(access.token).toBeUndefined()
    expect(decryptString).not.toHaveBeenCalled()
    expect(readFileSync(outside, 'utf8')).toBe('sentinel')
  })
}

if (process.platform !== 'win32')
  test('a linked credential destination cannot overwrite another file', () => {
    const file = fixture()
    const outside = join(file, '..', 'outside')
    writeFileSync(outside, 'sentinel', { mode: 0o600 })
    symlinkSync(outside, file)
    const access = new GitHubAccess(file, storage)
    expect(() => access.save(token)).toThrow('unsafe')
    expect(() => access.clear()).toThrow('unsafe')
    expect(readFileSync(outside, 'utf8')).toBe('sentinel')
  })
