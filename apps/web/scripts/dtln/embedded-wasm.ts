import { runInNewContext } from 'node:vm'

/**
 * The .wasm Emscripten's SINGLE_FILE mode inlined into the glue. Emscripten
 * 4.x passes it to `binaryDecode('<latin1 string>')` — one JS string literal
 * whose char codes are the bytes; older releases used a base64 data URI. The
 * literal is decoded exactly as the glue does: evaluate it as a JS string,
 * then take each char code as a byte.
 */
export function embeddedWasm(glue: string): Uint8Array {
  const dataUri = glue.match(/data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/)
  const bytes = dataUri ? Buffer.from(dataUri[1]!, 'base64') : Buffer.from(binaryStringLiteral(glue), 'latin1')
  if (bytes.subarray(0, 4).toString('latin1') !== '\0asm') throw new Error('embedded payload is not a wasm binary')
  return bytes
}

function binaryStringLiteral(glue: string): string {
  // The call site (`binaryDecode('…')`), not the helper's definition.
  const call = glue.match(/binaryDecode\(\s*'/)
  if (!call || call.index === undefined) {
    throw new Error('dtln.js embeds neither a base64 data URI nor a binaryDecode string literal')
  }
  const open = call.index + call[0].length - 1
  let close = open + 1
  for (; close < glue.length; close++) {
    if (glue[close] === '\\') close++
    else if (glue[close] === "'") break
  }
  if (close >= glue.length) throw new Error('unterminated binaryDecode string literal')
  // A string literal evaluates to itself; the empty sandbox has nothing else to reach.
  const decoded: unknown = runInNewContext(glue.slice(open, close + 1), Object.create(null))
  if (typeof decoded !== 'string') throw new Error('binaryDecode argument did not evaluate to a string')
  return decoded
}
