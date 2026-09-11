import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const srcDir = join(import.meta.dir)
const indexCss = readFileSync(join(srcDir, 'index.css'), 'utf8')
const appTsx = readFileSync(join(srcDir, 'App.tsx'), 'utf8')
const appNavTsx = readFileSync(join(srcDir, 'components/AppNav.tsx'), 'utf8')

describe('PWA app shell scroll locking', () => {
  test('locks html, body, and root to the viewport so the document cannot rubber-band scroll', () => {
    expect(indexCss).toContain('html,\n  body,\n  #root')
    expect(indexCss).toContain('height: 100%')
    expect(indexCss).toContain('overflow: hidden')
    expect(indexCss).toContain('overscroll-behavior: none')
  })

  test('marks the authenticated app shell as the root scroll boundary', () => {
    expect(appTsx).toContain('data-testid="app-shell"')
    expect(appTsx).toContain('overscroll-none')
    expect(appTsx).toContain('overflow-hidden')
  })

  test('full-screen shells size off the html/body 100% chain, not dvh units', () => {
    // In iOS standalone with black-translucent + viewport-fit=cover, 100dvh
    // resolves to the safe-area-reduced height while the html/body/#root chain
    // (height:100% + body{position:fixed;inset:0}) fills the real full-screen
    // viewport — a dvh-sized shell floats the bottom dock ~96px above the
    // screen edge. Anchor shells to the 100% chain instead.
    const loginTsx = readFileSync(join(srcDir, 'components/LoginPage.tsx'), 'utf8')
    expect(appTsx).not.toContain('100dvh')
    expect(loginTsx).not.toContain('100dvh')
    expect(appTsx).toContain('h-full max-h-full')
  })

  test('the app header owns the top safe-area inset so its surface background fills the notch region', () => {
    // Header itself carries safe-area-pt + bg-surface, mirroring the bottom dock's safe-area-pb pattern.
    expect(appNavTsx).toContain('bg-surface')
    expect(appNavTsx).toContain('safe-area-pt')
  })

  test('does not render a separate fixed top safe-area overlay (header handles it)', () => {
    expect(appTsx).not.toContain('app-top-safe-area')
  })

  test('the bottom dock still owns the bottom safe-area inset', () => {
    expect(appNavTsx).toContain('safe-area-pb')
  })

  test('status banners render in-flow below the header instead of fixed overlays', () => {
    const updateBanner = readFileSync(join(srcDir, 'components/UpdateBanner.tsx'), 'utf8')
    const offlineBanner = readFileSync(join(srcDir, 'components/OfflineBanner.tsx'), 'utf8')
    expect(updateBanner).not.toContain('fixed')
    expect(offlineBanner).not.toContain('fixed')
    // Banners sit after the header in the flex column, so the header keeps owning the safe area.
    expect(appTsx.indexOf('<AppHeader />')).toBeLessThan(appTsx.indexOf('<UpdateBanner />'))
    expect(appTsx.indexOf('<AppHeader />')).toBeGreaterThan(-1)
  })

  test('keeps route content inside a contained app scroll container', () => {
    expect(appTsx).toContain('data-testid="app-scroll-container"')
    expect(appTsx).toContain('overscroll-contain')
    expect(appTsx).toContain('[-webkit-overflow-scrolling:touch]')
  })
})
