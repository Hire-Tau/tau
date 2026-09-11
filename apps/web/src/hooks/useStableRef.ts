import { useLayoutEffect, useRef } from 'react'

/**
 * Returns a ref that always holds the latest value, updated synchronously
 * via useLayoutEffect. Use this to stabilize a changing reference so it can
 * be read inside callbacks/effects without adding it to dependency arrays.
 *
 * @example
 * const onCloseRef = useStableRef(onClose)
 *
 * useEffect(() => {
 *   // onCloseRef.current is always the latest onClose
 *   return () => onCloseRef.current()
 * }, []) // no need to depend on onClose
 */
export function useStableRef<T>(value: T) {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}
