import { useEffect, useId, useRef, useState } from 'react'
import type { ScanSummary } from '../../shared/types'
import { describeScan } from './api'

interface ScanPickerProps {
  label: string
  scans: ScanSummary[]
  value: number
  onChange(scanId: number): void
}

export function ScanPicker({ label, scans, value, onChange }: ScanPickerProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  const selected = scans.find((scan) => scan.id === value)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => ref.current?.contains(e.target as Node) || setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="picker" ref={ref}>
      <span className="label" id={`${id}-label`}>
        {label}
      </span>
      <button
        className="picker-button"
        id={`${id}-button`}
        aria-labelledby={`${id}-label ${id}-button`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {selected ? describeScan(selected) : 'Choose a scan'} <span aria-hidden>▾</span>
      </button>
      {open && (
        <ul className="picker-menu" role="listbox">
          {scans.map((scan) => (
            <li key={scan.id} role="option" aria-selected={scan.id === value}>
              <button
                onClick={() => {
                  onChange(scan.id)
                  setOpen(false)
                }}
              >
                {describeScan(scan)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
