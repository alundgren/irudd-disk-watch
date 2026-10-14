const shapes = {
  dir: (
    <>
      <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
      <path d="M3 8h18" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z" />
      <path d="M14 3v5h5M8 13h8M8 17h6" />
    </>
  ),
  edit: <path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14Z" />,
  created: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
}

export function NodeIcon({ kind }: { kind: keyof typeof shapes }) {
  return (
    <svg className={`node-icon icon-${kind}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {shapes[kind]}
    </svg>
  )
}
