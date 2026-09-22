# Custom themes (v1)

In Settings → Theme, **Edit custom theme** opens a token editor whose draft and preview stay on this device. Importing or editing changes only its preview, not the account preference. **Apply custom theme** confirms the selection and, when signed in, syncs the validated document to the account preference stored on the server; **Reset to default** returns to Tau/light and removes the saved custom document. Selecting another built-in or appearance also clears custom overrides. Export downloads `tau-custom-theme.json`. There is no public gallery or publication. Local storage supplies immediate rendering and pre-paint recovery; applied documents also participate in [account synchronization](account-sync.md), including device overrides and **Use synced theme**. Without an account session, changes remain local.

```json
{
  "format": "tau-custom-theme",
  "version": 1,
  "name": "My night theme",
  "base": "harbor",
  "appearance": "dark",
  "overrides": {
    "--color-primary": "#0ea5e9",
    "--term-bg": "rgb(12, 20, 30)"
  }
}
```

A document defines **one concrete appearance**, not an automatic light/dark pair. Dual bases accept `light` or `dark`; High contrast requires `constant`. Missing tokens inherit the selected built-in, including its fractional syntax channels, terminal selection/scrollbar sentinels, supporting graph/chart/ANSI slots and intrinsic-opacity metadata. Brand gradient, tile and ink tokens are active, alongside voice material, chrome and read-only log tokens; see [complete coverage](complete-coverage.md).

## Validation and application boundary

- `packages/shared/src/custom-theme.ts` owns the dependency-free schema, validator and compiler. Input is capped at **8 KiB UTF-8 before parsing**, including whitespace; override count cannot exceed the token registry count. Names are 1–40 Unicode code points and rendered only as text.
- Values accept `#rgb`, `#rrggbb`, `#rrggbbaa`, comma-form `rgb()` with integer channels 0–255, or `rgba()` with integer RGB and alpha 0–1 (fractional alpha is supported). No named colors, percentages, fractional RGB input, CSS references, URLs, comments, declarations or arbitrary functions are accepted. Built-in fractional channels and sentinels are inherited, not valid imported color values.
- Unsupported versions are refused with an explanation. Unknown/inactive tokens are warned about and discarded; their values still undergo the same safety checks. Unknown top-level fields are not persisted in the normalized document.
- Any status override requires the **entire 162-token grid: nine roles × (seven semantic slots + eleven tone steps)**, validated before inheritance. The picker initializes this set from the base when editing a status token and removes it as a set. Imports must supply it explicitly.
- Every application revalidates. `apps/web/src/theme/custom.ts` writes only individually validated, registry-owned properties through `style.setProperty`; no custom CSS/HTML text is assembled. Static built-in CSS scopes also match the preview element, preventing inherited root overrides from contaminating the preview base.
- Colors retain their full channels/alpha for ordinary CSS and graph/xterm readers. Compiler-owned `--custom-rgb-*` and `--custom-alpha-*` properties let opacity-modified utilities multiply **custom alpha × intrinsic alpha × utility opacity** without invalid double-slash RGB syntax. Imports cannot set these helper names or intrinsic metadata. Preview scopes explicitly mask inherited helpers; reset removes them from the root.

## Contrast and recovery

The editor reuses the built-in contrast computation and critical-pair inventory, including fractional channels and intrinsic opacity. Failing pairs show informational ratios and a **Use safe value** action choosing opaque black or white foreground against the completely composited surface. The preview renders a page backdrop around its surface; other surfaces and islands are checked over that surface, then the page, with explicit status/badge under-surfaces resolved recursively. An opaque layer ends the chain. A translucent page with no known opaque foundation is reported as **Contrast unknown**, with no safe-value recommendation for that pair. Ratios and suggested values use the same resolved backdrop; tiny alpha values retain scientific notation numerically. Warnings never block Apply. A safe value improves the named pair, not a certification of every use of that token; other warnings may remain. Arbitrary ANSI combinations, authored content and arbitrary utility-tone pairings are not certified.

The saved key is `tau-custom-theme`. Invalid saved documents are removed with stale surface snapshots, and the declared known base is restored (otherwise the last safe built-in selection). Application failure removes partial overrides and restores the base without reloading. Denied storage is best-effort: the in-memory theme works, and the UI explains when persistence is unavailable.

The synchronous pre-paint bootstrap uses the **same validator and compiler** as React. It applies validated custom properties before CSS/React, derives its custom surface from that document rather than a stale snapshot, and performs the same recovery. `apps/web/index.html` contains generated code; regenerate after changing its dependencies:

```sh
bun apps/web/scripts/generate-theme-flash.ts
```

A test compares the shipped script to a fresh bundle under the pinned Bun version, alongside built-in and custom cold-load matrices. This adds no runtime dependency.

## Regression coverage

- Shared grammar/rejection, byte/count caps, unknown-name and pre-inheritance coherence tests.
- Custom preview isolation and complete inheritance, invalid-document fallback, import/export round trip, partial-application cleanup, graph/xterm observer repaint and reset.
- Editor interactions: preview-before-confirmation, contrast warnings/safe-value, complete status grid, apply, export, invalid import, reset and provider recovery.
- Actual generated utility substitution covers all mapped tokens with custom alpha and intrinsic/utility opacity; built-in palette parity and contrast gates remain unchanged.
- Security source checks prohibit CSS/HTML text writes in the custom application path; pre-paint generation cannot drift from the shared validator/compiler.

Physical-device/PWA cold-launch and authenticated account navigation are not certified by these tests. The inherited Universe fixture/layout limitation remains outside this change.

### Historical phase-6 verification (2026-09-21)

These counts and browser results record that phase, not the completed rollout or account-sync verification. The subsequent whole-rollout Universe initialization limitation and physical/authenticated coverage limits remain explicit.

The full web and deterministic mixed/reversed DOM-order gates passed (2,395 tests before two additional targeted guards); the two new guards also passed. Shared theme suites: 79 passing. Web typecheck and production build passed.

Chromium real-renderer fixture: 14 custom pre-paint/recovery cases (all seven concrete built-ins, valid/invalid documents, React module blocked), plus file import, isolated preview, alpha-modified utilities, apply/reset, export download, contrast warning/safe-value, 390px layout and forced-colors checks. The real xterm instance retained its scrollback across apply/reset; the graph token bridge changed synchronously. No uncaught browser errors. These use synthetic local data, not an authenticated account or a remote terminal session.

[Editor screenshot](screenshots/custom-theme-editor.png) shows a deliberately low-contrast imported theme after repairing one foreground pair; remaining warnings are expected and Apply stays available.

### Contrast review corrections

The transparent-surface regression now resolves white text over a transparent white surface to its dark page (`9 10 18`), approximately **19.74:1**, rather than falsely treating the hidden white channels as the backdrop. Black text on that stack is correctly warned at **1.06:1**, and its safe-value action restores white. [Repaired preview](screenshots/transparent-surface-repaired.png).

Chromium checks covered the actual preview and safe-value actions at surface alpha 0, 0.25, 0.5 and 0.75; a partially transparent terminal island over a partially transparent surface; unknown backing with no safe-value claim; and a `0.0000001` foreground-alpha warning/action. No uncaught browser errors. Seven new unit/component cases cover backdrop composition, uncertainty and the validator → compiler → contrast tiny-alpha path.

After these corrections, the full web gate passed **2,404 tests** and web typecheck passed. The complete recorded DOM-order gate also passed on recheck without code or timeout changes. Its first attempt timed out in the unchanged light/dark syntax-render parity cases (82s/63s); that unsuccessful run is not counted as passing, and its cause was not established.
