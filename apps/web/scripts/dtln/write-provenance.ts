// Rewrites apps/web/public/voice/dtln/provenance.json for the dtln.js that is
// currently in that directory: hashes of the glue and of the WebAssembly binary
// embedded in it, plus the exact sources and toolchain the build recorded.
// Invoked by build.sh; usable standalone to re-hash an existing asset.
//
//   bun write-provenance.ts <public/voice/dtln dir> [toolchain.txt] [--verified]
//
// `--verified` records that a second build from a cold cache reproduced the
// asset byte for byte (build.sh --check with NO_CACHE=1); without it the flag
// is written false, whatever it was before.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { embeddedWasm } from './embedded-wasm'

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

interface Toolchain {
  commit: string
  emscripten: string
  rustc: string
  cargo: string
}

function parseToolchain(text: string): Toolchain {
  const line = (prefix: string) => {
    const found = text.split('\n').find((l) => l.startsWith(prefix))
    if (!found) throw new Error(`toolchain.txt lacks a "${prefix}" line`)
    return found
  }
  return {
    commit: line('dtln-rs ').split(' ')[1]!,
    emscripten: line('emcc ').match(/\b(\d+\.\d+\.\d+)\b/)![1]!,
    rustc: line('rustc ').split(' ')[1]!,
    cargo: line('cargo ').split(' ')[1]!,
  }
}

function main(argv: string[]) {
  const verified = argv.includes('--verified')
  const [publicDir, toolchainFile] = argv.filter((a) => a !== '--verified')
  if (!publicDir) {
    console.error('usage: bun write-provenance.ts <public/voice/dtln dir> [toolchain.txt] [--verified]')
    process.exit(2)
  }

  const glue = readFileSync(join(publicDir, 'dtln.js'), 'utf8')
  const wasm = embeddedWasm(glue)
  const provenancePath = join(publicDir, 'provenance.json')
  const previous = JSON.parse(readFileSync(provenancePath, 'utf8')) as Record<string, unknown>
  const toolchain = toolchainFile ? parseToolchain(readFileSync(toolchainFile, 'utf8')) : null
  const previousUpstream = previous.upstream as { commit?: string } | undefined

  const provenance = {
    schemaVersion: 2,
    asset: 'dtln.js',
    assetSha256: sha256(glue),
    embeddedWasmSha256: sha256(wasm),
    embeddedWasmBytes: wasm.byteLength,
    upstream: {
      repository: 'https://github.com/DataDog/dtln-rs',
      commit: toolchain?.commit ?? previousUpstream?.commit ?? null,
    },
    build: toolchain
      ? {
          recipe: 'apps/web/scripts/dtln/Dockerfile',
          emscripten: toolchain.emscripten,
          rustc: toolchain.rustc,
          cargo: toolchain.cargo,
          overlays: ['build.rs', 'config.toml', 'dtln_post.js'],
          formatted: 'prettier (repository config)',
        }
      : (previous.build ?? null),
    exactBinarySourceCommit: toolchain?.commit ?? previous.exactBinarySourceCommit ?? null,
    reproducibleBuildVerified: verified,
  }

  writeFileSync(provenancePath, JSON.stringify(provenance, null, 2) + '\n')
  console.log(
    `provenance.json: asset ${provenance.assetSha256.slice(0, 12)} wasm ${provenance.embeddedWasmSha256.slice(0, 12)} (${wasm.byteLength} bytes)${verified ? ', reproducible build verified' : ''}`
  )
}

if (import.meta.main) main(process.argv.slice(2))
