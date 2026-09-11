export interface GitHubConnectionConfiguration {
  version: 1
  userId: number
  login: string
}

/** Account IDs, unlike logins, survive renames and identify reconnects. */
export function parseGitHubConfiguration(value: unknown): GitHubConnectionConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const row = value as Record<string, unknown>
  if (
    Object.keys(row).sort().join() !== 'login,userId,version' ||
    row.version !== 1 ||
    !Number.isSafeInteger(row.userId) ||
    (row.userId as number) <= 0 ||
    typeof row.login !== 'string' ||
    !/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(row.login)
  )
    throw invalid()
  return { version: 1, userId: row.userId as number, login: row.login }
}

function invalid(): Error {
  return new Error('Invalid GitHub configuration')
}
