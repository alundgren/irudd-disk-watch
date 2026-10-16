import { spawnSync } from 'node:child_process'
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { signAsync } from '@electron/osx-sign'

const root = fileURLToPath(new URL('../', import.meta.url))
const appName = 'Disk Watch.app'
const bundleId = 'com.irudd.diskwatch'
const executable = join('Contents', 'MacOS', 'Disk Watch')
const signingKey = 'DiskWatchSigningIdentity'
const registrationTool =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with exit ${result.status}. ${result.stderr ?? ''}`)
  return result.stdout?.trim() ?? ''
}

function exists(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function validateBundle(path) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected an app directory, not a link: ${path}`)
  const identifier = run(
    '/usr/bin/plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(path, 'Contents/Info.plist')],
    true,
  )
  if (identifier !== bundleId) throw new Error(`Refusing an app with a different bundle identifier: ${path}`)
  for (const binary of [executable, 'Contents/Resources/dw-scan']) {
    const file = join(path, binary)
    if (!lstatSync(file).isFile()) throw new Error(`Expected a regular executable: ${file}`)
    accessSync(file, constants.X_OK)
  }
}

function assertStopped(path) {
  const binaries = run('/bin/ps', ['-axww', '-o', 'comm='], true)
    .split('\n')
    .map((line) => line.trim())
  if (binaries.some((binary) => binary === join(path, executable) || binary.startsWith(`${path}/Contents/`)))
    throw new Error(`Quit this copy of Disk Watch before reinstalling: ${path}`)
}

export function selectSigningIdentity(output, reference) {
  const requested = reference.trim()
  if (!requested) throw new Error('Provide an exact signing certificate name or fingerprint.')
  const matches = new Set()
  for (const line of output.split('\n')) {
    const match = /^\s*\d+\) ([0-9A-Fa-f]{40}) "(.*)"(?: \(.*\))?\s*$/.exec(line)
    if (match && (match[2] === requested || match[1].toUpperCase() === requested.toUpperCase()))
      matches.add(match[1].toUpperCase())
  }
  if (matches.size !== 1)
    throw new Error(
      matches.size
        ? 'More than one certificate matches. Use its fingerprint.'
        : 'Signing certificate not found. The installed app was not changed.',
    )
  return [...matches][0]
}

function verifySigner(path, identity) {
  const requirement = `identifier "${bundleId}" and certificate leaf = H"${identity}"`
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', `=${requirement}`, path])
  // The separately launched scanner must also retain its own identifier and signer.
  run('/usr/bin/codesign', [
    '--verify',
    '--strict',
    '-R',
    `=identifier "${bundleId}.scanner" and certificate leaf = H"${identity}"`,
    join(path, 'Contents/Resources/dw-scan'),
  ])
}

export function installedSigningIdentity(path) {
  if (!exists(path)) return undefined
  validateBundle(path)
  const plist = JSON.parse(
    run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(path, 'Contents/Info.plist')], true),
  )
  const identity = plist[signingKey]
  if (identity === undefined) return undefined
  if (typeof identity !== 'string' || !/^[0-9A-F]{40}$/.test(identity))
    throw new Error('The installed signing identity is invalid.')
  verifySigner(path, identity)
  return identity
}

export async function installBundle(source, directory, { register = true, signingIdentity } = {}) {
  if (process.platform !== 'darwin') throw new Error('The Mac installer requires macOS.')
  if (!isAbsolute(directory)) throw new Error('The install directory must be absolute.')
  source = realpathSync(source)
  validateBundle(source)
  mkdirSync(directory, { recursive: true })
  directory = realpathSync(directory)
  accessSync(directory, constants.W_OK)
  const target = join(directory, appName)
  if (source === target || source.startsWith(`${target}/`))
    throw new Error('The source must be outside the installed app.')
  if (exists(target)) validateBundle(target)
  assertStopped(target)
  const requested = signingIdentity ?? installedSigningIdentity(target)
  const identity =
    requested === undefined
      ? undefined
      : selectSigningIdentity(run('/usr/bin/security', ['find-identity', '-p', 'codesigning'], true), requested)
  const staging = mkdtempSync(join(directory, '.disk-watch-install-'))
  const candidate = join(staging, appName)
  const previous = join(staging, 'previous.app')
  let movedPrevious = false
  let installed = false
  try {
    run('/usr/bin/ditto', [source, candidate])
    validateBundle(candidate)
    if (identity) {
      const plist = join(candidate, 'Contents/Info.plist')
      const metadata = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], true))
      run('/usr/bin/plutil', [
        metadata[signingKey] === undefined ? '-insert' : '-replace',
        signingKey,
        '-string',
        identity,
        plist,
      ])
      await signAsync({
        app: candidate,
        identity,
        identityValidation: false,
        gatekeeperAssess: false,
        preAutoEntitlements: false,
        preEmbedProvisioningProfile: false,
        optionsForFile: (file) => ({
          hardenedRuntime: false,
          timestamp: 'none',
          entitlements: [],
          additionalArguments:
            file === join(candidate, 'Contents/Resources/dw-scan') ? ['--identifier', `${bundleId}.scanner`] : [],
        }),
      })
      verifySigner(candidate, identity)
    }
    assertStopped(target)
    if (exists(target)) {
      validateBundle(target)
      renameSync(target, previous)
      movedPrevious = true
    }
    try {
      renameSync(candidate, target)
      installed = true
    } catch (error) {
      if (movedPrevious) {
        renameSync(previous, target)
        movedPrevious = false
      }
      throw error
    }
  } finally {
    // Retain the old app if restoring it failed, so a failed update cannot erase it.
    if (installed || !movedPrevious) rmSync(staging, { recursive: true, force: true })
    else console.error(`The previous app is preserved at ${previous}`)
  }
  if (register) {
    run(registrationTool, ['-f', target])
    run('/usr/bin/mdimport', ['-i', target])
  }
  if (identity) console.log(`Signed with certificate: ${identity}`)
  return target
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('The Mac installer requires macOS.')
  const args = process.argv.slice(2)
  let directory = '/Applications'
  let source = join(root, 'dist/mac-arm64', appName)
  let skipBuild = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--skip-build') skipBuild = true
    else if (args[i] === '--install-directory' || args[i] === '--source') {
      const option = args[i]
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`)
      if (option === '--install-directory') directory = value
      else {
        source = resolve(value)
        skipBuild = true
      }
    } else throw new Error(`Unknown option: ${args[i]}`)
  }
  if (!isAbsolute(directory)) throw new Error('The install directory must be absolute.')
  assertStopped(join(directory, appName))
  const requested = process.env.DISK_WATCH_SIGNING_IDENTITY ?? installedSigningIdentity(join(directory, appName))
  const signingIdentity =
    requested === undefined
      ? undefined
      : selectSigningIdentity(run('/usr/bin/security', ['find-identity', '-p', 'codesigning'], true), requested)
  if (!skipBuild) {
    assertStopped(source)
    run(process.execPath, [
      join(root, 'scripts/cargo.mjs'),
      'build',
      '--release',
      '--locked',
      '--manifest-path',
      'scanner/Cargo.toml',
    ])
    run(join(root, 'node_modules/.bin/electron-vite'), ['build'])
    run(process.execPath, [join(root, 'scripts/mac-icon.mjs')])
    run(join(root, 'node_modules/.bin/electron-builder'), ['--mac', 'dir', '--arm64', '--publish', 'never'])
  }
  const target = await installBundle(source, directory, { signingIdentity })
  console.log(`Installed: ${target}`)
  console.log('Search Spotlight for Disk Watch. The installer does not launch the app.')
  console.log('Existing scans and settings remain in your disk-watch Application Support folder.')
  console.log(
    signingIdentity
      ? 'Grant Full Disk Access to this signed app. Later reinstalls reuse its saved certificate; confirm access after updating.'
      : 'Grant Full Disk Access to this installed app. Unsigned rebuilds may require granting access again.',
  )
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
