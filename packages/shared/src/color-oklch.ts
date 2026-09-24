/**
 * Minimal sRGB <-> OKLCH conversion (Björn Ottosson's OKLab, public reference
 * formulas). Pure, dependency-free, no DOM/node builtins — this file is
 * imported by the browser bundle. Used by theme-derivation.ts to derive a
 * full token set from a handful of seed colors while preserving each base
 * token's lightness/contrast structure.
 */

export interface Oklch {
  /** Lightness, 0 (black) – 1 (white). */
  l: number
  /** Chroma, 0 (gray) upward (unbounded, but sRGB-representable colors stay roughly under ~0.4). */
  c: number
  /** Hue in degrees, [0, 360). Meaningless when c is ~0 (gray). */
  h: number
}

export type Rgb = readonly [number, number, number]

function srgbToLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
function linearToSrgb(channel: number): number {
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
  return c
}

function linearSrgbToOklab([r, g, b]: readonly [number, number, number]): [number, number, number] {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)
  return [
    0.210454255 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ]
}
function oklabToLinearSrgb([L, a, b]: readonly [number, number, number]): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

const clamp255 = (n: number) => Math.min(255, Math.max(0, Math.round(n)))

/** RGB channels are 0–255 integers (matches `customColorChannels` output). */
export function srgbToOklch(rgb: Rgb): Oklch {
  const linear = rgb.map(srgbToLinear) as [number, number, number]
  const [L, a, b] = linearSrgbToOklab(linear)
  const c = Math.hypot(a, b)
  const h = c < 1e-6 ? 0 : (Math.atan2(b, a) * 180) / Math.PI
  return { l: L, c, h: h < 0 ? h + 360 : h }
}

export function oklchToSrgb({ l, c, h }: Oklch): Rgb {
  const radians = (h * Math.PI) / 180
  const a = c * Math.cos(radians)
  const b = c * Math.sin(radians)
  const linear = oklabToLinearSrgb([l, a, b])
  const [r, g, bl] = linear.map((channel) => linearToSrgb(channel) * 255) as [number, number, number]
  return [clamp255(r), clamp255(g), clamp255(bl)]
}
