import type { OnboardingItemState } from '../../api/onboarding'

// Shared row-header presentation (label + badge class per state), used by
// both the generic DeepLinkItemRow (OnboardingPage.tsx) and FirstSquadStep
// so every row's state badge looks identical. Kept in its own module (not
// exported from OnboardingPage.tsx) so this file doesn't trip
// react-refresh/only-export-components, which requires component files to
// export components only.
export const STATE_LABEL: Record<OnboardingItemState, string> = {
  todo: 'To do',
  done: 'Done',
  skipped: 'Skipped',
}

export const STATE_BADGE_CLASS: Record<OnboardingItemState, string> = {
  todo: 'bg-surface-secondary text-muted',
  done: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
  skipped: 'bg-surface-secondary text-muted',
}
