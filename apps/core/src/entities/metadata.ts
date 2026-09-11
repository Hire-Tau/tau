function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/** Recursively merges metadata objects. Null deletes; arrays and primitives replace. */
export function deepMergeMetadata(
  target: Record<string, unknown>,
  delta: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target }

  for (const [key, value] of Object.entries(delta)) {
    if (value === null) {
      delete result[key]
      continue
    }

    const current = Object.prototype.hasOwnProperty.call(result, key) ? result[key] : undefined
    defineOwn(result, key, isPlainObject(value) && isPlainObject(current) ? deepMergeMetadata(current, value) : value)
  }

  return result
}
