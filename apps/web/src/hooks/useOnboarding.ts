import { useQuery } from '@tanstack/react-query'
import { usePermissions } from './usePermissions'
import { queries } from '../queryOptions'
import type { OnboardingStatus } from '../api/onboarding'

/**
 * Onboarding status, gated on the viewer holding `settings:read` — the same
 * permission SettingsPage's SECTION_PERMISSIONS uses for its admin-only
 * sections. The query is not merely hidden from non-admins on the client;
 * it is never ENABLED for them, so an invited teammate never generates a
 * 403 in their own network tab (design §2's gating note; plan Task 2's
 * non-admin guard step).
 *
 * `status` is undefined while loading, for a non-admin, AND on a failed
 * request — onboarding must never be able to break a working instance, so
 * every one of those cases collapses to "nothing to show" for callers like
 * the nag banner, rather than distinguishing loading from failure.
 *
 * `isAdmin` and `isPermissionsLoading` are deliberately SEPARATE (rather than
 * collapsing "still loading" into `isAdmin: false`, the way SettingsPage's
 * `isSectionAllowed` keeps `isLoading` distinct from the allow/deny check):
 * a caller that renders a restricted-access message on `!isAdmin` must not
 * show it while permissions are merely unresolved — a brand-new admin
 * landing on /onboarding right after first registration would otherwise see
 * that message flash before their `settings:read` permission loads in.
 */
export function useOnboarding(): {
  status?: OnboardingStatus
  isAdmin: boolean
  isPermissionsLoading: boolean
} {
  const { can, isLoading: isPermissionsLoading } = usePermissions()
  const isAdmin = !isPermissionsLoading && can('settings:read')

  const { data, isError } = useQuery({
    ...queries.onboarding.status(),
    enabled: isAdmin,
    // Completing an item happens ELSEWHERE — a provider account added on the
    // settings page, a squad created from its own modal, a teammate invited,
    // an OAuth round-trip finished in another tab. PRIMARY invalidation is
    // event-driven: core emits `onboarding.updated` at every real signal
    // source (services/onboarding/events.ts) and QueryInvalidator subscribes
    // to the `onboarding` WS topic and invalidates this query immediately.
    //
    // This poll is FALLBACK rot-insurance, not the primary mechanism: status
    // is DERIVED from many independent signals, so the emit-point list is a
    // hand-maintained enumeration that silently rots the next time an item is
    // added — the item nobody wired an emit for would be the one that never
    // ticks without a manual reload. Polling cannot miss a source. 60s (rather
    // than the old 10s stopgap) because the event path now covers the common
    // case instantly; this only catches an emit point someone forgot. It costs
    // one cheap derived read every 60s and ONLY while onboarding is
    // unfinished: once `ready` is true the interval turns itself off and never
    // runs again for that instance.
    refetchInterval: (query) => (query.state.data?.ready === false ? 60_000 : false),
    // The common case is finishing a step in another tab (OAuth, a provider's
    // console) and coming back — refetch on return so it updates immediately
    // rather than up to a poll-interval later.
    refetchOnWindowFocus: true,
  })

  return {
    status: isError ? undefined : data,
    isAdmin,
    isPermissionsLoading,
  }
}
