const unsafeSegments = new Set(['__proto__', 'prototype', 'constructor'])

export function parseMetadataPath(path: string): string[] {
  const parts = path.split('.')
  if (path.length === 0 || parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid metadata path "${path}": path segments cannot be empty`)
  }
  const unsafe = parts.find((part) => unsafeSegments.has(part))
  if (unsafe) throw new Error(`Invalid metadata path "${path}": unsafe path segment "${unsafe}"`)
  return parts
}

export function parseMetadataValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export function buildMetadataDelta(path: string, value: unknown): Record<string, unknown> {
  const parts = parseMetadataPath(path)
  let nested: unknown = value
  for (let index = parts.length - 1; index >= 0; index--) {
    const parent = Object.create(null) as Record<string, unknown>
    Object.defineProperty(parent, parts[index], {
      value: nested,
      enumerable: true,
      writable: true,
      configurable: true,
    })
    nested = parent
  }
  return nested as Record<string, unknown>
}

function isTraversable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getMetadataValue(metadata: Record<string, unknown>, path: string): unknown {
  const parts = parseMetadataPath(path)
  let current: unknown = metadata
  for (const part of parts) {
    if (!isTraversable(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      throw new Error(`Metadata path "${path}" not found`)
    }
    current = current[part]
  }
  return current
}
