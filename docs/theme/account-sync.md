# Account theme sync

Theme/appearance and the **custom theme document** sync together. The existing
8 KiB custom-document cap fits a single `user_preferences.theme` JSONB field;
there is no palette copy, new runtime dependency, or change to custom color,
status coherence, sentinel inheritance, intrinsic-opacity or contrast rules.
Migration `0184_same_tinkerer.sql` was generated with `bun db:generate`. It adds
one row per user, an update timestamp and a cascading user foreign key. An absent
row is **no account choice**, not a default value to upload.

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
- Picker copy identifies the override and offers **Use synced theme**. This clears
  the flag, discards unsent changes and rereads the server after outstanding writes.
  If offline, the current palette stays visible and adoption resumes on reconnect.
  A newer deliberate edit cancels adoption. Reset to default is deliberately a new
  local/account choice, not a synonym for following the account.
- Deliberate edits made in a connected authenticated session push best-effort.
  In-flight writes are serialized; unsent edits coalesce to the latest value.
  Offline pending edits retry on focus, visibility or reconnect **within that
  session only**. Login/reload never uploads an old local cache automatically.
  Across devices the last successful whole-preference write wins on the account;
  each device with an override keeps its own choice. Storage events also honor
  a deliberate choice made in another tab, without echoing an upload.
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
returns `{ userId, theme: null | { themeId, appearance, customTheme } }`.
`updateMine({ expectedUserId, theme }, signal?)` calls `PUT` on the same path.
This is an atomic whole-theme replacement, not a partial merge. Unknown IDs,
appearances, versions, unsafe values, partial status roles, base/variant mismatch
and oversized documents are rejected before persistence; the HTTP envelope is
also bounded to 9 KiB. The browser revalidates remote documents before applying.

## Verification

- `theme/sync.test.ts`: migration/conflict rules, custom sync, clear/adopt, delayed
  GET/PUT, logout/account replacement, disconnected retries and denied storage.
- `providers/ThemeAccountSync.test.tsx`: actual generated flash script → React
  hydration → differing server value → reconnect/adopt, StrictMode paint gating,
  cancellation and signed-out behavior. Adoption never echoes a PUT.
- Shared validation and client resource tests cover the wire contract; Core route
  tests cover self-service identity, independent users, validation and deletion.
- `db/user-preferences-migration.test.ts` runs the complete predecessor chain and
  the generated migration in a uniquely owned database, then checks idempotence,
  existing user preservation, JSON round-trip and cascading deletion.

The full web gate passes (2,420 tests / 316 files), including its existing fixture
coverage; the previously reported Universe fixture failure was not reproduced in
this gate. Physical-device paint behavior and a real passkey-authenticated
multi-device browser session remain unverified. No unrelated layout repair or
production release is included.
