/**
 * Ficus brand icon generator.
 *
 * Renders every icon Core web, Platform web, Core docs, Desktop and Mobile
 * need from the three source SVGs in `brand/` (`ficus-mark.svg`,
 * `ficus-mark-dark.svg`, `ficus-favicon-16.svg`). Outputs are written to
 * `brand/generated/` and are NOT wired into any app by this script — that
 * swap happens in separate, later PRs.
 *
 * Usage: bun run brand:generate   (from repo root)
 *     or: bun run scripts/brand/generate.ts
 *
 * Determinism: every raster target is built by rasterizing a single
 * composite SVG (background shape + the source mark's own path data,
 * positioned with a computed affine transform) in one pass with sharp, then
 * encoded with fixed, explicit PNG options. No timestamps, random ids or
 * host-dependent metadata are written. Running this script twice produces
 * byte-identical files (see scripts/brand/generate.test.ts).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

export const BRAND_DIR = join(import.meta.dir, '..', '..', 'brand')
export const OUT_DIR = join(BRAND_DIR, 'generated')

// ---------------------------------------------------------------------------
// Brand constants (see brand/README.md for the human-readable version)
// ---------------------------------------------------------------------------

export const COLORS = {
  linen: '#f1e9db',
  soil: '#1c1a17',
  leaf: '#3f6b4f',
  moss: '#8a9a5b',
  terracotta: '#b0582f',
  darkSage: '#9fb57f',
} as const

/** Dark-mode recolor mapping, matching brand/ficus-mark-dark.svg's palette swap. */
const DARK_RECOLOR: Record<string, string> = {
  '#3f6b4f': '#5e7f4e', // leaf -> dark leaf
  '#8a9a5b': '#87945a', // moss / side leaves -> dark moss
  '#b0582f': '#c46a3c', // terracotta -> dark terracotta
}

const MARK_VIEWBOX_SIZE = 64

// Fraction of the (effective) canvas that the mark's longest content
// dimension should occupy. Values marked "brief" are given directly by the
// task brief; values marked "chosen" are this generator's own consistent
// default for cases the brief left unspecified (see brand/README.md and the
// task report for the reasoning).
const FILL = {
  webIcon: 0.7, // brief: "mark centered ~70% of the canvas"
  webMaskable: 0.6, // brief: "within the central 60% safe zone"
  appleTouch: 1 - 2 * 0.12, // brief: "~12% padding" => 0.76
  desktopTile: 0.7, // chosen: same ratio as webIcon, applied to the tile
  mobileIcon: 0.7, // chosen: same ratio as webIcon (iOS full-bleed square)
  mobileAdaptive: 0.66, // brief: "central 66% safe zone"
  mobileSplash: 0.6, // brief: "mark ~60%"
  mobileNotification: 0.7, // chosen: same ratio as webIcon
} as const

const DESKTOP_CANVAS = 1024
const DESKTOP_TILE = 824
const DESKTOP_CORNER_RADIUS = 185

const PNG_OPTIONS = {
  compressionLevel: 9,
  effort: 10,
  palette: true,
} as const

// ---------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------

/** Strips the outer <svg ...>...</svg> wrapper, returning just the inner markup. */
function innerMarkup(svg: string): string {
  const match = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/)
  if (!match) throw new Error('source SVG did not match the expected <svg>...</svg> shape')
  return match[1].trim()
}

/** Applies the dark-mode color mapping to a light source's inner markup. */
function toDark(markup: string): string {
  let out = markup
  for (const [light, dark] of Object.entries(DARK_RECOLOR)) {
    out = out.split(light).join(dark)
  }
  return out
}

/** Forces every fill color in the markup to pure white (for monochrome silhouettes). */
function toWhiteSilhouette(markup: string): string {
  return markup.replace(/fill="#[0-9a-fA-F]{3,6}"/g, 'fill="#ffffff"')
}

interface BBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Measures the visible content's bounding box of a mark SVG, in the mark's
 * own 0..64 user-unit space, by rasterizing at a calibration resolution and
 * trimming the transparent margin. This is computed from the source file
 * itself (not hardcoded) so the generator stays correct if the mark artwork
 * ever changes.
 */
async function measureContentBBox(svg: string): Promise<BBox> {
  const calibrationSize = 2048
  const rendered = await sharp(Buffer.from(svg), { density: (calibrationSize / MARK_VIEWBOX_SIZE) * 96 })
    .resize(calibrationSize, calibrationSize)
    .png()
    .toBuffer()
  const { info } = await sharp(rendered).trim().toBuffer({ resolveWithObject: true })
  const pxPerUnit = calibrationSize / MARK_VIEWBOX_SIZE
  const trimOffsetLeft = info.trimOffsetLeft ?? 0
  const trimOffsetTop = info.trimOffsetTop ?? 0
  return {
    x: -trimOffsetLeft / pxPerUnit,
    y: -trimOffsetTop / pxPerUnit,
    width: info.width / pxPerUnit,
    height: info.height / pxPerUnit,
  }
}

/**
 * Builds a self-contained composite SVG: an optional background (full-canvas
 * or a centered rounded tile) plus the mark's inner markup, scaled and
 * centered so its content's longest dimension is `fill` of the effective
 * canvas (the tile, when one is given; otherwise the full canvas).
 */
function buildCompositeSVG(opts: {
  size: number
  markup: string
  bbox: BBox
  fill: number
  background?: string
  tile?: { size: number; cornerRadius: number }
}): string {
  const { size, markup, bbox, fill, background, tile } = opts
  const effectiveSize = tile?.size ?? size
  const scale = (fill * effectiveSize) / Math.max(bbox.width, bbox.height)
  const contentCenterX = bbox.x + bbox.width / 2
  const contentCenterY = bbox.y + bbox.height / 2
  const tx = size / 2 - contentCenterX * scale
  const ty = size / 2 - contentCenterY * scale

  let backgroundShape = ''
  if (background && tile) {
    const tileX = (size - tile.size) / 2
    const tileY = (size - tile.size) / 2
    backgroundShape = `<rect x="${tileX}" y="${tileY}" width="${tile.size}" height="${tile.size}" rx="${tile.cornerRadius}" ry="${tile.cornerRadius}" fill="${background}"/>`
  } else if (background) {
    backgroundShape = `<rect x="0" y="0" width="${size}" height="${size}" fill="${background}"/>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${backgroundShape}<g transform="translate(${tx} ${ty}) scale(${scale})">${markup}</g></svg>`
}

/** Renders a composite SVG string to a PNG file with fixed, deterministic options. */
async function renderPng(svg: string, outPath: string, opts: { removeAlpha?: boolean } = {}): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true })
  let pipeline = sharp(Buffer.from(svg))
  if (opts.removeAlpha) pipeline = pipeline.flatten().removeAlpha()
  const buffer = await pipeline.png(PNG_OPTIONS).toBuffer()
  await writeFile(outPath, buffer)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function generate(outDir: string = OUT_DIR): Promise<void> {
  await Promise.all(
    ['web/dark', 'desktop', 'mobile', 'docs'].map((sub) => mkdir(join(outDir, sub), { recursive: true }))
  )

  const [markLightSvg, markDarkSvg, favicon16Svg] = await Promise.all([
    readFile(join(BRAND_DIR, 'ficus-mark.svg'), 'utf8'),
    readFile(join(BRAND_DIR, 'ficus-mark-dark.svg'), 'utf8'),
    readFile(join(BRAND_DIR, 'ficus-favicon-16.svg'), 'utf8'),
  ])

  const markLight = innerMarkup(markLightSvg)
  const markDark = innerMarkup(markDarkSvg)
  const favicon16Light = innerMarkup(favicon16Svg)
  const favicon16Dark = toDark(favicon16Light)
  const markLightWhite = toWhiteSilhouette(markLight)

  const [markBBox, favicon16BBox] = await Promise.all([
    measureContentBBox(markLightSvg),
    measureContentBBox(favicon16Svg),
  ])
  // ficus-mark.svg and ficus-mark-dark.svg share identical geometry (only
  // colors differ), so the same bounding box applies to both.

  const webStandardSizes = [72, 96, 128, 144, 152, 192, 384, 512]
  const webMaskableSizes = [192, 512]

  // --- web/ (Core web + Platform web share this set) -----------------------

  await writeFile(join(outDir, 'web', 'favicon.svg'), `${favicon16Svg.trim()}\n`)

  await renderPng(
    buildCompositeSVG({ size: 16, markup: favicon16Light, bbox: favicon16BBox, fill: 1, background: COLORS.linen }),
    join(outDir, 'web', 'favicon-16x16.png'),
    { removeAlpha: true }
  )
  await renderPng(
    buildCompositeSVG({ size: 32, markup: markLight, bbox: markBBox, fill: FILL.webIcon, background: COLORS.linen }),
    join(outDir, 'web', 'favicon-32x32.png'),
    { removeAlpha: true }
  )
  await renderPng(
    buildCompositeSVG({
      size: 180,
      markup: markLight,
      bbox: markBBox,
      fill: FILL.appleTouch,
      background: COLORS.linen,
    }),
    join(outDir, 'web', 'apple-touch-icon.png'),
    { removeAlpha: true }
  )
  for (const size of webStandardSizes) {
    await renderPng(
      buildCompositeSVG({ size, markup: markLight, bbox: markBBox, fill: FILL.webIcon, background: COLORS.linen }),
      join(outDir, 'web', `icon-${size}x${size}.png`),
      { removeAlpha: true }
    )
  }
  for (const size of webMaskableSizes) {
    await renderPng(
      buildCompositeSVG({ size, markup: markLight, bbox: markBBox, fill: FILL.webMaskable, background: COLORS.linen }),
      join(outDir, 'web', `icon-maskable-${size}x${size}.png`),
      { removeAlpha: true }
    )
  }

  // Existing apps/web/public/icons/ also ships two manifest "shortcuts" icons
  // (shortcut-chat.png, shortcut-tasks.png, 96x96) that the brief's list
  // doesn't cover. Per the task's guidance, generate mark-only equivalents
  // at the same name/size rather than inventing new shortcut glyphs, so a
  // later swap is a straight copy.
  for (const name of ['shortcut-chat', 'shortcut-tasks']) {
    await renderPng(
      buildCompositeSVG({ size: 96, markup: markLight, bbox: markBBox, fill: FILL.webIcon, background: COLORS.linen }),
      join(outDir, 'web', `${name}.png`),
      { removeAlpha: true }
    )
  }

  // --- web/dark/ (same sizes, dark mark on soil, for future use) ----------

  await renderPng(
    buildCompositeSVG({ size: 16, markup: favicon16Dark, bbox: favicon16BBox, fill: 1, background: COLORS.soil }),
    join(outDir, 'web', 'dark', 'favicon-16x16.png'),
    { removeAlpha: true }
  )
  await renderPng(
    buildCompositeSVG({ size: 32, markup: markDark, bbox: markBBox, fill: FILL.webIcon, background: COLORS.soil }),
    join(outDir, 'web', 'dark', 'favicon-32x32.png'),
    { removeAlpha: true }
  )
  await renderPng(
    buildCompositeSVG({ size: 180, markup: markDark, bbox: markBBox, fill: FILL.appleTouch, background: COLORS.soil }),
    join(outDir, 'web', 'dark', 'apple-touch-icon.png'),
    { removeAlpha: true }
  )
  for (const size of webStandardSizes) {
    await renderPng(
      buildCompositeSVG({ size, markup: markDark, bbox: markBBox, fill: FILL.webIcon, background: COLORS.soil }),
      join(outDir, 'web', 'dark', `icon-${size}x${size}.png`),
      { removeAlpha: true }
    )
  }
  for (const size of webMaskableSizes) {
    await renderPng(
      buildCompositeSVG({ size, markup: markDark, bbox: markBBox, fill: FILL.webMaskable, background: COLORS.soil }),
      join(outDir, 'web', 'dark', `icon-maskable-${size}x${size}.png`),
      { removeAlpha: true }
    )
  }

  // --- desktop/ -------------------------------------------------------------

  await renderPng(
    buildCompositeSVG({
      size: DESKTOP_CANVAS,
      markup: markLight,
      bbox: markBBox,
      fill: FILL.desktopTile,
      background: COLORS.linen,
      tile: { size: DESKTOP_TILE, cornerRadius: DESKTOP_CORNER_RADIUS },
    }),
    join(outDir, 'desktop', 'icon-1024.png')
  )
  await renderPng(
    buildCompositeSVG({
      size: DESKTOP_CANVAS,
      markup: markDark,
      bbox: markBBox,
      fill: FILL.desktopTile,
      background: COLORS.soil,
      tile: { size: DESKTOP_TILE, cornerRadius: DESKTOP_CORNER_RADIUS },
    }),
    join(outDir, 'desktop', 'icon-1024-dark.png')
  )

  // --- mobile/ ---------------------------------------------------------------

  await renderPng(
    buildCompositeSVG({
      size: 1024,
      markup: markLight,
      bbox: markBBox,
      fill: FILL.mobileIcon,
      background: COLORS.linen,
    }),
    join(outDir, 'mobile', 'icon.png'),
    { removeAlpha: true }
  )
  await renderPng(
    buildCompositeSVG({ size: 1024, markup: markLight, bbox: markBBox, fill: FILL.mobileAdaptive }),
    join(outDir, 'mobile', 'adaptive-icon.png')
  )
  await renderPng(
    buildCompositeSVG({
      size: 1024,
      markup: '',
      bbox: { x: 0, y: 0, width: 1, height: 1 },
      fill: 1,
      background: COLORS.linen,
    }),
    join(outDir, 'mobile', 'adaptive-background.png'),
    { removeAlpha: true }
  )
  await renderPng(
    buildCompositeSVG({ size: 1024, markup: markLight, bbox: markBBox, fill: FILL.mobileSplash }),
    join(outDir, 'mobile', 'splash-icon.png')
  )
  await renderPng(
    buildCompositeSVG({ size: 96, markup: markLightWhite, bbox: markBBox, fill: FILL.mobileNotification }),
    join(outDir, 'mobile', 'notification-icon.png')
  )

  // --- docs/ -------------------------------------------------------------

  await writeFile(join(outDir, 'docs', 'favicon.svg'), `${favicon16Svg.trim()}\n`)

  console.log('Ficus brand icons generated in', outDir)
}

if (import.meta.main) {
  generate().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
