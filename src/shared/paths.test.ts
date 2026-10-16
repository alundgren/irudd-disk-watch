import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vite-plus/test'
import { componentKey, containsComponents, unixComponent, unixLabel } from './paths'

test('Unix components require canonical base64 of exactly one native name', () => {
  for (const value of ['', '.', 'Zg', 'Zh==', 'Lw==', 'AA==', 'Lg==', 'Li4=', 'YQ==\n'])
    expect(() => unixComponent(value)).toThrow()
  expect(unixComponent('XA==')).toBe('XA==')
  expect(unixComponent('/w==')).toBe('/w==')
  expect(componentKey(['YQ==', 'Yg=='])).not.toBe(componentKey(['YWI=']))
  expect(containsComponents(['YQ=='], ['YQ==', 'Yg=='])).toBe(true)
  expect(containsComponents(['YQ=='], ['YWI='])).toBe(false)
})

test('escaped Unix labels distinguish literal escapes, invalid bytes and control characters', () => {
  expect(unixLabel('/w==')).toBe('\\xff')
  expect(unixLabel(Buffer.from('\\xff').toString('base64'))).toBe('\\\\xff')
  expect(unixLabel(Buffer.from('a\nb').toString('base64'))).toBe('a\\x0ab')
  expect(unixLabel(Buffer.from('é').toString('base64'))).toBe('é')
  expect(unixLabel('ww==')).toBe('\\xc3')
})

// This fallback is the native serializer corpus, used before the worker branch is integrated.
const fallbackLabels = [
  {
    case: 'ascii',
    bytes: 'cXVvdGUnYCQ6LQ==',
    label: "quote'`$:-",
  },
  {
    case: 'backslash',
    bytes: 'XHg4MA==',
    label: '\\\\x80',
  },
  {
    case: 'invalid',
    bytes: 'YYA=',
    label: 'a\\x80',
  },
  {
    case: 'overlong',
    bytes: 'wK8=',
    label: '\\xc0\\xaf',
  },
  {
    case: 'truncated',
    bytes: '4oI=',
    label: '\\xe2\\x82',
  },
  {
    case: 'invalid-middle',
    bytes: '4iih',
    label: '\\xe2(\\xa1',
  },
  {
    case: 'controls',
    bytes: 'CQoNG38=',
    label: '\\x09\\x0a\\x0d\\x1b\\x7f',
  },
  {
    case: 'c1',
    bytes: 'woDCnw==',
    label: '\\xc2\\x80\\xc2\\x9f',
  },
  {
    case: 'accent',
    bytes: 'w6k=',
    label: 'é',
  },
  {
    case: 'combining',
    bytes: 'ZcyB',
    label: 'é',
  },
  {
    case: 'replacement',
    bytes: '77+9',
    label: '�',
  },
  {
    case: 'format',
    bytes: '4oCN4oCu77u/77+5',
    label: '\\xe2\\x80\\x8d\\xe2\\x80\\xae\\xef\\xbb\\xbf\\xef\\xbf\\xb9',
  },
  {
    case: 'unicode-separators',
    bytes: '4oCo4oCp',
    label: '\\xe2\\x80\\xa8\\xe2\\x80\\xa9',
  },
  {
    case: 'astral-format',
    bytes: '8JOQsPCdhbPzoICB',
    label: '\\xf0\\x93\\x90\\xb0\\xf0\\x9d\\x85\\xb3\\xf3\\xa0\\x80\\x81',
  },
  {
    case: 'emoji',
    bytes: '8J+YgA==',
    label: '😀',
  },
  {
    case: 'spaces',
    bytes: 'wqDigIA=',
    label: '  ',
  },
]
const nativeCorpusFile = new URL('../../scanner/tests/unix-labels.json', import.meta.url)
const nativeLabels: { case: string; bytes: string; label: string }[] = existsSync(nativeCorpusFile)
  ? JSON.parse(readFileSync(nativeCorpusFile, 'utf8'))
  : fallbackLabels
for (const row of nativeLabels)
  test(`Unix labels agree with native corpus: ${row.case}`, () => {
    expect(unixLabel(row.bytes)).toBe(row.label)
  })

test('Unix labels preserve and escape beginning and internal BOM bytes', () => {
  expect(unixLabel(Buffer.from('\uFEFFname').toString('base64'))).toBe('\\xef\\xbb\\xbfname')
  expect(unixLabel(Buffer.from('a\uFEFFb').toString('base64'))).toBe('a\\xef\\xbb\\xbfb')
  expect(unixLabel(Buffer.from('name').toString('base64'))).toBe('name')
})
