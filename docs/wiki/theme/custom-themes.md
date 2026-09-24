# Custom themes and the theme preset library (v2)

Settings → Appearance → **My themes** is a per-user library of saved theme
presets (`/api/theme-presets`, owner-only — Phase 1 has no sharing). Each
preset covers **both light and dark** (or one constant variant for a unified
base like High contrast), so applying a preset follows the existing
Light/Dark/System toggle instead of locking the app to one concrete
appearance. **New**, **Duplicate**, **Edit**, **Rename**, **Delete** (with
confirmation), **Use** and **Export/Import** all operate on this library.
Editing a preset opens a token editor whose draft previews **live on the
whole app** (not a scoped sample) while it is open; nothing is persisted
until **Save** (existing preset, revision-checked `PUT`) or **Save as new**
(`POST`, forking a copy); closing without saving restores the previously
applied selection. There is still no public/cross-user gallery in this
phase — see the phase 2/3 notes at the end of this document.

```json
{
  "format": "tau-custom-theme",
  "version": 2,
  "name": "My night theme",
  "base": "harbor",
  "palette": { "primary": "#0ea5e9", "contrast": "standard", "status": "static" },
  "variants": {
    "light": {},
    "dark": { "--term-bg": "rgb(12, 20, 30)" }
  }
}
```

A v1 document (`version: 1`, one concrete `appearance` + `overrides`) still
loads everywhere: `validateCustomTheme` normalizes it into a v2 document with
the opposite dual side empty (or into a single `constant` variant for a
unified base). There is no user-visible "upgrade" step; the normalized v2
shape is what gets saved back on the next edit.

## Seed-color derivation (`palette`)

Hand-editing dozens of tokens per variant is tedious, so a preset can instead
set a handful of seed colors and let most tokens derive automatically. A
preset created from a built-in with no `palette` behaves exactly like a
plain explicit-override document; setting a `primary` color starts
derivation. `variants` stay available as an **advanced**, always-on-top
layer: explicit per-token overrides apply *after* derivation and win on
conflicts, exactly like today's token list and status-grid picker (now
tucked under an "Advanced" section once a palette is set).

The editor is seeds-first: a top-level "Palette" panel exposes Primary /
Secondary (optional) / Tertiary (optional) / Neutral (optional) color fields,
a Contrast segmented toggle (Standard/High) and a Status colors segmented
toggle (Static/Harmonized), all live-previewing the whole app immediately —
clearing Primary drops the palette back to a plain explicit-override
document. Everything from before (Base theme, the Light/Dark variant tabs,
the token-by-token Color token/Color value editor, the override list, and the
contrast-warnings/safe-value panel) moves into a collapsed `<details>`
"Advanced: per-token overrides" section, reachable at any time — a palette
and explicit overrides are never mutually exclusive.

```ts
palette?: {
  primary: string          // required once `palette` is present
  secondary?: string       // default: primary hue rotated +60°
  tertiary?: string        // default: primary hue rotated +300°
  neutral?: string         // tint for chrome/surfaces; default: primary hue at very low chroma
  contrast?: 'standard' | 'high'   // WCAG target for the contrast pass below; default 'standard'
  status?: 'static' | 'harmonized' // default 'static'
}
```

Derivation (`packages/shared/src/theme-derivation.ts`, pure — no DOM, a small
in-house sRGB↔OKLCH conversion in `color-oklch.ts`) maps every active token
into one of these buckets, keyed off `THEME_TOKEN_FAMILIES`:

| Bucket | Tokens | Rule |
| --- | --- | --- |
| Neutral/chrome | Backgrounds, text, borders, inputs, shadows, overlays, scrims, terminal/log **backgrounds** | Hue/chroma replaced by the neutral tint; **lightness and alpha preserved** from the base token, so the base theme's own contrast structure carries over. |
| Primary/accent | `--color-primary(-hover/-active/-light)`, selection bg/border, focus ring | Derived from the `primary` seed with a **lightness offset** and **chroma ratio** modeled on how that same token differs from the base theme's own `--color-primary` (so "hover" stays proportionally lighter than the seed the same way it is in Tau). |
| Ink | `--on-accent-fg` | Chosen as pure black or white by contrast against the *derived* primary, not hue-derived. |
| Brand/voice | Brand gradient/tile/ink, voice-material glows | Hue interpolated primary → secondary across the family; base lightness/chroma preserved. |
| Categorical | agent-type, badge-decoration, graph chart categories/links, a curated syntax-accent subset, utility-decoration | Hue picked from primary/secondary/tertiary by slot index; base lightness/chroma preserved. |
| Status (`static`, default) | The 162-token status grid | **Untouched** — absent from the derived overrides, so it keeps inheriting the base theme's own values. Semantic meaning (danger=red, success=green, ...) is never reassigned by a palette. |
| Status (`harmonized`) | Same grid | Each role's hue is bounded-shifted (≤22°, and clamped to never cross halfway into a neighboring role's own hue — roles cannot swap identities) toward whichever seed color is angularly nearest, chroma blended 30% toward that seed; **lightness stays per-step** so the ramp's contrast structure holds. Editor: a "Status colors: Static / Harmonized" toggle in the palette section, with live whole-app preview. |
| ANSI-named terminal/log/ansi slots | `--term-red`, `--log-blue`, `--ansi-*`, ... | Unchanged — these name a specific color by convention, independent of the palette. |

After derivation, a **contrast pass** nudges a small set of critical derived
pairs (`--color-text-primary`/`--color-bg-surface`, `--color-text-secondary`/
`--color-bg-surface`, `--color-primary`/`--color-bg-page`, and the harmonized
status fg/surface pairs) toward the WCAG target — 4.5:1, or 7:1 for
`contrast: 'high'` — by moving **lightness only** (never hue or chroma), via
bisection against the fixed background. `--on-accent-fg`'s black/white choice
already clears 4.5:1 for any input color by construction (the
minimum achievable max-contrast of that binary choice is ≈4.58:1). A
property-style test sweeps dozens of seed colors, in both appearances, and
asserts every built-in critical pair still clears its target.

Derivation needs the base theme's own resolved token values (to preserve
lightness/chroma/alpha), which only exist in the CSS cascade — matching the
"no copied runtime palette" rule this file has always followed. `apps/web`
supplies them via `getComputedStyle` once the built-in CSS has painted, then
`compileCustomTheme(doc, appearance, baseTokens)` merges derived-under-explicit
before compiling. This is unavailable in the **synchronous pre-paint flash
script**, which cannot trust the cascade that early (the same reason it has
always kept a small hardcoded surface-color fallback table instead of reading
computed style): the flash script applies a palette document's explicit
`variants` overrides only, and the full derived look appears on the very next
repaint once `ThemeProvider` mounts — a single-frame, non-visible-in-practice
gap, not a persistent flash of the wrong theme.

## Validation and application boundary

- `packages/shared/src/custom-theme.ts` owns the dependency-free schema, validator and compiler. Input is capped at **32 KiB UTF-8 before parsing**, including whitespace — up from 8 KiB because a v2 pair can carry a FULL light+dark override of every active token at once (a v1 document only ever needed one side of the grid); the cap is sized against a measured worst-case full-pair document (`#rrggbbaa` values on every token, both variants, a 40-character name — see the "worst-case pair" test). Override count per variant cannot exceed the token registry count. Names are 1–40 Unicode code points and rendered only as text.
- Values accept `#rgb`, `#rrggbb`, `#rrggbbaa`, comma-form `rgb()` with integer channels 0–255, or `rgba()` with integer RGB and alpha 0–1 (fractional alpha is supported); this closed grammar covers explicit overrides AND palette seed colors. No named colors, percentages, fractional RGB input, CSS references, URLs, comments, declarations or arbitrary functions are accepted.
- Unsupported versions are refused with an explanation; both `version: 1` and `version: 2` are accepted on read, `version: 2` is the only write shape. Unknown/inactive tokens are warned about and discarded per variant; their values still undergo the same safety checks. Unknown top-level fields (including a stray v1 `appearance` on a v2 document) are not persisted in the normalized document.
- Any status override requires the **entire 162-token grid** (nine roles × (seven semantic slots + eleven tone steps)), validated **independently per variant** before inheritance — the same rule as v1, just applied to light and dark separately. Imports must supply it explicitly for whichever variant(s) they touch.
- Every application revalidates: `applyCustomTheme(element, doc, appearance)` re-runs `validateCustomTheme` before compiling, then writes only individually validated, registry-owned properties through `style.setProperty`; no custom CSS/HTML text is assembled. Static built-in CSS scopes also match the preview element, preventing inherited root overrides from contaminating the preview base.
- Colors retain their full channels/alpha for ordinary CSS and graph/xterm readers. Compiler-owned `--custom-rgb-*` and `--custom-alpha-*` properties let opacity-modified utilities multiply **custom alpha × intrinsic alpha × utility opacity** without invalid double-slash RGB syntax. Imports cannot set these helper names or intrinsic metadata. Preview scopes explicitly mask inherited helpers; reset removes them from the root.

Concrete graph/chart and interactive/log-terminal adapters expand JavaScript exponent notation to plain decimal color arguments. This preserves tiny numeric alpha and intrinsic-alpha products for the actual dependency parsers without rounding them to opaque. xterm quantizes colors to eight-bit channels; its existing opaque-selection policy still uses 30% selection opacity. These renderer rules do not broaden the accepted import grammar.

## The editor's whole-app live preview

The preset editor (`CustomThemeEditor`, opened from **My themes**) paints its
draft directly onto `document.documentElement` — the same pure-DOM
`paintRoot` path `ThemeQuickPicker`'s hover preview uses (factored into
`theme/preview.ts` so both share it) — instead of a scoped sample div. For a
dual base it exposes Light/Dark tabs that each preview and edit their own
variant independently; a unified base has no tabs. Opening the editor never
persists anything; **Save**/**Save as new** are the only writes. Closing the
editor — Cancel, Save success, or simply unmounting — always restores the
previously applied selection by re-reading the theme store's snapshot, never
the in-progress draft. (Implementation note: React fires layout effects
child-before-parent, so the editor's first paint runs inside a microtask —
scheduled after every layout effect in the same commit, including
`ThemeProvider`'s own, but still before the browser paints — so its initial
frame is never clobbered by the provider's unrelated repaint.)

The saved key is `tau-custom-theme`; a device-local `tau-theme-preset-id` key
remembers which library preset the active document came from (or is absent
when detached — a built-in selection, a one-off import, or the preset's own
row was later deleted; the applied document snapshot keeps working either
way). Invalid saved documents are removed with stale surface snapshots, and
the declared known base is restored (otherwise the last safe built-in
selection). Application failure removes partial overrides and restores the
base without reloading. Denied storage is best-effort: the in-memory theme
works, and the UI explains when persistence is unavailable.

The synchronous pre-paint bootstrap uses the **same validator and compiler**
as React (minus palette derivation, see above). It applies validated
explicit overrides before CSS/React, derives its custom surface from the
document rather than a stale snapshot, and performs the same recovery.
`apps/web/index.html` contains generated code; regenerate after changing its
dependencies:

```sh
bun apps/web/scripts/generate-theme-flash.ts
```

A test compares the shipped script to a fresh bundle under the pinned Bun version, alongside built-in and custom cold-load matrices (v1 and v2, light/dark/system). This adds no runtime dependency.

## Contrast tooling (per-variant, in the editor)

The editor reuses the built-in contrast computation and critical-pair inventory for whichever variant tab is open, including fractional channels and intrinsic opacity. Failing pairs show informational ratios and a **Use safe value** action choosing opaque black or white foreground against the completely composited surface. Other surfaces and islands are checked over the whole-app page/surface, with explicit status/badge under-surfaces resolved recursively. An opaque layer ends the chain. A translucent page with no known opaque foundation is reported as **Contrast unknown**, with no safe-value recommendation for that pair. Ratios and suggested values use the same resolved backdrop; tiny alpha values retain scientific notation numerically. Warnings never block Save. A safe value improves the named pair, not a certification of every use of that token; other warnings may remain. Arbitrary ANSI combinations, authored content and arbitrary utility-tone pairings are not certified.

## Regression coverage

- Shared: closed grammar/rejection, byte/count caps (including the worst-case-pair measurement), unknown-name and pre-inheritance coherence per variant, v1→v2 normalization, `compileCustomTheme`'s resolved-variant selection, OKLCH round-trip fidelity (`color-oklch.test.ts`), derivation buckets + harmonized-status bounding + the multi-seed contrast-pass property test (`theme-derivation.test.ts`), preset request-schema/cap tests (`theme-preset.test.ts`).
- Core: owner-scoped preset CRUD (`GET/POST /theme-presets`, `GET/PUT/DELETE /theme-presets/:id`) — isolation, revision conflicts (409), validation (422), per-user cap (409), cascade on user deletion, and the generated `theme_presets` migration.
- Web: custom preview isolation and complete inheritance, invalid-document fallback, import/export round trip, partial-application cleanup, graph/xterm observer repaint and reset, a real-CSS-cascade palette-derivation integration test (explicit overrides still win over derived values), the editor's whole-app live preview (open/tab-switch/Cancel/unmount all repaint or restore correctly, including the mount-ordering fix above), the preset library's New/Duplicate/Rename/Delete/Use/Export/Import flows, and `ThemeQuickPicker` rendering one circle per saved preset (in addition to the built-ins) with a selection ring keyed on the active preset id.
- Actual generated utility substitution covers all mapped tokens with custom alpha and intrinsic/utility opacity; built-in palette parity and contrast gates remain unchanged.
- Security source checks prohibit CSS/HTML text writes in the custom application path; pre-paint generation cannot drift from the shared validator/compiler.

Physical-device/PWA cold-launch and authenticated account navigation are not certified by these tests. The inherited Universe fixture/layout limitation remains outside this change.

## What Phase 2 and Phase 3 build on this

- **Phase 2 (sharing)**: the schema already carries `visibility: 'private' | 'instance'` on every preset (default `'private'`); Phase 1 never sets it to `'instance'` and every route is owner-only. Phase 2 adds: a route to toggle visibility, a route (and UI) to list/browse instance-shared presets, an admin remove action, and a "Use" path for a shared preset that is a **live link** (the author's later edits show up on the follower's next load) versus "Duplicate" (an independent copy) — both map cleanly onto the existing `presetId` field on `ThemePreference` and the existing revision-checked update/delete routes.
- **Phase 3 (theme-building assistant)**: attaches to the existing page-editor framework and the editor built here, since the editor already (a) keeps a draft separate from the saved document, (b) live-previews the whole app while open, and (c) exposes seed colors as the primary edit surface (`palette.primary/secondary/tertiary/neutral`, plus the `status` and `contrast` modes) rather than 400+ individual tokens — an assistant can converse in terms of "make it warmer" / "more contrast" and mutate 2–4 seed values instead of walking the whole token grid.

### Historical phase-6 verification (2026-09-21)

These counts and browser results record that phase, not the completed rollout or account-sync verification. The subsequent whole-rollout Universe initialization limitation and physical/authenticated coverage limits remain explicit.

The full web and deterministic mixed/reversed DOM-order gates passed (2,395 tests before two additional targeted guards); the two new guards also passed. Shared theme suites: 79 passing. Web typecheck and production build passed.

Chromium real-renderer fixture: 14 custom pre-paint/recovery cases (all seven concrete built-ins, valid/invalid documents, React module blocked), plus file import, isolated preview, alpha-modified utilities, apply/reset, export download, contrast warning/safe-value, 390px layout and forced-colors checks. The real xterm instance retained its scrollback across apply/reset; the graph token bridge changed synchronously. No uncaught browser errors. These use synthetic local data, not an authenticated account or a remote terminal session.

[Editor screenshot](screenshots/custom-theme-editor.png) shows a deliberately low-contrast imported theme after repairing one foreground pair; remaining warnings are expected and Apply stays available.

### Contrast review corrections

The transparent-surface regression now resolves white text over a transparent white surface to its dark page (`9 10 18`), approximately **19.74:1**, rather than falsely treating the hidden white channels as the backdrop. Black text on that stack is correctly warned at **1.06:1**, and its safe-value action restores white. [Repaired preview](screenshots/transparent-surface-repaired.png).

Chromium checks covered the actual preview and safe-value actions at surface alpha 0, 0.25, 0.5 and 0.75; a partially transparent terminal island over a partially transparent surface; unknown backing with no safe-value claim; and a `0.0000001` foreground-alpha warning/action. No uncaught browser errors. Seven new unit/component cases cover backdrop composition, uncertainty and the validator → compiler → contrast tiny-alpha path.

After these corrections, the full web gate passed **2,404 tests** and web typecheck passed. The complete recorded DOM-order gate also passed on recheck without code or timeout changes. Its first attempt timed out in the unchanged light/dark syntax-render parity cases (82s/63s); that unsuccessful run is not counted as passing, and its cause was not established.
