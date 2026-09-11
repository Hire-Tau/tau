/**
 * Naming for individual passkeys (`user_credentials.display_name`).
 *
 * A passkey label is NOT the user's display name — it names one authenticator on
 * one device ("MacBook Touch ID", "YubiKey"), and an account routinely holds
 * several. Keeping the two apart matters most on the recovery form, where the
 * account already exists and the only thing worth asking about is the new key.
 */

/**
 * Longest passkey label we store. Labels are user-supplied and rendered verbatim
 * in the account UI and in `aria-label`s, so they are bounded rather than free text.
 */
export const MAX_CREDENTIAL_NAME_LENGTH = 64

/**
 * Trim a supplied passkey label into something storable: blank or absent becomes
 * `undefined` (the caller then falls back to `defaultCredentialName`), and an
 * over-long label is cut to the bound rather than refused.
 *
 * Truncating is deliberate on the registration paths. By the time a label is read
 * the WebAuthn ceremony has already succeeded, so the credential MUST be
 * persisted — rejecting the write over a long label would strand the user with an
 * authenticator their account has never heard of. The rename endpoint carries no
 * such commitment and rejects instead, so the mistake is visible and fixable.
 */
export function normalizeCredentialName(name: string | undefined): string | undefined {
  const trimmed = name?.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, MAX_CREDENTIAL_NAME_LENGTH)
}

/**
 * Ordered platform probes. Order is load-bearing: Android User-Agents also
 * contain "Linux", and an iPad in desktop mode reports "Macintosh", so the more
 * specific token has to be tested first.
 */
const PLATFORM_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone/i, 'iPhone'],
  [/iPad/i, 'iPad'],
  [/Android/i, 'Android'],
  [/Macintosh|Mac OS X/i, 'Mac'],
  [/Windows/i, 'Windows'],
  [/Linux|X11/i, 'Linux'],
]

/**
 * Label a freshly registered passkey whose owner left the name blank.
 *
 * A passkey lives on one specific device, so the platform it was created on is
 * the most useful thing we can say without asking — "Passkey on iPhone" beats
 * three rows that all read "Unnamed passkey". Deliberately coarse: the
 * User-Agent is consulted for a platform word only, never a version, so this
 * cannot drift into fingerprinting or into a browser-table maintenance burden.
 */
export function defaultCredentialName(userAgent: string | undefined): string {
  const match = PLATFORM_PATTERNS.find(([pattern]) => pattern.test(userAgent ?? ''))
  return match ? `Passkey on ${match[1]}` : 'Passkey'
}

/** The label to store for a new credential: what the user typed, else a device-derived default. */
export function resolveCredentialName(name: string | undefined, userAgent: string | undefined): string {
  return normalizeCredentialName(name) ?? defaultCredentialName(userAgent)
}
