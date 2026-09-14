/** Match Pi's bounded sniff size; never download a whole text file to classify it. */
export const IMAGE_SNIFF_BYTES = 4100

/**
 * Classify bytes, not extensions or paths on the Core host. Custom Pi read
 * operations must supply this hook themselves; without it Pi decodes every
 * file as UTF-8. Pi's image processor validates/normalizes the complete image
 * and applies its inline size limits after this inexpensive classification.
 */
export function detectReadImageMimeType(prefix: Buffer): string | undefined {
  if (prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return 'image/jpeg'
  const header = prefix.subarray(0, 6).toString('ascii')
  if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  if (prefix.subarray(0, 4).equals(Buffer.from('RIFF')) && prefix.subarray(8, 12).equals(Buffer.from('WEBP'))) {
    return 'image/webp'
  }
  // BM alone is common text; require a plausible DIB header before treating it
  // as an image. Both the legacy OS/2 and Windows headers are supported by Pi.
  if (prefix.length >= 26 && prefix.subarray(0, 2).equals(Buffer.from('BM'))) {
    const dibSize = prefix.readUInt32LE(14)
    const planesOffset = dibSize === 12 ? 22 : 26
    if (
      (dibSize === 12 || (dibSize >= 40 && dibSize <= 124)) &&
      prefix.length >= planesOffset + 4 &&
      prefix.readUInt16LE(planesOffset) === 1 &&
      [1, 4, 8, 16, 24, 32].includes(prefix.readUInt16LE(planesOffset + 2))
    ) {
      return 'image/bmp'
    }
  }

  // Do not expose unknown/corrupt binary data as replacement-character text.
  // A full sniff can end in the middle of a valid UTF-8 sequence.
  try {
    if (prefix.includes(0)) throw new Error('binary')
    new TextDecoder('utf-8', { fatal: true }).decode(prefix, { stream: prefix.length === IMAGE_SNIFF_BYTES })
  } catch {
    throw new Error('Unsupported binary file: read supports text and PNG, JPEG, GIF, WebP, or BMP images')
  }
  return undefined
}
