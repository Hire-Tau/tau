import type { UserListEntry } from '../../api/users'

export interface UserSetupStatus {
  /** Badge text. */
  label: string
  /** Hover explanation of what the badge is derived from. */
  title: string
  /** True while the person has been invited but has never completed setup. */
  pending: boolean
  /** Timing line for an outstanding invite, or null when there is nothing to say. */
  detail: string | null
}

/**
 * Invited-vs-joined for one row of the Users list. Inviting someone creates
 * their account immediately (see routes/users.ts), so an account with no passkey
 * is a person who was invited and never showed up — otherwise indistinguishable
 * from a long-time member. The outstanding registration challenge, when the
 * server reports one, says whether their link still works.
 *
 * `now` is injectable so the expiry boundary is testable without a frozen clock.
 */
export function userSetupStatus(
  user: Pick<UserListEntry, 'hasPasskey' | 'inviteExpiresAt'>,
  now: number = Date.now()
): UserSetupStatus {
  if (user.hasPasskey) {
    return {
      label: 'Active',
      title: 'Completed setup — at least one passkey registered',
      pending: false,
      detail: null,
    }
  }
  const expiresAt = user.inviteExpiresAt ? new Date(user.inviteExpiresAt) : null
  return {
    // Short enough to stay one line inside a rounded-full pill at any width —
    // a wrapping pill renders as an ellipse blob. The full meaning lives in
    // `title`, and `detail` already spells out the expiry underneath.
    label: 'Invited',
    title: 'Invited, but has never registered a passkey',
    pending: true,
    detail:
      expiresAt === null
        ? null
        : expiresAt.getTime() > now
          ? `Invite expires ${expiresAt.toLocaleDateString()}`
          : `Invite expired ${expiresAt.toLocaleDateString()}`,
  }
}
