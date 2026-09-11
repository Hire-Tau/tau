export type SecretValidation =
  | { status: 'valid'; login: string; tokenType: 'classic' | 'fine-grained'; scopes?: string[]; warnings: string[] }
  | { status: 'invalid'; message: string }
  | { status: 'unverified'; message: string }

/** A validator validates only the candidate value handed to it and never throws. */
export type SecretValidator = (candidate: string) => Promise<SecretValidation>
