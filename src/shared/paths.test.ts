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
