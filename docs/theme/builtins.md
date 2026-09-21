# Built-in themes and picker

## Intent and compatibility

- **Tau** (`tau`, dual) remains the default theme and light remains the fresh-install appearance.
- **Harbor** (`harbor`, dual): cool slate surfaces, restrained teal actions, dark blue-gray code/graph islands.
- **Ember** (`ember`, dual): warm paper/charcoal surfaces and terracotta actions, warm dark code/graph islands.
- **High contrast** (`high-contrast`, unified): constant light ink-on-paper chrome, strong black boundaries and black code/graph backgrounds. This is not an application-wide AAA certification.

The two recolors preserve status meanings and all seven used decorative Badge palettes. Every new CSS scope explicitly defines the full active token set plus intrinsic-opacity metadata. Fractional syntax channels, graph/status aliases, xterm's `none` selected-ink sentinel and `auto` scrollbar sentinel are retained. No runtime color generation or new runtime dependency is involved. Brand, authored artifact colors, arbitrary ANSI foreground/background combinations and remaining legacy palette utilities are not claimed to be fully themeable or contrast-certified.

The Settings control has a native labeled theme selector and Light/Dark/System selector. Unified themes disable appearance and explain why; switching back restores the previously selected appearance. Selection, surface snapshot (including `constant`), document background and theme-color meta update together before paint. The existing legacy toggle remains the rollback UI while `THEME_PICKER_ENABLED` is false.

## Release gate — enabled

The picker is **enabled** after every built-in passed the strict contrast gate and the cold-load matrix. On 2026-09-21 the owner authorized a narrow exception to default-palette parity: minimally correct the six failing Tau tokens, while preserving its default selection and overall identity. No legacy contrast carve-out was added.

### Authorized Tau deltas (worst applicable pair)

| Token                              | Previous channels             | New channels                  | Before → after ratio |
| ---------------------------------- | ----------------------------- | ----------------------------- | -------------------: |
| Muted and placeholder text (light) | `114 109 129`                 | `111 106 126`                 |        4.389 → 4.586 |
| Scrollbar (light, composited)      | `156 163 175 / 0.5`           | `55 65 81 / 0.65`             |        1.453 → 3.585 |
| Scrollbar (dark, composited)       | `156 163 175 / 0.5`           | `156 163 175 / 0.6`           |        2.621 → 3.178 |
| Syntax comment (both)              | `91.8 98.6 112.2`             | `141.8 148.6 162.2`           |        2.308 → 4.634 |
| Syntax property (both)             | `223.7625 107.7375 117.40625` | `226.7625 111.7375 121.40625` |        4.375 → 4.567 |
| Terminal-muted (both)              | `107 114 128`                 | `118 125 139`                 |        3.942 → 4.607 |

Only these token values change in Tau. The syntax parity test explicitly substitutes the two authorized inks; all other syntax styles, ANSI/terminal slots, status and decorative palettes retain their parity checks. The dark muted/placeholder text remains unchanged.

The gate checks **356 pairs per concrete palette** with sRGB WCAG luminance, fractional channels, foreground alpha and surface alpha × intrinsic-opacity metadata. Text requires 4.5:1; focus, scrollbars and graph links require 3:1. Covered: four text roles on six chrome surfaces, inline code, nine status roles and hover badges, seven decorative badge palettes, six agent identities, all syntax inks on both code surfaces, terminal text/muted/cursor, accent button states and graph labels/links. Status/badge translucent surfaces are composited over every likely underlying chrome surface.

| Palette       | Lowest text ratio | Lowest indicator ratio | Failing pairs |
| ------------- | ----------------: | ---------------------: | ------------: |
| Tau light     |             4.567 |                  3.585 |             0 |
| Tau dark      |             4.567 |                  3.178 |             0 |
| Harbor light  |             4.682 |                  3.302 |             0 |
| Harbor dark   |             4.908 |                  3.302 |             0 |
| Ember light   |             4.641 |                  3.391 |             0 |
| Ember dark    |             4.857 |                  3.391 |             0 |
| High contrast |             4.760 |                  3.657 |             0 |

These are defined-token-pair checks, not certification of every rendered page, text opacity utility, terminal SGR combination or third-party chart scheme.

## Cold-load matrix

The shipped inline script contains a minimal surface map, checked against the registry and actual CSS, so missing/corrupt/stale snapshots and an OS scheme flip cannot paint a default white surface over a stored dark/recolored theme. A matching state-keyed snapshot still wins. Unknown IDs retain the Tau fallback. Unified themes omit data-appearance and remove the dark migration class.

- Unit matrix: 4 themes × 3 appearance settings × 2 OS schemes × 4 snapshot cases = **96** pre-paint cases.
- Provider matrix: 4 × 3 × 2 = **24** cases plus interaction coverage of unified → dual preference retention.
- Chromium: actual shipped HTML with the application module blocked (no React/CSS assistance), 4 × (light, dark, system-light, system-dark) × (missing, corrupt, stale, matching snapshot) = **64** cases. Document scope, dark class, background and theme-color all matched before hydration.

## Render matrix and limits

Chromium real-renderer fixture, synthetic local data, 1280×1100: **96** cases (six panels × four themes × light/dark/system-light/system-dark) without uncaught browser errors. This is not authenticated application navigation or a live service/session test.

| Requested surface          | Actual paths reviewed in each theme/appearance                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Feed / work streams        | `FeedPage`, real `WorkStreamList` rows, status and decorative `Badge`s; pending-action source is synthetic and visit-summary is omitted          |
| Chat / tools / code / ANSI | Real `MarkdownContent`, bash `ToolArgsView`/`ToolResultView`, `AnsiText`                                                                         |
| Squads / graphs            | Real `OrgGraph` and `AgentVisualization` 2D canvases; additional real 3D switch; mounted graph canvas retained across theme switches             |
| Settings                   | Real `ThemeControl` with `ThemeProvider`; full Settings navigation covered by component suites, not authenticated browser navigation             |
| Voice                      | Real `VoiceWorkspacePage` with a deterministic listening hook, no microphone/network session                                                     |
| Presentation / file viewer | Real `PresentationRenderer` with Vega-Lite chart and `FileViewer` with a TypeScript file                                                         |
| Terminal                   | Real xterm, `readTerminalTheme` and root observer; theme changes repaint the existing terminal without discarding it; no remote shell connection |

**Unverified:** successful `SquadUniverse` WebGL rendering (inherited tick/layout initialization failure already reproduced on the predecessor and its baseline), authenticated full-page flows, physical iOS Safari/PWA cold launch, Windows hardware high-contrast rendering, arbitrary artifact-authored palettes. No unrelated graph layout repair is included. Existing legacy palette islands remain visible, notably presentation framing and voice gradients; do not interpret the token matrix as zero remaining raw colors.

## Forced-colors checklist (each of Tau, Harbor, Ember, High contrast)

- [x] Chromium forced-colors emulation with reduced motion and reduced transparency: author inset shadows disappear; primary buttons still have a system-color boundary and focus outline.
- [x] Native selectors retain labels and focus; unified appearance is disabled with explanatory text.
- [x] Voice gradient layers may flatten/disappear; orb has a real system-color outline and its status is displayed as text (`Listening`), rather than relying on glow/dots.
- [x] No `forced-color-adjust: none` escape is introduced; built-in/custom theme colors are cosmetic under the user's forced palette.
- [ ] Physical Windows high-contrast / assistive-technology pass (not performed).

The browser review caught the existing `voice-orb-status { display: none }`; the forced-colors rule explicitly restores its display, hides decorative dots and exposes its accessible label visually. A color/box-shadow-only fallback would have missed this.

## Verification (2026-09-21)

After the authorized Tau corrections and picker enablement:

- Full web gate: **2,383 passing, 0 failing**, 311 files.
- Deterministic DOM-order gate: passed, including the full mixed/reversed cohorts.
- Web typecheck and production build: passed.
- Browser matrix rerun against the enabled picker and corrected Tau: **164 cases**, no uncaught errors (96 render, 4 forced-colors, 64 pre-paint), plus mounted canvas/xterm continuity and mobile selector review.
- The six-token Tau change keeps all remaining content/status/decorative parity assertions intact.

Browser evidence uses synthetic fixture data and the real components/libraries listed above. Screenshot review does not replace the specific limitations listed in the matrix.

### Review screenshots

Synthetic fixture, actual renderers (not live account data):

- [Harbor light: Feed, work-stream rows, picker and badges](screenshots/harbor-light.png)
- [Ember dark: chat, syntax, tools and ANSI](screenshots/ember-dark.png)
- [High contrast: unified picker, Feed and badges](screenshots/high-contrast.png)
