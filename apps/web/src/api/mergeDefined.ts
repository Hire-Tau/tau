/** Merge scoped dependency overrides without letting an explicit `undefined`
 * erase a required production default. Returns a new object. */
export function mergeDefined<T extends object>(defaults: T, overrides: Partial<T>): T {
  const merged = { ...defaults }
  for (const key of Object.keys(overrides) as Array<keyof T>) {
    const value = overrides[key]
    if (value !== undefined) merged[key] = value
  }
  return merged
}
