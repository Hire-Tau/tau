import { createHash } from 'crypto'

export type ExactBlockSpec = {
  label: string
  lines: number
  bytes: number
  finalNewline: boolean
  overrides?: ReadonlyMap<number, string>
}

export type BufferIdentity = {
  bytes: number
  logicalLines: number
  newlineBytes: number
  finalNewline: boolean
  sha256: string
}

export type CorpusEdit = { oldText: string; newText: string }

export type GeneratedCorpus = {
  name: string
  provenance: string
  original: Buffer
  intendedResult: Buffer
  edit: CorpusEdit
  corruptions: Readonly<Record<string, Buffer>>
  eofSentinel: string
  closingSentinel: string
  exactSuffix: string
}

export function decodeUtf8Fatal(value: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value)
}

export function buildExactBlock({ label, lines, bytes, finalNewline, overrides = new Map() }: ExactBlockSpec): Buffer {
  if (!Number.isSafeInteger(lines) || lines <= 0 || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error('invalid exact-block dimensions')
  }
  for (const line of overrides.keys()) {
    if (!Number.isSafeInteger(line) || line < 1 || line > lines) throw new Error('exact-block override is out of range')
  }
  const values = Array.from(
    { length: lines },
    (_, index) => overrides.get(index + 1) ?? `// ${label}-${String(index + 1).padStart(4, '0')}`
  )
  const render = () => values.join('\n') + (finalNewline ? '\n' : '')
  const deficit = bytes - Buffer.byteLength(render())
  const fillerIndexes = values.map((_, index) => index).filter((index) => !overrides.has(index + 1))
  if (deficit < 0 || fillerIndexes.length === 0) throw new Error('invalid exact-block specification')
  const quotient = Math.floor(deficit / fillerIndexes.length)
  const remainder = deficit % fillerIndexes.length
  fillerIndexes.forEach((index, order) => {
    values[index] += 'x'.repeat(quotient + (order < remainder ? 1 : 0))
  })
  const result = Buffer.from(render())
  if (result.byteLength !== bytes) throw new Error('exact-block byte invariant failed')
  return result
}

export function identity(value: Buffer): BufferIdentity {
  const text = decodeUtf8Fatal(value)
  const newlineBytes = text.split('\n').length - 1
  const finalNewline = text.endsWith('\n')
  return {
    bytes: value.byteLength,
    logicalLines: finalNewline ? newlineBytes : newlineBytes + 1,
    newlineBytes,
    finalNewline,
    sha256: createHash('sha256').update(value).digest('hex'),
  }
}

export function replaceUnique(original: Buffer, oldText: string, newText: string): Buffer {
  const needle = Buffer.from(oldText)
  const start = original.indexOf(needle)
  if (start < 0 || original.indexOf(needle, start + 1) >= 0) throw new Error('replacement marker must be unique')
  return Buffer.concat([
    original.subarray(0, start),
    Buffer.from(newText),
    original.subarray(start + needle.byteLength),
  ])
}

export function diffLines(before: Buffer, after: Buffer): { added: number; removed: number } {
  const lines = (value: Buffer) => {
    const text = decodeUtf8Fatal(value)
    const result = text.split('\n')
    if (text.endsWith('\n')) result.pop()
    return result
  }
  const left = lines(before)
  const right = lines(after)
  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - suffix - 1] === right[right.length - suffix - 1]
  )
    suffix += 1
  return { added: right.length - prefix - suffix, removed: left.length - prefix - suffix }
}

function lines(value: Buffer): string[] {
  const text = decodeUtf8Fatal(value)
  const result = text.split('\n')
  if (text.endsWith('\n')) result.pop()
  return result
}

function corpusA(): GeneratedCorpus {
  const oldHelper = [
    '// DIFF-HELPER-OLD-1',
    '// DIFF-HELPER-OLD-2',
    '// DIFF-HELPER-OLD-3',
    '// DIFF-HELPER-OLD-4',
    '// DIFF-HELPER-OLD-5',
  ].join('\n')
  const newHelper = [
    '// DIFF-HELPER-NEW-1',
    '// DIFF-HELPER-NEW-2',
    '// DIFF-HELPER-NEW-3',
    '// DIFF-HELPER-NEW-4',
    '// DIFF-HELPER-NEW-5',
  ].join('\n')
  const original = buildExactBlock({
    label: 'diff-text',
    lines: 2900,
    bytes: 1_200_000,
    finalNewline: true,
    overrides: new Map([
      [1, 'export const diffTextGenerated = true'],
      ...oldHelper.split('\n').map((value, index) => [90 + index, value] as const),
      [1084, 'export function generatedLongFunction() {'],
      [1085, '  // DIFF-TEXT-LONG-FUNCTION-MARKER'],
      [1086, '}'],
      [1500, '// DIFF-TEXT-LATER-CANDIDATE-A'],
      [2400, '// DIFF-TEXT-LATER-CANDIDATE-B'],
      [2899, '// DIFF-TEXT-CLOSING-STRUCTURE'],
      [2900, '// DIFF-TEXT-EOF-SENTINEL'],
    ]),
  })
  const intendedResult = replaceUnique(original, oldHelper, newHelper)
  const prefix = lines(intendedResult).slice(0, 1083).join('\n')
  const transportContamination = Buffer.from(
    `${prefix}\nddiff --git a/generated/diff-text.ts b/generated/diff-text.ts\n@@ synthetic incident contamination @@\n{"oldText":"REQUEST-SERIALIZATION-MUST-NOT-LAND"}`
  )
  return {
    name: 'diff-text',
    provenance: 'Synthetic replica of native-resize diff-text/truncation evidence; no incident bytes were read.',
    original,
    intendedResult,
    edit: { oldText: oldHelper, newText: newHelper },
    corruptions: { transportContamination },
    eofSentinel: 'DIFF-TEXT-EOF-SENTINEL',
    closingSentinel: 'DIFF-TEXT-CLOSING-STRUCTURE',
    exactSuffix: '// DIFF-TEXT-CLOSING-STRUCTURE\n// DIFF-TEXT-EOF-SENTINEL\n',
  }
}

function corpusB(): GeneratedCorpus {
  const oldText = Array.from({ length: 15 }, (_, index) => `// EXECUTOR-OLD-${index + 1}`).join('\n')
  const newText = Array.from({ length: 15 }, (_, index) => `// EXECUTOR-NEW-${index + 1}`).join('\n')
  const original = buildExactBlock({
    label: 'executor',
    lines: 1695,
    bytes: 135_000,
    finalNewline: true,
    overrides: new Map([
      [1, 'export const executorGenerated = {'],
      ...oldText.split('\n').map((value, index) => [1046 + index, value] as const),
      [1694, '  eof: "EXECUTOR-EOF-SENTINEL",'],
      [1695, '} // EXECUTOR-CLOSING-SENTINEL'],
    ]),
  })
  const intendedResult = replaceUnique(original, oldText, newText)
  const transportTruncation = Buffer.from(lines(intendedResult).slice(0, 1076).join('\n'))
  return {
    name: 'executor',
    provenance: 'Synthetic replica of the recorded 1,695→1,076 executor truncation shape.',
    original,
    intendedResult,
    edit: { oldText, newText },
    corruptions: { transportTruncation },
    eofSentinel: 'EXECUTOR-EOF-SENTINEL',
    closingSentinel: 'EXECUTOR-CLOSING-SENTINEL',
    exactSuffix: '  eof: "EXECUTOR-EOF-SENTINEL",\n} // EXECUTOR-CLOSING-SENTINEL\n',
  }
}

function corpusC(): GeneratedCorpus {
  const oldText = '// provider attempt: SCHEMA-OLD-ANCHOR'
  const newText = '// provider attempt: SCHEMA-NEW-ANCHOR'
  const original = buildExactBlock({
    label: 'schema',
    lines: 988,
    bytes: 79_000,
    finalNewline: true,
    overrides: new Map([
      [1, 'export const schemaGenerated = {'],
      [561, oldText],
      [987, '  eof: "SCHEMA-EOF-SENTINEL",'],
      [988, '} // SCHEMA-CLOSING-SENTINEL'],
    ]),
  })
  const intendedResult = replaceUnique(original, oldText, newText)
  const transportTruncation = Buffer.from(`${lines(intendedResult).slice(0, 881).join('\n')}\n// derivation's o`)
  return {
    name: 'schema',
    provenance: 'Synthetic replica of the recorded 988→882 mid-comment schema truncation shape.',
    original,
    intendedResult,
    edit: { oldText, newText },
    corruptions: { transportTruncation },
    eofSentinel: 'SCHEMA-EOF-SENTINEL',
    closingSentinel: 'SCHEMA-CLOSING-SENTINEL',
    exactSuffix: '  eof: "SCHEMA-EOF-SENTINEL",\n} // SCHEMA-CLOSING-SENTINEL\n',
  }
}

function corpusD(): GeneratedCorpus {
  const oldText = '// PROVIDER-EDIT-OLD'
  const newText = '// PROVIDER-EDIT-NEW'
  const prefix = buildExactBlock({
    label: 'provider-kept',
    lines: 1283,
    bytes: 50_000,
    finalNewline: true,
    overrides: new Map([
      [1, 'export const providerGenerated = {'],
      [200, oldText],
    ]),
  })
  const boundary = buildExactBlock({ label: 'provider-boundary', lines: 1, bytes: 40, finalNewline: true })
  const suffix = buildExactBlock({
    label: 'provider-removed',
    lines: 1397,
    bytes: 58_589,
    finalNewline: true,
    overrides: new Map([
      [1396, '  eof: "PROVIDER-EOF-SENTINEL",'],
      [1397, '} // PROVIDER-CLOSING-SENTINEL'],
    ]),
  })
  const original = Buffer.concat([prefix, boundary, suffix])
  const intendedResult = replaceUnique(original, oldText, newText)
  const sizeAdded = buildExactBlock({ label: 'provider-size-added', lines: 34, bytes: 2_374, finalNewline: true })
  const diffAdded = buildExactBlock({ label: 'provider-diff-added', lines: 34, bytes: 2_414, finalNewline: true })
  return {
    name: 'provider-base',
    provenance:
      'Two synthetic corruptions preserve separately recorded size/EOF and numstat evidence; no corrupt hash is inferred.',
    original,
    intendedResult,
    edit: { oldText, newText },
    corruptions: {
      providerSizeEofCorrupt: Buffer.concat([prefix, boundary, sizeAdded]),
      providerDiffStatCorrupt: Buffer.concat([prefix, diffAdded]),
    },
    eofSentinel: 'PROVIDER-EOF-SENTINEL',
    closingSentinel: 'PROVIDER-CLOSING-SENTINEL',
    exactSuffix: '  eof: "PROVIDER-EOF-SENTINEL",\n} // PROVIDER-CLOSING-SENTINEL\n',
  }
}

function corpusE(): GeneratedCorpus {
  const oldText = '  providerHealth: false,'
  const newText = [
    '  providerHealth: true,',
    '  providerHealthAt: null,',
    '  providerFailure: null,',
    '  providerRetry: 0,',
    '  providerSource: "generated",',
  ].join('\n')
  const prefix = buildExactBlock({
    label: 'provider-schema-kept',
    lines: 1146,
    bytes: 51_166,
    finalNewline: true,
    overrides: new Map([
      [1, 'export const providerSchemaGenerated = {'],
      [300, oldText],
    ]),
  })
  const suffix = buildExactBlock({
    label: 'provider-schema-removed',
    lines: 976,
    bytes: 50_805,
    finalNewline: true,
    overrides: new Map([
      [975, '  eof: "PROVIDER-SCHEMA-EOF-SENTINEL",'],
      [976, '} // PROVIDER-SCHEMA-CLOSING-SENTINEL'],
    ]),
  })
  const added = buildExactBlock({ label: 'provider-schema-added', lines: 6, bytes: 360, finalNewline: true })
  const original = Buffer.concat([prefix, suffix])
  return {
    name: 'provider-schema',
    provenance:
      'Original line count is derived corpus arithmetic, not historical source evidence; incident corrupt hash remains unavailable.',
    original,
    intendedResult: replaceUnique(original, oldText, newText),
    edit: { oldText, newText },
    corruptions: { providerSchemaCorrupt: Buffer.concat([prefix, added]) },
    eofSentinel: 'PROVIDER-SCHEMA-EOF-SENTINEL',
    closingSentinel: 'PROVIDER-SCHEMA-CLOSING-SENTINEL',
    exactSuffix: '  eof: "PROVIDER-SCHEMA-EOF-SENTINEL",\n} // PROVIDER-SCHEMA-CLOSING-SENTINEL\n',
  }
}

function corpusF(): GeneratedCorpus {
  const oldText = '// STALE-COMMON-EDIT-OLD'
  const newText = '// STALE-COMMON-EDIT-NEW'
  const commonPrefix = buildExactBlock({
    label: 'stale-common-prefix',
    lines: 1170,
    bytes: 53_000,
    finalNewline: true,
    overrides: new Map([
      [1, 'export const staleGenerated = {'],
      [300, oldText],
      [500, '  queryReviewEnabled: false,'],
    ]),
  })
  const restoredBlock = buildExactBlock({ label: 'restored-block', lines: 12, bytes: 600, finalNewline: true })
  const staleBlock = buildExactBlock({
    label: 'stale-block',
    lines: 38,
    bytes: 1_492,
    finalNewline: true,
    overrides: new Map([[11, '  brokenNearLine1181: {,']]),
  })
  const commonSuffix = buildExactBlock({
    label: 'stale-common-suffix',
    lines: 612,
    bytes: 27_904,
    finalNewline: true,
    overrides: new Map([
      [611, '  eof: "STALE-BASE-EOF-SENTINEL",'],
      [612, '} // STALE-BASE-CLOSING-SENTINEL'],
    ]),
  })
  const restored = Buffer.concat([commonPrefix, restoredBlock, commonSuffix])
  const staleBase = Buffer.concat([commonPrefix, staleBlock, commonSuffix])
  return {
    name: 'stale-base',
    provenance: 'Synthetic identities are independent of repository SHA prefixes 362df765/fc7d9296.',
    original: staleBase,
    intendedResult: replaceUnique(staleBase, oldText, newText),
    edit: { oldText, newText },
    corruptions: { restored },
    eofSentinel: 'STALE-BASE-EOF-SENTINEL',
    closingSentinel: 'STALE-BASE-CLOSING-SENTINEL',
    exactSuffix: '  eof: "STALE-BASE-EOF-SENTINEL",\n} // STALE-BASE-CLOSING-SENTINEL\n',
  }
}

function corpusH(restored: Buffer): GeneratedCorpus {
  const oldText = '  queryReviewEnabled: false,'
  const newText = '  queryReviewEnabled: true,'
  const original = Buffer.from(restored)
  const intendedResult = replaceUnique(original, oldText, newText)
  const syntheticLost650 = Buffer.from(`${lines(intendedResult).slice(0, 1144).join('\n')}\n`)
  return {
    name: 'queries-post-restore-recurrence',
    provenance:
      'Standalone synthetic 650-line-loss guard with unknown cause; it does not attribute concurrency, a writer, or a mechanism. Corpus F restored bytes are only a generated scaffold.',
    original,
    intendedResult,
    edit: { oldText, newText },
    corruptions: { syntheticLost650 },
    eofSentinel: 'STALE-BASE-EOF-SENTINEL',
    closingSentinel: 'STALE-BASE-CLOSING-SENTINEL',
    exactSuffix: '  eof: "STALE-BASE-EOF-SENTINEL",\n} // STALE-BASE-CLOSING-SENTINEL\n',
  }
}

function corpusG(): GeneratedCorpus {
  const oldText = '  lifecycleEnabled: false,'
  const newText = '  lifecycleEnabled: true,'
  const original = buildExactBlock({
    label: 'amtp-node-recurrence',
    lines: 1502,
    bytes: 63_962,
    finalNewline: true,
    overrides: new Map([
      [1, 'export const generatedNodeConformance = {'],
      [700, oldText],
      [1501, '  eofSentinel: "AMTP-NODE-RECURRENCE-EOF-SENTINEL",'],
      [1502, '} // AMTP-NODE-RECURRENCE-CLOSE'],
    ]),
  })
  const intendedResult = replaceUnique(original, oldText, newText)
  const unexpectedShrink = Buffer.from(lines(intendedResult).slice(0, 1200).join('\n'))
  return {
    name: 'amtp-node-recurrence',
    provenance:
      'Synthetic recurrence guard; active AMTP source and unavailable corrupt bytes are never accessed or inferred.',
    original,
    intendedResult,
    edit: { oldText, newText },
    corruptions: { unexpectedShrink },
    eofSentinel: 'AMTP-NODE-RECURRENCE-EOF-SENTINEL',
    closingSentinel: 'AMTP-NODE-RECURRENCE-CLOSE',
    exactSuffix: '  eofSentinel: "AMTP-NODE-RECURRENCE-EOF-SENTINEL",\n} // AMTP-NODE-RECURRENCE-CLOSE\n',
  }
}

function validateMarkerUniqueness(corpus: GeneratedCorpus): GeneratedCorpus {
  const count = (value: Buffer, marker: string) => decodeUtf8Fatal(value).split(marker).length - 1
  if (count(corpus.original, corpus.edit.oldText) !== 1) throw new Error(`${corpus.name}: edit marker is not unique`)
  if (count(corpus.original, corpus.eofSentinel) !== 1) throw new Error(`${corpus.name}: EOF marker is not unique`)
  if (count(corpus.original, corpus.closingSentinel) !== 1)
    throw new Error(`${corpus.name}: closing marker is not unique`)
  if (count(corpus.intendedResult, corpus.edit.newText) !== 1) {
    throw new Error(`${corpus.name}: result marker is not unique`)
  }
  if (!corpus.original.subarray(-Buffer.byteLength(corpus.exactSuffix)).equals(Buffer.from(corpus.exactSuffix))) {
    throw new Error(`${corpus.name}: exact closing suffix is absent`)
  }
  if (!corpus.intendedResult.subarray(-Buffer.byteLength(corpus.exactSuffix)).equals(Buffer.from(corpus.exactSuffix))) {
    throw new Error(`${corpus.name}: intended result changed the exact closing suffix`)
  }
  return corpus
}

const staleBaseCorpus = validateMarkerUniqueness(corpusF())

export const realEditCorpora = {
  diffText: validateMarkerUniqueness(corpusA()),
  executor: validateMarkerUniqueness(corpusB()),
  schema: validateMarkerUniqueness(corpusC()),
  providerBase: validateMarkerUniqueness(corpusD()),
  providerSchema: validateMarkerUniqueness(corpusE()),
  staleBase: staleBaseCorpus,
  amtpNodeRecurrence: validateMarkerUniqueness(corpusG()),
  queriesPostRestoreRecurrence: validateMarkerUniqueness(corpusH(staleBaseCorpus.corruptions.restored)),
} as const

/** Source-reviewed synthetic identities. There is intentionally no update-golden path. */
export const corpusGoldens = {
  diffText: {
    original: {
      bytes: 1200000,
      logicalLines: 2900,
      newlineBytes: 2900,
      finalNewline: true,
      sha256: '388da208c1817fa7f420aff030c9a116ce1a50da488297164df07bc8d72a187d',
    },
    intendedResult: {
      bytes: 1200000,
      logicalLines: 2900,
      newlineBytes: 2900,
      finalNewline: true,
      sha256: '460042c3c7ef6a38bbd6f960418fd7331457ff6b94adc655c6163c15acb52645',
    },
    corruptions: {
      transportContamination: {
        bytes: 448325,
        logicalLines: 1086,
        newlineBytes: 1085,
        finalNewline: false,
        sha256: 'ab5e6d399c3c18ebe2a46d93c21462a22cb0c39b1103295b3235ee454b9bc685',
      },
    },
  },
  executor: {
    original: {
      bytes: 135000,
      logicalLines: 1695,
      newlineBytes: 1695,
      finalNewline: true,
      sha256: '2e73b7b4dd7ee82e6a18a90e4152a76e05d5c0fb5a76c497a33450aaf3b5a8c4',
    },
    intendedResult: {
      bytes: 135000,
      logicalLines: 1695,
      newlineBytes: 1695,
      finalNewline: true,
      sha256: '0703007097902f04b0e90c96d5a7409747b303134b61c35bdf44e6faac3f2cf1',
    },
    corruptions: {
      transportTruncation: {
        bytes: 85576,
        logicalLines: 1076,
        newlineBytes: 1075,
        finalNewline: false,
        sha256: '5ae967856c6d7dbb354856971620cc64059622b7d92738b14e60ca6ba7e215cf',
      },
    },
  },
  schema: {
    original: {
      bytes: 79000,
      logicalLines: 988,
      newlineBytes: 988,
      finalNewline: true,
      sha256: 'd3e574296f3cf3d2219e7898a2e8390594a14b65208b86f905e2e0b9f7b5f77a',
    },
    intendedResult: {
      bytes: 79000,
      logicalLines: 988,
      newlineBytes: 988,
      finalNewline: true,
      sha256: 'bf51fcd090d67fa0c744ac485e9fb85a26965bce1b8829a84b55b0c560988a81',
    },
    corruptions: {
      transportTruncation: {
        bytes: 70558,
        logicalLines: 882,
        newlineBytes: 881,
        finalNewline: false,
        sha256: '503d4a0529d81cf964ee01617befe200b29861504b3a25178eb1dfb542519d4a',
      },
    },
  },
  providerBase: {
    original: {
      bytes: 108629,
      logicalLines: 2681,
      newlineBytes: 2681,
      finalNewline: true,
      sha256: '5124b2c92a288bfa313e0e4aaffdbc0db651b11eea4247678cd78f984bb10119',
    },
    intendedResult: {
      bytes: 108629,
      logicalLines: 2681,
      newlineBytes: 2681,
      finalNewline: true,
      sha256: 'c7e821a62292e72956526908690a57b43e3748d9ef093a9e8cacc2075a5f0156',
    },
    corruptions: {
      providerSizeEofCorrupt: {
        bytes: 52414,
        logicalLines: 1318,
        newlineBytes: 1318,
        finalNewline: true,
        sha256: '24a01fdf31a5f379299e4c45f3963416d755b8e079143d8f8b89c23ca84d1e16',
      },
      providerDiffStatCorrupt: {
        bytes: 52414,
        logicalLines: 1317,
        newlineBytes: 1317,
        finalNewline: true,
        sha256: '8b1b92e7780a3a5bcb3610338d41e4eb44683faaad813f45e2e31922105a59b6',
      },
    },
  },
  providerSchema: {
    original: {
      bytes: 101971,
      logicalLines: 2122,
      newlineBytes: 2122,
      finalNewline: true,
      sha256: '73a0f892389ebfa5135af09857ee49d46cc4c0e4c09cabd82c3e227c514182f2',
    },
    intendedResult: {
      bytes: 102072,
      logicalLines: 2126,
      newlineBytes: 2126,
      finalNewline: true,
      sha256: 'd8e90ab476699a1309c2b566d4f759e6178a5e0e20a3b5abcf2ea2ee126e9964',
    },
    corruptions: {
      providerSchemaCorrupt: {
        bytes: 51526,
        logicalLines: 1152,
        newlineBytes: 1152,
        finalNewline: true,
        sha256: '56b570a8836e16e4e21a18b4c4f148339b8d8b905bc8c2dc234cc589a8857165',
      },
    },
  },
  staleBase: {
    original: {
      bytes: 82396,
      logicalLines: 1820,
      newlineBytes: 1820,
      finalNewline: true,
      sha256: 'e878a9eb50194203ef5bc89594b96a0562f750a610ebcff1d718b78e2bee7032',
    },
    intendedResult: {
      bytes: 82396,
      logicalLines: 1820,
      newlineBytes: 1820,
      finalNewline: true,
      sha256: '1784dad838599a422bbce7c75cb7a0163bb8c60dab0cab325f6441d0aefb453c',
    },
    corruptions: {
      restored: {
        bytes: 81504,
        logicalLines: 1794,
        newlineBytes: 1794,
        finalNewline: true,
        sha256: '163b87aebce6cb00c5522c4bfdfb2cf7b3acb51d344ae8c5b8d8661a6f7a90a1',
      },
    },
  },
  amtpNodeRecurrence: {
    original: {
      bytes: 63962,
      logicalLines: 1502,
      newlineBytes: 1502,
      finalNewline: true,
      sha256: '2c3b1f3939b26a7fe5862818ae7095e52772d5f88a25844462f9ef045ab4f69e',
    },
    intendedResult: {
      bytes: 63961,
      logicalLines: 1502,
      newlineBytes: 1502,
      finalNewline: true,
      sha256: 'b6fcca02939e6ac3e5b24e0a6415ae5265bb8c66fc1e72a433b68ecb9f864e67',
    },
    corruptions: {
      unexpectedShrink: {
        bytes: 51276,
        logicalLines: 1200,
        newlineBytes: 1199,
        finalNewline: false,
        sha256: '170bab1d589451dcb823507eae0dc27c42da730c063cb8730355213954fe85ec',
      },
    },
  },
  queriesPostRestoreRecurrence: {
    original: {
      bytes: 81504,
      logicalLines: 1794,
      newlineBytes: 1794,
      finalNewline: true,
      sha256: '163b87aebce6cb00c5522c4bfdfb2cf7b3acb51d344ae8c5b8d8661a6f7a90a1',
    },
    intendedResult: {
      bytes: 81503,
      logicalLines: 1794,
      newlineBytes: 1794,
      finalNewline: true,
      sha256: '829cae679dfb49e3607bef54e46033f54801021fab8991efb67afd260c3bd113',
    },
    corruptions: {
      syntheticLost650: {
        bytes: 51829,
        logicalLines: 1144,
        newlineBytes: 1144,
        finalNewline: true,
        sha256: '408cfa954aba5ca2eb66c4c658f9cf9f5b9e8ac0396e5eb9c6b01b8d090ca3a6',
      },
    },
  },
} as const
