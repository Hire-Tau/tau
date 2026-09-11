/** Return a safe user-facing message without serializing arbitrary rejection values. */
export function actionErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : 'Action failed. Try again.'
}
