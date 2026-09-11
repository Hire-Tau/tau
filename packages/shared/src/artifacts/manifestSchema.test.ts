import { describe, expect, test } from 'bun:test'

import { artifactManifestSchema, artifactQuestionSchema, artifactRequestSchema } from './manifestSchema'
import type { ArtifactReference } from './manifestSchema'

const validApiReferenceWithId: ArtifactReference = { type: 'api', id: 'pipeline-api' }
const validApiReferenceWithUrl: ArtifactReference = { type: 'api', url: 'https://api.example.com/pipeline' }
void validApiReferenceWithId
void validApiReferenceWithUrl

// @ts-expect-error API references require id or url at the TypeScript type level.
const invalidApiReferenceWithoutIdOrUrl: ArtifactReference = { type: 'api' }
void invalidApiReferenceWithoutIdOrUrl

describe('artifactManifestSchema', () => {
  const validManifest = {
    id: 'sales-dashboard',
    title: 'Sales Dashboard',
    status: 'working',
    summary: 'Visual summary of current sales pipeline',
    entry: {
      type: 'presentation',
      path: 'presentation.json',
    },
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    archived: false,
  }

  test('artifact manifest stores compact current state only', () => {
    expect(
      artifactManifestSchema.parse({
        id: 'artifact-1',
        title: 'Artifact',
        status: 'ready',
        entry: { type: 'markdown', path: 'artifact.md' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        archived: false,
      })
    ).toMatchObject({ id: 'artifact-1', title: 'Artifact' })
  })

  test("accepts a valid manifest with entry.type: 'presentation'", () => {
    const result = artifactManifestSchema.safeParse(validManifest)

    expect(result.success).toBe(true)
  })

  test('accepts artifact questions with voice responses', () => {
    const result = artifactQuestionSchema.safeParse({
      id: 'question-1',
      at: '2026-04-30T00:01:00.000Z',
      title: 'Pick a region',
      question: 'Which sales region should the dashboard focus on?',
      context: 'The artifact builder can tailor charts by region.',
      responseMode: 'single_select',
      choices: ['North America', 'Europe'],
      priority: 'high',
      status: 'answered',
      response: {
        at: '2026-04-30T00:02:00.000Z',
        from: 'voice',
        answer: 'North America',
        brief: 'Focus on North America sales.',
      },
    })

    expect(result.success).toBe(true)
  })

  test.each([
    [
      'empty question id',
      { id: '', at: '2026-04-30T00:01:00.000Z', question: 'Pick one', responseMode: 'free_text', status: 'open' },
    ],
    [
      'invalid response mode',
      {
        id: 'question-1',
        at: '2026-04-30T00:01:00.000Z',
        question: 'Pick one',
        responseMode: 'yes_no',
        status: 'open',
      },
    ],
    [
      'empty choice',
      {
        id: 'question-1',
        at: '2026-04-30T00:01:00.000Z',
        question: 'Pick one',
        responseMode: 'single_select',
        choices: [''],
        status: 'open',
      },
    ],
    [
      'non-voice response',
      {
        id: 'question-1',
        at: '2026-04-30T00:01:00.000Z',
        question: 'Pick one',
        responseMode: 'free_text',
        status: 'answered',
        response: { at: '2026-04-30T00:02:00.000Z', from: 'agent', answer: 'Yes', brief: 'Answered yes.' },
      },
    ],
  ])('rejects invalid artifact question: %s', (_name, question) => {
    const result = artifactQuestionSchema.safeParse(question)

    expect(result.success).toBe(false)
  })

  test.each([
    ['id', { ...validManifest, id: undefined }],
    ['title', { ...validManifest, title: undefined }],
    ['entry.path', { ...validManifest, entry: { type: 'presentation' } }],
  ])('rejects a manifest missing %s', (_field, manifest) => {
    const result = artifactManifestSchema.safeParse(manifest)

    expect(result.success).toBe(false)
  })

  test.each([
    ['empty path', ''],
    ['absolute path', '/presentation.json'],
    ['parent directory segment', '../presentation.json'],
    ['nested parent directory segment', 'assets/../presentation.json'],
    ['backslash path separator', 'assets\\logo.png'],
    ['Windows drive absolute path', 'C:/secret.txt'],
    ['UNC-style network path', '//server/share/file.txt'],
  ])('rejects entry.path with %s', (_name, path) => {
    const result = artifactManifestSchema.safeParse({
      ...validManifest,
      entry: { type: 'presentation', path },
    })

    expect(result.success).toBe(false)
  })

  test.each(['presentation.json', 'document.md', 'assets/logo.png'])('accepts safe relative entry.path %s', (path) => {
    const result = artifactManifestSchema.safeParse({
      ...validManifest,
      entry: { type: 'presentation', path },
    })

    expect(result.success).toBe(true)
  })

  test.each([
    ['agent reference without id', { type: 'agent' }],
    ['thread reference without id', { type: 'thread' }],
    ['workstream reference without id', { type: 'workstream' }],
    ['url reference without url', { type: 'url' }],
    ['url reference with invalid URL', { type: 'url', url: 'not-a-url' }],
    ['file reference without path', { type: 'file' }],
    ['file reference with unsafe path', { type: 'file', path: '../secret.txt' }],
    ['file reference with url instead of path', { type: 'file', url: 'https://example.com/file.txt' }],
    ['api reference without id or url', { type: 'api' }],
    ['artifact reference without id', { type: 'artifact' }],
  ])('rejects invalid artifact reference: %s', (_name, reference) => {
    const result = artifactRequestSchema.safeParse({
      at: '2026-04-30T00:00:00.000Z',
      from: 'voice',
      action: 'create',
      brief: 'Show me a dashboard',
      references: [reference],
    })

    expect(result.success).toBe(false)
  })

  test('accepts all valid artifact reference variants', () => {
    const result = artifactRequestSchema.safeParse({
      at: '2026-04-30T00:00:00.000Z',
      from: 'voice',
      action: 'create',
      brief: 'Show me a dashboard',
      references: [
        { type: 'agent', id: 'agent-1', note: 'Builder' },
        { type: 'thread', id: 'thread-1' },
        { type: 'workstream', id: 'workstream-1' },
        { type: 'url', url: 'https://example.com/data.csv' },
        { type: 'file', path: 'data/pipeline.csv' },
        { type: 'api', id: 'pipeline-api' },
        { type: 'api', url: 'https://api.example.com/pipeline' },
        { type: 'artifact', id: 'previous-dashboard' },
      ],
    })

    expect(result.success).toBe(true)
  })

  test.each([
    ['empty id', { ...validManifest, id: '' }],
    ['empty title', { ...validManifest, title: '' }],
    ['invalid status', { ...validManifest, status: 'done' }],
    ['unknown manifest key', { ...validManifest, unexpected: true }],
    [
      'unknown entry key',
      { ...validManifest, entry: { type: 'presentation', path: 'presentation.json', extra: true } },
    ],
  ])('rejects %s', (_name, manifest) => {
    const result = artifactManifestSchema.safeParse(manifest)

    expect(result.success).toBe(false)
  })

  test('rejects invalid request action', () => {
    const result = artifactRequestSchema.safeParse({
      at: '2026-04-30T00:00:00.000Z',
      from: 'voice',
      action: 'update',
      brief: 'Update it',
    })

    expect(result.success).toBe(false)
  })
})
