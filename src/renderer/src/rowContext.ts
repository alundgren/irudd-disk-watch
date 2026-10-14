import type { KeyboardEvent } from 'react'

export function openRowContext(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return false
  event.preventDefault()
  event.stopPropagation()
  const bounds = event.currentTarget.getBoundingClientRect()
  event.currentTarget.dispatchEvent(
    new window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + 24,
      clientY: bounds.bottom,
    }),
  )
  return true
}
