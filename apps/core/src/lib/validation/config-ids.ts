export const CONFIG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/

export function assertConfigId(id: unknown, label = 'id'): asserts id is string {
  if (typeof id !== 'string' || !CONFIG_ID_PATTERN.test(id)) {
    throw new Error(`${label} must be lowercase kebab-case, 1-100 chars`)
  }
}

export function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`)
  }
}
