# Account theme sync

Theme/appearance and the **custom theme document** sync together. The v2
custom-document cap (32 KiB — sized for a full light+dark pair, see
[custom themes](custom-themes.md)) fits the `user_preferences.theme` JSONB
field; there is no palette copy, new runtime dependency, or change to custom
color, status coherence, sentinel inheritance, intrinsic-opacity or contrast
rules. Migration `0188_salty_micromax.sql` was generated with `bun db:generate`. It adds
one row per user, an update timestamp and a cascading user foreign key. An absent
row is **no account choice**, not a default value to upload.

`ThemePreference` also carries `presetId: string | null` — the [theme preset
library](custom-themes.md) preset the active `customTheme` snapshot came
from, or `null` when detached (a built-in selection, a one-off import, the
preset's own row was later deleted, or — Phase 2 — a shared preset was
unshared/deleted). `presetId` is optional on input (defaults to `null`) but
`customTheme` remains required (may be `null`). A v1-shaped stored preference
(no `presetId`, single-appearance `customTheme`) still validates and
normalizes exactly like a document read directly — the "appearance must equal
the document's appearance" rule is gone: a v2 pair follows the
Light/Dark/System toggle, so only `customTheme.base === themeId` is still
required. Deleting the referenced preset does not touch this row or "break"
the device that has it applied — `customTheme` is a full snapshot, and a
dangling `presetId` is simply detached going forward.

Phase 2 adds `presetOwnerId: string | null`: the id of the user who owns
`presetId`'s preset, populated whenever ANY preset (the caller's own, or
someone else's shared preset) is applied — optional on input, valid only
alongside a non-null `customTheme` (a bare owner id with no document is
rejected). Unlike `presetId`, it is deliberately **retained** when the
browser's live-link refresh (below) finds the referenced preset gone and
clears `presetId` to `null` — the combination `presetId: null,
presetOwnerId: <id>` is exactly what lets the UI show "this shared theme is
no longer available" for a detached SHARED preset, while a detached OWN
preset (`presetOwnerId` equal to the caller's own id) stays the silent,
message-free Phase 1 behavior. See [custom themes](custom-themes.md#sharing-phase-2)
for the full sharing/live-link/moderation contract.

## Conflict and recovery contract

- `tau-theme-id`, `tau-appearance`, `tau-custom-theme` and the surface snapshot
  remain the synchronous pre-paint source of truth. No network runs in the
  bootstrap script. Its generated output is refreshed for shared-module bundling;
  its behavior is unchanged.
- `tau-theme-local-override=1` means an explicit device choice. Every picker,
  appearance toggle, custom Apply or Reset action sets it. OS appearance changes,
  previews, hydration and remote adoption do not.
- `0` means follow the account. On first upgrade, pre-existing selection, legacy
  appearance or custom-document keys count as an override. A fresh device records
  `0` **before** the provider writes defaults, so a second load cannot mistake
  automatic persistence for a user choice.
- After a paint opportunity (two animation frames), an authenticated session reads
  its account choice. A fresh/following device adopts it; an override never does.
  There may be one intentional post-paint adoption on a fresh device: the account
  value is not knowable before the request. Subsequent cold loads use its cache.
- Phase 2's shared-preset live link piggybacks on this same lifecycle
  (`ThemeAccountSyncSession`, `apps/web/src/providers/ThemeAccountSync.tsx`):
  `ThemeSyncStore.refreshLinkedPreset` runs right after the account preference
  read completes (sequenced, not racing it — a fresh device's `presetId` often
  only becomes known FROM that read) on mount, and again on the same
  focus/online/visibility triggers as `refresh()` above. It is independent of
  `localOverride` — an orthogonal concern (which theme THIS DEVICE follows vs.
  whether a referenced PRESET's document is still current) — and a no-op
  unless a preset with a known owner (`presetId`, `presetOwnerId` and
  `customTheme` all present) is actually applied.
- Picker copy identifies the override and offers **Use synced theme**. This clears
  the flag, discards unsent changes and rereads the server after outstanding writes.
  If offline, the current palette stays visible and adoption resumes on reconnect.
  A newer deliberate edit cancels adoption. Choosing a built-in theme (including
  Tau, the default) is deliberately a new local/account choice, not a synonym
  for following the account.
- Deliberate edits made in a connected authenticated session push best-effort.
  In-flight writes are serialized; unsent edits coalesce to the latest value.
  Offline pending edits retry on focus, visibility or reconnect **within that
  session only**. Login/reload never uploads an old local cache automatically.
  Across devices the last successful whole-preference write wins on the account;
  each device with an override keeps its own choice. Storage events also honor
  a deliberate choice made in another tab, without echoing an upload. A failed
  in-flight write may retry only while its captured choice revision is current;
  it cannot revive an intent canceled by another tab or the adopt action.
- Storage-event adoption is read-only for preference keys. A React rerender must
  not persist its possibly intermediate selection back over the writing tab.
  Initial migration is persisted once by the store; subsequent preference writes
  belong to deliberate changes or server adoption. This closes a real-browser
  race between the override-flag event and the following selection events.
- Logout/account transitions abort requests and discard remote state and queued
  writes. Old responses cannot apply to the next session. A theme inherited during
  that session is cleared on logout; an explicit device override remains, including
  its custom document. As required for first paint, the cached palette on disk is
  readable before authentication resolves—it is device appearance data, not an
  authentication boundary or secret store. It is never uploaded to a new account.
- `PUT` requires the user ID returned by `GET` as an identity precondition, not as
  a target: the server always writes the authenticated caller's row. If cookies
  switch between queuing and sending, the request fails with 409 instead of writing
  to the new user. Read revisions prevent a slow response from undoing a local edit.
- Signed-out and auth-disabled use remains local. Network/old-server errors are
  silent and do not block painting or the picker. Blocked storage works in memory.

## API

`client.userPreferences.getMine(signal?)` calls `GET /user-preferences/me` and
returns `{ userId, theme: null | { themeId, appearance, customTheme, presetId,
presetOwnerId } }`. `updateMine({ expectedUserId, theme }, signal?)` calls
`PUT` on the same path. This is an atomic whole-theme replacement, not a
partial merge. Unknown IDs, appearances, versions, unsafe values, partial
status roles, base mismatch and oversized documents are rejected before
persistence; the HTTP envelope is also bounded to the 32 KiB document cap
plus 1 KiB. The browser revalidates remote documents before applying.

The same self-service pattern (`resolveActingUser` + `authzChecked`, owner-only,
not RBAC-gated) also backs most of `/api/theme-presets` — `client.themePresets.{list,
get,create,update,delete,setVisibility,duplicate}` — for the library each
preset lives in; `removeShare` is the one RBAC-gated (`theme-presets:moderate`)
exception. See [custom themes](custom-themes.md#sharing-phase-2) for the full
sharing contract, including the live-link `get`/`GET /:id` read (own preset OR
any instance-shared preset) and the revision-checked update/delete contract.

## Verification

- `theme/sync.test.ts`: migration/conflict rules, custom sync, clear/adopt, delayed
  GET/PUT, logout/account replacement, disconnected retries and denied storage;
  `refreshLinkedPreset`'s no-op/apply-if-changed/404-detach/network-silent/
  stale-response-discarded behavior and `presetOwnerId` round-tripping.
- `providers/ThemeAccountSync.test.tsx`: actual generated flash script → React
  hydration → differing server value → reconnect/adopt, StrictMode paint gating,
  cancellation and signed-out behavior. Adoption never echoes a PUT. The
  live-link fetch is sequenced after the account read on load and re-fires on
  the same focus/online triggers.
- Shared validation and client resource tests cover the wire contract; Core route
  tests cover self-service identity, independent users, validation and deletion.
- `db/user-preferences-migration.test.ts` runs the complete predecessor chain and
  the generated migration in a uniquely owned database, then checks idempotence,
  existing user preservation, JSON round-trip and cascading deletion.
- `routes/theme-presets.test.ts` and `db/theme-presets-migration.test.ts` cover
  the preset library the same way: owner isolation (another user's preset is a
  404, not a 403), revision conflicts, the per-user cap, cascading deletion and
  the generated `theme_presets` migration, plus Phase 2 sharing: scope isolation,
  attribution, the live-link read, visibility changes, moderated unsharing and
  duplication (own and shared sources).
- `ThemePresetLibrary.test.tsx` and `ThemeQuickPicker.test.tsx` cover the Phase 2
  UI: the Share/Unshare toggle, the Shared themes section, the permission-gated
  admin Remove action, the detached-shared "Keep a copy" notice, and the quick
  picker's single synthetic circle for an active foreign preset.

The full web gate passes (2,718 tests / 342 files as of Phase 2), including
its existing fixture coverage; the previously reported Universe fixture
failure was not reproduced in this gate. A real two-user, two-passkey
Chromium session (Phase 2's share → use → edit → reload → unshare → reload →
keep-a-copy walkthrough, against a throwaway instance) is verified — see
[custom themes](custom-themes.md#sharing-phase-2). Physical-device paint
behavior remains unverified. No unrelated layout repair or production
release is included.
