import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import sharp from 'sharp'
import { COLORS, generate, OUT_DIR } from './generate'

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out.sort()
}

function hex(color: string): [number, number, number] {
  const n = Number.parseInt(color.replace('#', ''), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ficus-brand-generate-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('brand icon generator', () => {
  it('is byte-for-byte deterministic against the committed brand/generated/ output', async () => {
    await generate(tmpDir)

    const committedFiles = listFiles(OUT_DIR).map((f) => relative(OUT_DIR, f))
    const freshFiles = listFiles(tmpDir).map((f) => relative(tmpDir, f))
    expect(freshFiles).toEqual(committedFiles)

    for (const rel of committedFiles) {
      const committed = readFileSync(join(OUT_DIR, rel))
      const fresh = readFileSync(join(tmpDir, rel))
      if (!fresh.equals(committed)) {
        throw new Error(`${rel} differs between the committed output and a fresh render`)
      }
    }
  })

  describe('expected dimensions', () => {
    const cases: Array<[string, number, number]> = [
      ['web/favicon-16x16.png', 16, 16],
      ['web/favicon-32x32.png', 32, 32],
      ['web/apple-touch-icon.png', 180, 180],
      ['web/icon-72x72.png', 72, 72],
      ['web/icon-96x96.png', 96, 96],
      ['web/icon-128x128.png', 128, 128],
      ['web/icon-144x144.png', 144, 144],
      ['web/icon-152x152.png', 152, 152],
      ['web/icon-192x192.png', 192, 192],
      ['web/icon-384x384.png', 384, 384],
      ['web/icon-512x512.png', 512, 512],
      ['web/icon-maskable-192x192.png', 192, 192],
      ['web/icon-maskable-512x512.png', 512, 512],
      ['web/shortcut-chat.png', 96, 96],
      ['web/shortcut-tasks.png', 96, 96],
      ['web/dark/favicon-16x16.png', 16, 16],
      ['web/dark/favicon-32x32.png', 32, 32],
      ['web/dark/apple-touch-icon.png', 180, 180],
      ['web/dark/icon-512x512.png', 512, 512],
      ['web/dark/icon-maskable-512x512.png', 512, 512],
      ['desktop/icon-1024.png', 1024, 1024],
      ['desktop/icon-1024-dark.png', 1024, 1024],
      ['mobile/icon.png', 1024, 1024],
      ['mobile/adaptive-icon.png', 1024, 1024],
      ['mobile/adaptive-background.png', 1024, 1024],
      ['mobile/splash-icon.png', 1024, 1024],
      ['mobile/notification-icon.png', 96, 96],
    ]

    for (const [rel, width, height] of cases) {
      it(`${rel} is ${width}x${height}`, async () => {
        const meta = await sharp(join(OUT_DIR, rel)).metadata()
        expect(meta.width).toBe(width)
        expect(meta.height).toBe(height)
      })
    }
  })

  it('web/favicon.svg and docs/favicon.svg match the ficus-favicon-16 source', () => {
    const webFavicon = readFileSync(join(OUT_DIR, 'web', 'favicon.svg'), 'utf8')
    const docsFavicon = readFileSync(join(OUT_DIR, 'docs', 'favicon.svg'), 'utf8')
    expect(docsFavicon).toBe(webFavicon)
    expect(webFavicon).toContain('viewBox="0 0 64 64"')
  })

  it('mobile/icon.png (iOS) has no alpha channel', async () => {
    const meta = await sharp(join(OUT_DIR, 'mobile', 'icon.png')).metadata()
    expect(meta.hasAlpha).toBe(false)
    expect(meta.channels).toBe(3)
  })

  it('web/apple-touch-icon.png has no alpha channel (no transparency)', async () => {
    const meta = await sharp(join(OUT_DIR, 'web', 'apple-touch-icon.png')).metadata()
    expect(meta.hasAlpha).toBe(false)
  })

  it('desktop/icon-1024.png keeps transparency outside the rounded tile', async () => {
    const meta = await sharp(join(OUT_DIR, 'desktop', 'icon-1024.png')).metadata()
    expect(meta.hasAlpha).toBe(true)
    const { data, info } = await sharp(join(OUT_DIR, 'desktop', 'icon-1024.png'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    // The corner pixel must be fully transparent: it's outside the 824x824
    // rounded tile centered in the 1024 canvas.
    const idx = (0 * info.width + 0) * info.channels
    expect(data[idx + 3]).toBe(0)
  })

  it('mobile/notification-icon.png contains only pure white or fully-transparent pixels', async () => {
    const { data, info } = await sharp(join(OUT_DIR, 'mobile', 'notification-icon.png'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(info.channels).toBe(4)

    let sawOpaquePixel = false
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
      if (a === 0) continue
      sawOpaquePixel = true
      expect([r, g, b]).toEqual([255, 255, 255])
    }
    expect(sawOpaquePixel).toBe(true)
  })

  describe('maskable icons keep the mark inside the central 60% safe zone', () => {
    for (const rel of ['web/icon-maskable-192x192.png', 'web/icon-maskable-512x512.png']) {
      it(rel, async () => {
        const { data, info } = await sharp(join(OUT_DIR, rel)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        const [lr, lg, lb] = hex(COLORS.linen)
        const threshold = 6

        let minX = info.width
        let minY = info.height
        let maxX = -1
        let maxY = -1
        for (let y = 0; y < info.height; y++) {
          for (let x = 0; x < info.width; x++) {
            const idx = (y * info.width + x) * info.channels
            const r = data[idx]
            const g = data[idx + 1]
            const b = data[idx + 2]
            const isBackground =
              Math.abs(r - lr) <= threshold && Math.abs(g - lg) <= threshold && Math.abs(b - lb) <= threshold
            if (!isBackground) {
              if (x < minX) minX = x
              if (x > maxX) maxX = x
              if (y < minY) minY = y
              if (y > maxY) maxY = y
            }
          }
        }

        expect(maxX).toBeGreaterThan(minX)
        const safeMin = info.width * 0.2
        const safeMax = info.width * 0.8
        // Allow a small antialiasing margin (a couple of px) outside the
        // theoretical safe-zone edge.
        const margin = 3
        expect(minX).toBeGreaterThanOrEqual(safeMin - margin)
        expect(maxX).toBeLessThanOrEqual(safeMax + margin)
        expect(minY).toBeGreaterThanOrEqual(safeMin - margin)
        expect(maxY).toBeLessThanOrEqual(safeMax + margin)
      })
    }
  })
})
