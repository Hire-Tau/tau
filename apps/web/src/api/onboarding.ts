import { apiFetch } from './client'

/**
 * MIRRORS apps/core/src/services/onboarding/status.ts (OnboardingItemId,
 * OnboardingItemState, OnboardingItem, OnboardingStatus) and the response
 * shape of apps/core/src/routes/onboarding.ts (GET /api/onboarding/status,
 * POST /api/onboarding/items/:id/skip|unskip — the skip routes return the
 * refreshed status).
 *
 * Vite never typechecks apps/web against apps/core, so these types are
 * kept in sync with core BY HAND. If core's response shape changes, this
 * file must be updated manually.
 */
export type OnboardingItemId = 'ai_provider' | 'first_squad' | 'github'

export type OnboardingItemState = 'todo' | 'done' | 'skipped'

export interface OnboardingItem {
  id: OnboardingItemId
  required: boolean
  state: OnboardingItemState
}

export interface OnboardingStatus {
  ready: boolean
  items: OnboardingItem[]
}

export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  return apiFetch<OnboardingStatus>('/onboarding/status')
}

/** Only valid for optional items — the server 400s a required id. */
export async function skipOnboardingItem(id: OnboardingItemId): Promise<OnboardingStatus> {
  return apiFetch<OnboardingStatus>(`/onboarding/items/${id}/skip`, { method: 'POST' })
}

export async function unskipOnboardingItem(id: OnboardingItemId): Promise<OnboardingStatus> {
  return apiFetch<OnboardingStatus>(`/onboarding/items/${id}/unskip`, { method: 'POST' })
}
