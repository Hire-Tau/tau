export const BASH_DEFAULT_TIMEOUT_SECONDS = 180
export const BASH_MAX_TIMEOUT_SECONDS = 3_600

export const FOREGROUND_BASH_GUIDANCE =
  'Work that must complete reliably must stay in this foreground invocation; set timeout up to 3600s. ' +
  'Detached background processes are unsupported for completion-critical work (including &, nohup, setsid, disown, and hand-launched tmux) and may be terminated when a remote box idles.'

/** Normalize a user-facing Bash timeout to the supported foreground window. */
export function normalizeBashTimeoutSeconds(timeout?: number): number {
  if (timeout === undefined || !Number.isFinite(timeout) || timeout <= 0) return BASH_DEFAULT_TIMEOUT_SECONDS
  return Math.min(timeout, BASH_MAX_TIMEOUT_SECONDS)
}
