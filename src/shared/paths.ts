/** Windows components use the same case folding as scanner node interning. */
export function canonicalPath(input: string): string {
  const path = input.replaceAll('/', '\\')
  if (/^[\\]{2}[?.]\\/.test(path) || /[\x00-\x1f<>"|?*]/.test(path))
    throw new Error('Enter a normal absolute Windows path.')
  const drive = /^([a-z]:)\\/i.exec(path)
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/.exec(path)
  if (!drive && !unc) throw new Error('Enter an absolute drive or network path.')
  const root = drive ? `${drive[1]!.toUpperCase()}\\` : `\\\\${unc![1]}\\${unc![2]}\\`
  if (unc && [unc[1]!, unc[2]!].some((part) => part.includes(':') || /[. ]$/.test(part)))
    throw new Error('Enter a normal network path.')
  const parts: string[] = []
  for (const part of path.slice(drive ? 3 : unc![0].length).split('\\')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) throw new Error('The path goes outside its root.')
      parts.pop()
    } else {
      if (part.includes(':') || /[. ]$/.test(part))
        throw new Error('A path component cannot end in a dot or space, or contain a colon.')
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
        throw new Error('Device names cannot be hidden as file paths.')
      parts.push(part)
    }
  }
  return root + parts.join('\\')
}

export function pathKey(path: string): string {
  return canonicalPath(path).toLowerCase()
}

export function containsPath(parent: string, child: string): boolean {
  const a = pathKey(parent)
  const b = pathKey(child)
  return b === a || b.startsWith(a.endsWith('\\') ? a : `${a}\\`)
}

export function hidePath(root: string, path: string): string {
  const canonical = canonicalPath(path)
  if (pathKey(root) === pathKey(canonical) || !containsPath(root, canonical)) {
    throw new Error('Choose a file or folder inside the tracked root. The root itself cannot be hidden.')
  }
  return canonical
}

export function pathAncestors(root: string, path: string): string[] {
  let current = hidePath(root, path)
  const ancestors = [current]
  while (true) {
    let next = current.slice(0, current.lastIndexOf('\\'))
    if (/^[a-z]:$/i.test(next)) next += '\\'
    if (pathKey(next + '\\') === pathKey(root)) break
    if (!next || !containsPath(root, next) || pathKey(next) === pathKey(root)) break
    ancestors.push(next)
    current = next
  }
  return ancestors
}

/** Root and top-level items (like C:\ and C:\foo) cannot be queued for deletion. */
export function canDeletePath(root: string, path: string): boolean {
  try {
    return pathAncestors(root, path).length >= 2
  } catch {
    return false
  }
}

export function deletePath(root: string, path: string): string {
  const canonical = canonicalPath(path)
  if (!containsPath(root, canonical)) {
    throw new Error('Choose a file or folder inside the tracked root.')
  }
  if (!canDeletePath(root, canonical)) {
    throw new Error(
      'Root and top-level files or folders cannot be deleted here. Choose a path at least two levels deep.',
    )
  }
  return canonical
}

/** Encoded Unix components are identity, while labels are display text only. */
export function unixComponent(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error('Invalid encoded Unix component.')
  const decoded = atob(value)
  const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0))
  if (
    btoa(decoded) !== value ||
    bytes.some((b) => b === 0 || b === 47) ||
    (bytes.length === 1 && bytes[0] === 46) ||
    (bytes.length === 2 && bytes[0] === 46 && bytes[1] === 46)
  )
    throw new Error('Invalid encoded Unix component.')
  return value
}

export function componentKey(components: readonly string[]): string {
  return JSON.stringify(components.map(unixComponent))
}

export function containsComponents(parent: readonly string[], child: readonly string[]): boolean {
  componentKey(parent)
  componentKey(child)
  return parent.length <= child.length && parent.every((part, i) => part === child[i])
}

export function unixLabel(component: string): string {
  const bytes = Uint8Array.from(atob(unixComponent(component)), (c) => c.charCodeAt(0))
  let result = ''
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i]!
    const length =
      first < 0x80
        ? 1
        : first >= 0xc2 && first <= 0xdf
          ? 2
          : first >= 0xe0 && first <= 0xef
            ? 3
            : first >= 0xf0 && first <= 0xf4
              ? 4
              : 0
    let decoded: string | undefined
    if (length && i + length <= bytes.length) {
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(i, i + length))
      } catch {}
    }
    if (decoded === undefined) {
      result += '\\x' + first.toString(16).padStart(2, '0')
      i++
      continue
    }
    if (decoded === '\\') result += '\\\\'
    else if (first < 32 || first === 127 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(decoded)) {
      for (const byte of bytes.slice(i, i + length)) result += '\\x' + byte.toString(16).padStart(2, '0')
    } else result += decoded
    i += length
  }
  return result
}
