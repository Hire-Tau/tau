import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MoreIcon } from '../icons'
import { Presence } from '../Presence'

export function ProviderAccountActions({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    container.current?.querySelector<HTMLButtonElement>('[data-account-actions] button')?.focus()
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])
  return (
    <div
      ref={container}
      className="relative shrink-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={`Account options for ${label}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="tau-button flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-primary"
      >
        <MoreIcon className="h-4 w-4" />
      </button>
      <Presence
        open={open}
        className="tau-overlay absolute right-0 top-full z-30 mt-1 w-44 rounded-lg border border-th-border bg-surface p-1 shadow-theme-lg"
      >
        <div
          data-account-actions
          className="flex flex-col [&>button]:rounded-md [&>button]:px-3 [&>button]:py-2 [&>button]:text-left [&>button]:text-sm [&>button:hover]:bg-surface-hover"
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest('button')) {
              trigger.current?.focus()
              setOpen(false)
            }
          }}
        >
          {children}
        </div>
      </Presence>
    </div>
  )
}
