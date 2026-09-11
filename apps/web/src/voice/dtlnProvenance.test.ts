import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { embeddedWasm } from '../../scripts/dtln/embedded-wasm'

// The shipped denoiser is a compiled third-party binary. provenance.json must
// describe THIS file — its hash, the hash and size of the wasm embedded in it,
// and the upstream commit the Dockerfile builds — or the redistribution notice
// next to it is describing something else.
const dtlnDir = fileURLToPath(new URL('../../public/voice/dtln/', import.meta.url))
const dockerfile = readFileSync(fileURLToPath(new URL('../../scripts/dtln/Dockerfile', import.meta.url)), 'utf8')
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

test('provenance.json matches the shipped dtln.js and the pinned build recipe', () => {
  const glue = readFileSync(`${dtlnDir}dtln.js`, 'utf8')
  const provenance = JSON.parse(readFileSync(`${dtlnDir}provenance.json`, 'utf8')) as {
    schemaVersion: number
    assetSha256: string
    embeddedWasmSha256: string
    embeddedWasmBytes: number
    upstream: { repository: string; commit: string }
    build: { recipe: string; emscripten: string; rustc: string }
    exactBinarySourceCommit: string
    reproducibleBuildVerified: boolean
  }
  const wasm = embeddedWasm(glue)

  expect(provenance.schemaVersion).toBe(2)
  expect(provenance.assetSha256).toBe(sha256(glue))
  expect(provenance.embeddedWasmSha256).toBe(sha256(wasm))
  expect(provenance.embeddedWasmBytes).toBe(wasm.byteLength)

  const pinned = dockerfile.match(/^ARG DTLN_RS_COMMIT=([0-9a-f]{40})$/m)![1]
  expect(provenance.upstream.repository).toBe('https://github.com/DataDog/dtln-rs')
  expect(provenance.upstream.commit).toBe(pinned)
  expect(provenance.exactBinarySourceCommit).toBe(pinned)
  expect(provenance.reproducibleBuildVerified).toBe(true)

  expect(provenance.build.recipe).toBe('apps/web/scripts/dtln/Dockerfile')
  expect(dockerfile).toContain(`FROM emscripten/emsdk:${provenance.build.emscripten} AS build`)
  expect(dockerfile).toContain(`ARG RUST_TOOLCHAIN=${provenance.build.rustc}`)
})
