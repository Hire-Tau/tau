import type { ResentInvite } from '../../api/users'

export interface ResendInviteFeedback {
  /** Line to render under the row, or null when there is nothing to say yet. */
  message: string | null
  /** Whether the line reports a problem (drives the colour and role=alert). */
  isProblem: boolean
}

/**
 * What to tell the admin after a "Resend invite" click.
 *
 * Four outcomes, and they are NOT interchangeable:
 *  - failed outright → the old link is gone AND no new one was issued in a way
 *    the admin can use; say so loudly.
 *  - issued but the mail bounced (`inviteEmailFailed`) → a new link exists and
 *    the old one is dead, so silence would look like success while the invitee
 *    heard nothing.
 *  - issued with a link in the body (no-email install) → the shared "Invite link
 *    created" panel carries the link, so this line stays quiet rather than
 *    duplicating it.
 *  - mailed → a plain confirmation, because nothing else on the row changes
 *    visibly except an expiry date the admin has to squint at.
 */
export function resendInviteFeedback(state: {
  isError: boolean
  error?: unknown
  data?: Pick<ResentInvite, 'inviteUrl' | 'inviteEmailFailed'>
}): ResendInviteFeedback {
  if (state.isError) {
    return { message: (state.error as Error)?.message || 'Failed to resend invite', isProblem: true }
  }
  if (!state.data) return { message: null, isProblem: false }
  if (state.data.inviteEmailFailed) {
    return { message: 'New invite link issued, but the email could not be sent.', isProblem: true }
  }
  if (state.data.inviteUrl) return { message: null, isProblem: false }
  return { message: 'Invite resent. The previous link no longer works.', isProblem: false }
}
