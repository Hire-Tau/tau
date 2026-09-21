# Built-in themes and picker

## Intent and compatibility

- **Tau** (`tau`, dual) remains the default theme and light remains the fresh-install appearance.
- **Harbor** (`harbor`, dual): cool slate surfaces, restrained teal actions, dark blue-gray code/graph islands.
- **Ember** (`ember`, dual): warm paper/charcoal surfaces and terracotta actions, warm dark code/graph islands.
- **High contrast** (`high-contrast`, unified): constant light ink-on-paper chrome, strong black boundaries and black code/graph backgrounds. This is not an application-wide AAA certification.

The two recolors preserve status meanings and all seven used decorative Badge palettes. Every new CSS scope explicitly defines the full active token set plus intrinsic-opacity metadata. Fractional syntax channels, graph/status aliases, xterm's `none` selected-ink sentinel and `auto` scrollbar sentinel are retained. No runtime color generation or new runtime dependency is involved. Brand, authored artifact colors, arbitrary ANSI foreground/background combinations and remaining legacy palette utilities are not claimed to be fully themeable or contrast-certified.

The Settings control has a native labeled theme selector and Light/Dark/System selector. Unified themes disable appearance and explain why; switching back restores the previously selected appearance. Selection, surface snapshot (including `constant`), document background and theme-color meta update together before paint. The existing legacy toggle remains the rollback UI while `THEME_PICKER_ENABLED` is false.

## Release gate — pending default-palette decision

The picker remains **disabled** until the default-palette conflict is resolved. The requirement to keep Tau unchanged conflicts with the new all-built-in contrast gate. No failing pair is silently excluded: `builtins.test.ts` currently exposes the inherited Tau failures. The proposed correction is to adjust only its failing muted/placeholder, scrollbar, syntax comment/property and terminal-muted tokens, not its selection defaults or status/decorative identities. Owner decision pending.

The gate checks **356 pairs per concrete palette** with sRGB WCAG luminance, fractional channels, foreground alpha and surface alpha × intrinsic-opacity metadata. Text requires 4.5:1; focus, scrollbars and graph links require 3:1. Covered: four text roles on six chrome surfaces, inline code, nine status roles and hover badges, seven decorative badge palettes, six agent identities, all syntax inks on both code surfaces, terminal text/muted/cursor, accent button states and graph labels/links. Status/badge translucent surfaces are composited over every likely underlying chrome surface.

| Palette               | Lowest text ratio | Lowest indicator ratio | Failing pairs |
| --------------------- | ----------------: | ---------------------: | ------------: |
| Tau light (inherited) |             2.308 |                  1.453 |            16 |
| Tau dark (inherited)  |             2.308 |                  2.621 |            10 |
| Harbor light          |             4.682 |                  3.302 |             0 |
| Harbor dark           |             4.908 |                  3.302 |             0 |
| Ember light           |             4.641 |                  3.391 |             0 |
| Ember dark            |             4.857 |                  3.391 |             0 |
| High contrast         |             4.760 |                  3.657 |             0 |

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
