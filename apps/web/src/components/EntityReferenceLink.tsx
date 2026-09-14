import { QueryClientContext } from '@tanstack/react-query'
import clsx from 'clsx'
import { lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { EntityReference } from '../lib/entityReference'

const loadReference = () => import('./EntityReferenceModal')
const EntityReferenceModal = lazy(() => loadReference().then((module) => ({ default: module.EntityReferenceModal })))

export function EntityReferenceLink({ reference, children }: { reference: EntityReference; children: ReactNode }) {
  const client = useContext(QueryClientContext)
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const { kind, id } = reference
  const preload = useCallback(() => {
    void loadReference()
      .then((module) => client && module.preloadEntityReference(client, { kind, id }))
      // Preloading is speculative; clicking still provides the normal retry/error UI.
      .catch(() => {})
  }, [client, kind, id])

  useEffect(() => {
    if (!button.current || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      preload()
    })
    observer.observe(button.current)
    return () => observer.disconnect()
  }, [preload])

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-busy={loading}
        className={clsx(
          'tau-button inline text-accent-light underline underline-offset-2',
          loading && 'motion-safe:animate-pulse motion-reduce:opacity-60'
        )}
        onMouseEnter={preload}
        onFocus={preload}
        onTouchStart={preload}
        onClick={() => {
          if (open) return
          setLoading(true)
          setOpen(true)
        }}
      >
        {children}
      </button>
      {open && (
        <Suspense fallback={null}>
          <EntityReferenceModal
            reference={reference}
            onResolved={() => setLoading(false)}
            onClose={() => {
              setOpen(false)
              setLoading(false)
            }}
          />
        </Suspense>
      )}
    </>
  )
}
