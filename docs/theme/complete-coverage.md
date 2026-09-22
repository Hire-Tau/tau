# Complete app-owned color coverage

The final sweep removes the legacy file allowlist rather than treating it as proof of completion. All app-owned palette utilities, black/white chrome, voice material colors, log terminal colors, image-viewer framing, progress SVG strokes and logo colors now resolve through registered tokens. Default colors and status meanings are preserved; this is not a redesign.

## Token contracts

- Status controls retain eleven tone steps (50–950) for each of the nine roles, alongside the seven semantic/badge slots. The steps preserve existing class variants and opacity modifiers exactly. All **162** status tokens participate in atomic custom override validation. This prevents a ramp override from bypassing status coherence. A custom document may still inherit the whole status family.
- Existing non-lifecycle decorative tone steps remain independent of status roles. Only used decorative steps are registered; no unused legacy color menu is restored.
- Paper surfaces, scrims, highlights, filled-control ink and toggle thumbs have separate chrome tokens. They are not aliases to a fixed white/black utility.
- Voice materials have named state/glass/shadow tokens. Intrinsic alpha multiplies custom alpha, just as utility modifiers do; the source never appends a second alpha slash to a custom value.
- Read-only system and sandbox logs have their own `--log-*` family. They retain their previous One Dark surface and xterm 5.5 ANSI defaults, distinct from interactive terminals. Both initialize from CSS before opening and observe live changes without reconnecting or losing scrollback. Authored ANSI indexes 16–255 remain xterm protocol colors.
- Brand gradient, underlying tile and glyph ink are themeable. Each mounted logo owns a unique SVG gradient ID so preview scopes cannot reference another logo's colors. The OS tile meta follows `--brand-tile`, including custom cold load.
- Added tone/material/log tokens are explicitly defined in every built-in scope. These categorical/material palettes retain their established colors across the built-ins; theme-specific chrome and semantic slots remain independently authored. Custom values can recolor every newly covered surface.

## Closed exceptions

The guard permits only these bounded findings, not whole-file legacy palettes:

1. One white QR quiet zone in `PairingCode` (generated image content).
2. One white sandboxed HTML document canvas each in `ArtifactRenderer` and `PresentationRenderer` (user-authored content). Presentation tables, chart containers and surrounding chrome are tokenized.
3. The custom editor's sample color and two contrast-math endpoints.
4. Seven minimal pre-CSS built-in surface fallbacks, tested against the authored palettes.
5. Universe's hovered-node inline swatch, supplied by its live token reader.

The scanner also catches black/white utilities and distinguishes numeric HTML entities from hex colors. New raw colors and stale exception entries fail the guard. Colors inside user documents, chart specs, images or isolated presentation HTML are never rewritten.

## Verification boundary

Frozen fixtures check exact utility and voice channels/alpha and log palette compatibility. Real Tailwind compilation checks every ramp utility and alpha modifier. Existing suites additionally cover all mapped-token opacity combinations, custom compilation/inheritance/reset, strict built-in critical-pair contrast, pre-paint migration and account/device/tab races.

Token completeness is not universal accessibility certification: arbitrary terminal/ANSI combinations, custom overrides and arbitrary tone-step pairings can have insufficient contrast. The editor warns for its documented pairs and offers safe values; it does not silently modify user content or block all low-contrast documents. Browser evidence is complementary to these tests, not implied by a passing source guard.
