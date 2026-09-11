import { describe, expect, test } from 'bun:test'
import {
  isDomOwnershipInfrastructure,
  scanDomGlobalOwnership,
  validateDomOwnershipDiscovery,
} from './domGlobalOwnershipGuard'

const codes = (source: string) => scanDomGlobalOwnership(source, 'fixture.test.ts').map((d) => d.code)
describe('DOM global ownership guard', () => {
  test('detects aliases, computed writes, descriptors, and happy-dom aliases', () => {
    expect(
      codes(`
      import { test as check } from 'bun:test'
      import { Window as W } from 'happy-dom'
      const g=globalThis, O=Object; const {defineProperty: dp, assign}=O
      check('x',()=>{ new W(); g['navigator']={}; dp(g,'location',{value:{}}); assign(g,{Event: class {}}) })
    `)
    ).toEqual(['DOM001', 'DOM002', 'DOM002', 'DOM002', 'DOM003'])
  })
  test('ignores comments, strings, dead helpers, and lexical shadows', () => {
    expect(
      codes(`
      import { test } from 'bun:test'; import { Window } from 'happy-dom'
      function dead(){ new Window(); globalThis.document={} }
      test('x',(globalThis)=>{ const Object={assign(){}}; Object.assign(globalThis,{window:{}}); /* globalThis.location={} */ })
    `)
    ).toEqual([])
  })
  test('follows called helpers and fails closed for dynamic mutation', () => {
    expect(
      codes(
        `import {test} from 'bun:test'; function mutate(x:any){Object.defineProperty(x,key(),{})} test('x',()=>mutate(globalThis))`
      )
    ).toEqual(['DOM002', 'DOM003'])
    expect(
      codes(`import {test} from 'bun:test'; const mutate=()=>{globalThis.window={}}; test('x',()=>mutate())`)
    ).toEqual(['DOM002', 'DOM003'])
  })
  test('respects lexical shadows of Happy DOM namespace imports', () => {
    expect(
      codes(
        `import * as HD from 'happy-dom'; import {test} from 'bun:test'; test('x',()=>{ const HD={Window:class{}}; new HD.Window() })`
      )
    ).toEqual([])
  })
  test('resolves namespaces and covers delete, defineProperties, Event, and EventTarget', () => {
    expect(
      codes(`
      import * as bt from 'bun:test'; import * as HD from 'happy-dom'
      const G=globalThis, Obj=Object
      bt.test('x',()=>{ new HD.Window(); delete G['location']; Obj.defineProperties(G,{Event:{value:1},EventTarget:{value:2}}) })
    `)
    ).toEqual(['DOM001', 'DOM002', 'DOM002', 'DOM003'])
  })
  test('rejects unawaited acquisition, void cleanup, and mismatched leases', () => {
    expect(
      codes(`
      import {test} from 'bun:test'; import {acquireDomHarness as acquire} from './domHarness'
      test('x',async()=>{ const lease = await acquire(); const other = lease; try { globalThis.window={} } finally { void other.cleanup() } })
    `)
    ).toEqual(['DOM002', 'DOM003'])
    expect(
      codes(`
      import {test} from 'bun:test'; import {acquireDomHarness as acquire} from './domHarness'
      test('x',async()=>{ const lease = acquire(); try { globalThis.window={} } finally { await lease.cleanup() } })
    `)
    ).toEqual(['DOM002', 'DOM003'])
  })
  test('rejects conditional or dead acquisition and cleanup paths', () => {
    expect(
      codes(`
      import {test} from 'bun:test'; import {acquireDomHarness as acquire} from './domHarness'
      test('x',async()=>{ let lease; if(false) lease=await acquire(); try { globalThis.window={} } finally { await lease.cleanup() } })
    `)
    ).toEqual(['DOM002', 'DOM003'])
    expect(
      codes(`
      import {test} from 'bun:test'; import {acquireDomHarness as acquire} from './domHarness'
      test('x',async()=>{ const lease=await acquire(); try { globalThis.window={} } finally { if(false) await lease.cleanup() } })
    `)
    ).toEqual(['DOM002', 'DOM003'])
  })
  test('discovers genuine registrations nested in describe', () => {
    expect(
      codes(
        `import {describe,test} from 'bun:test'; describe('scope',()=>{ test('owner',()=>{globalThis.window={}}) })`
      )
    ).toEqual(['DOM002', 'DOM003'])
  })
  test('keeps genuine Bun aliases inside describe scopes', () => {
    expect(
      codes(
        `import * as bt from 'bun:test'; bt.describe('scope',()=>{ const registered=bt.test; const {test:check}=bt; registered('a',()=>globalThis.window={}); check('b',()=>globalThis.document={}) })`
      )
    ).toEqual(['DOM002', 'DOM003', 'DOM002', 'DOM003'])
  })
  test('discovers Bun registrations through destructured helper parameters', () => {
    expect(
      codes(
        `import * as bt from 'bun:test'; function register({test}:typeof bt){test('owner',()=>globalThis.navigator={})} register(bt)`
      )
    ).toEqual(['DOM002', 'DOM003'])
  })
  test('follows called nested helpers but leaves uncalled nested helpers dead', () => {
    expect(
      codes(
        `import * as bt from 'bun:test'; function register(ns:typeof bt){ function nested({test}:typeof bt){test('owner',()=>globalThis.window={})} nested(ns); function dead({test}:typeof bt){test('dead',()=>globalThis.document={})} } register(bt)`
      )
    ).toEqual(['DOM002', 'DOM003'])
  })
  test('requires matching hook lifecycle cardinality', () => {
    expect(
      codes(
        `import {beforeEach,afterAll,test} from 'bun:test'; import {acquireDomHarness} from './domHarness'; let lease:any; beforeEach(async()=>{lease=await acquireDomHarness()}); afterAll(async()=>{await lease.cleanup()}); test('x',()=>{globalThis.window={}})`
      )
    ).toEqual(['DOM002', 'DOM003'])
    expect(
      codes(
        `import {beforeAll,afterEach,test} from 'bun:test'; import {acquireDomHarness} from './domHarness'; let lease:any; beforeAll(async()=>{lease=await acquireDomHarness()}); afterEach(async()=>{await lease.cleanup()}); test('x',()=>{globalThis.document={}})`
      )
    ).toEqual(['DOM002', 'DOM003'])
  })
  test('visits executable variable initializers and control flow', () => {
    expect(codes(`const installed=(globalThis.navigator={}); if (ready) globalThis.location={}`)).toEqual([
      'DOM002',
      'DOM003',
      'DOM002',
      'DOM003',
    ])
  })
  test('tracks reassigned mutation methods and invalidates reassigned Bun hooks', () => {
    expect(
      codes(
        `import {test as registered} from 'bun:test'; let dp=()=>{}; dp=Object.defineProperty; registered=(()=>{}) as typeof registered; dp(globalThis,'Event',{}); registered('fake',()=>globalThis.window={})`
      )
    ).toEqual(['DOM002', 'DOM003'])
  })
  test('binds destructured Happy DOM namespaces in helper parameters', () => {
    expect(
      codes(
        `import {test} from 'bun:test'; import * as HD from 'happy-dom'; function make({Window}:typeof HD){new Window()} test('x',()=>make(HD))`
      )
    ).toEqual(['DOM001'])
  })
  test('keeps nested lexical shadows in their actual scope', () => {
    expect(
      codes(
        `import {test} from 'bun:test'; test('x',()=>{ { const globalThis={window:{}}; globalThis.window={} } globalThis.window={} })`
      )
    ).toEqual(['DOM002', 'DOM003'])
  })
  test('scans top-level mutations and helpers per call context', () => {
    expect(codes(`globalThis.location = {} as Location`)).toEqual(['DOM002', 'DOM003'])
    expect(
      codes(
        `import {test} from 'bun:test'; function write(x:any){x.window={}} test('safe',()=>write({})); test('bad',()=>write(globalThis))`
      )
    ).toEqual(['DOM002', 'DOM003'])
  })
  test('correlates lifecycle protection per owner region', () => {
    expect(
      codes(`
      import {test} from 'bun:test'; import {acquireDomHarness} from './domHarness'
      test('protected',async()=>{ const lease=await acquireDomHarness(); try { globalThis.window={} } finally { await lease.cleanup() } })
      test('unprotected',()=>{ globalThis.document={} })
    `)
    ).toEqual(['DOM002', 'DOM003'])
  })
  test('does not mistake textual or shadowed hooks for Bun registrations', () => {
    expect(
      codes(
        `const test=(_:unknown,fn:()=>void)=>fn; test('fake',()=>globalThis.window={}); const text="beforeEach(() => globalThis.document={})"`
      )
    ).toEqual([])
  })
  test('suppresses exact waivers and detects stale ones', () => {
    const diagnostic = { code: 'DOM002' as const, path: 'bad.test.ts', line: 1, message: 'bad' }
    expect(validateDomOwnershipDiscovery({ scannedFiles: 1, diagnostics: [diagnostic] }, ['bad.test.ts'])).toEqual([])
    expect(
      validateDomOwnershipDiscovery({ scannedFiles: 1, diagnostics: [] }, ['bad.test.ts']).map((d) => d.code)
    ).toEqual(['DOM005'])
  })
  test('reports zero discovery and stale waivers', () => {
    expect(
      validateDomOwnershipDiscovery({ scannedFiles: 0, diagnostics: [] }, ['old.test.ts']).map((d) => d.code)
    ).toEqual(['DOM004', 'DOM005'])
  })
  test('the real test tree has no ad-hoc DOM owners', async () => {
    const root = new URL('../', import.meta.url).pathname
    const files = [...new Bun.Glob('**/*.{test,spec}.{ts,tsx}').scanSync({ cwd: root, onlyFiles: true })]
      .filter((path) => !isDomOwnershipInfrastructure(path))
      .sort()
    const diagnostics = (
      await Promise.all(
        files.map(async (path) => scanDomGlobalOwnership(await Bun.file(`${root}/${path}`).text(), path))
      )
    ).flat()
    expect(files.length).toBeGreaterThan(0)
    expect(validateDomOwnershipDiscovery({ scannedFiles: files.length, diagnostics })).toEqual([])
  })
})
