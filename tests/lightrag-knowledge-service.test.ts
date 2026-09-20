import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import type { NormalizedDocument } from '@monash-study/shared-types'
import {
  LightRAGIndexStateStore,
  LightRAGKnowledgeService,
  NormalizedDocumentLoader,
  type NormalizedDocumentFilter,
  type LightRAGQueryResult,
  type LightRAGRetrievedChunk,
} from '@monash-study/knowledge-service'

test('maps a structured chunk to Evidence using NormalizedDocument metadata', async (context) => {
  const document = normalizedDocument()
  const { service, client, store } = await fixture(context, [document])
  store.upsert(indexState(document))
  client.result = queryResult([
    {
      chunkId: 'chunk-1',
      documentId: document.documentId,
      filePath: '10-Answers to 5.8.pdf',
      referenceId: '1',
      content: 'A fast-forward merge moves the branch pointer forward.',
      score: 0.91,
    },
  ])

  const [evidence] = await service.search({
    query: 'What is a fast-forward merge in Git?',
    course: 'FIT2109',
    limit: 5,
  })

  assert.ok(evidence)
  assert.equal(evidence.resourceId, document.resourceId)
  assert.equal(evidence.title, document.title)
  assert.equal(evidence.course, document.course)
  assert.equal(evidence.sourceSystem, document.source)
  assert.equal(evidence.retrievalProvider, 'lightrag')
  assert.equal(evidence.score, 0.91)
  assert.equal(evidence.content, 'A fast-forward merge moves the branch pointer forward.')
  assert.equal(evidence.metadata.documentId, document.documentId)
  assert.equal(evidence.metadata.week, 5)
  assert.equal(evidence.metadata.sourcePath, document.sourcePath)
  assert.deepEqual(evidence.metadata.locator, document.locator)
  assert.equal(evidence.metadata.lightragChunkId, 'chunk-1')
  assert.equal(client.lastOptions?.chunkTopK, 20)
})

test('skips unresolved chunks, filters by week, deduplicates, and applies limit', async (context) => {
  const weekFive = normalizedDocument({ documentId: 'document-week-5', week: 5 })
  const weekSix = normalizedDocument({ documentId: 'document-week-6', week: 6 })
  const { service, client, store } = await fixture(context, [weekFive, weekSix])
  store.upsert(indexState(weekFive))
  store.upsert(indexState(weekSix))
  client.result = queryResult([
    { chunkId: 'same', documentId: weekFive.documentId, content: 'week five result', score: 0.5 },
    { chunkId: 'same', documentId: weekFive.documentId, content: 'duplicate result', score: 0.9 },
    { chunkId: 'week-six', documentId: weekSix.documentId, content: 'wrong week', score: 1 },
    { chunkId: 'unresolved', documentId: 'missing-document', content: 'cannot trace', score: 1 },
    { chunkId: 'second', documentId: weekFive.documentId, content: 'second week five result', score: 0.4 },
  ])

  const evidence = await service.search({
    query: 'Git merge',
    course: 'FIT2109',
    week: 5,
    limit: 1,
  })

  assert.equal(evidence.length, 1)
  assert.equal(evidence[0]?.metadata.documentId, weekFive.documentId)
  assert.equal(evidence[0]?.content, 'week five result')
  assert.equal(client.lastOptions?.chunkTopK, 20)
})

test('returns empty without invoking LightRAG when the course has no indexed state', async (context) => {
  const document = normalizedDocument()
  const { service, client } = await fixture(context, [document])

  const evidence = await service.search({ query: 'Git merge', course: 'FIT2109' })

  assert.deepEqual(evidence, [])
  assert.equal(client.calls, 0)
})

test('requires a non-empty query and course', async (context) => {
  const { service } = await fixture(context, [normalizedDocument()])

  await assert.rejects(service.search({ query: ' ', course: 'FIT2109' }), /must not be empty/)
  await assert.rejects(service.search({ query: 'Git merge' }), /requires a course/)
})

class FakeLoader extends NormalizedDocumentLoader {
  readonly #documents: readonly NormalizedDocument[]

  constructor(documents: readonly NormalizedDocument[]) {
    super()
    this.#documents = documents
  }

  override async get(documentId: string): Promise<NormalizedDocument | undefined> {
    return this.#documents.find((document) => document.documentId === documentId)
  }

  override async list(filter: NormalizedDocumentFilter = {}): Promise<readonly NormalizedDocument[]> {
    return this.#documents.filter((document) => (
      (filter.course === undefined || document.course === filter.course)
      && (filter.source === undefined || document.source === filter.source)
      && (filter.resourceId === undefined || document.resourceId === filter.resourceId)
    ))
  }
}

class FakeQueryClient {
  calls = 0
  lastOptions: { readonly topK?: number; readonly chunkTopK?: number } | undefined
  result: LightRAGQueryResult = queryResult([])

  async queryCourse(
    _course: string,
    _query: string,
    options?: { readonly topK?: number; readonly chunkTopK?: number },
  ): Promise<LightRAGQueryResult> {
    this.calls += 1
    this.lastOptions = options
    return this.result
  }
}

async function fixture(context: TestContext, documents: readonly NormalizedDocument[]): Promise<{
  readonly service: LightRAGKnowledgeService
  readonly client: FakeQueryClient
  readonly store: LightRAGIndexStateStore
}> {
  const root = await mkdtemp(join(tmpdir(), 'monash-lightrag-knowledge-'))
  context.after(async () => rm(root, { recursive: true, force: true }))
  const store = new LightRAGIndexStateStore({ databasePath: join(root, 'state.sqlite') })
  const client = new FakeQueryClient()
  return {
    service: new LightRAGKnowledgeService({ loader: new FakeLoader(documents), client, stateStore: store }),
    client,
    store,
  }
}

function queryResult(chunks: readonly LightRAGRetrievedChunk[]): LightRAGQueryResult {
  return { course: 'FIT2109', mode: 'mix', chunks, unresolved: 0 }
}

function indexState(document: NormalizedDocument) {
  return {
    documentId: document.documentId,
    resourceId: document.resourceId,
    course: document.course,
    sourceHash: document.sourceHash,
    normalizedHash: document.normalizedHash,
    normalizationVersion: document.normalizationVersion,
    sourcePath: document.sourcePath,
    indexedAt: '2026-09-21T09:00:00.000Z',
  }
}

function normalizedDocument(overrides: Partial<NormalizedDocument> = {}): NormalizedDocument {
  return {
    documentId: 'document-a',
    resourceId: 'resource-a',
    sourceHash: 'source-a',
    title: 'Git Collaboration Notes',
    course: 'FIT2109',
    week: 5,
    source: 'moodle',
    contentType: 'document',
    text: '# Git Collaboration\n',
    sourcePath: '/tmp/git-notes.pdf',
    locator: { kind: 'document', pageNumbers: [2] },
    normalizationVersion: '1:docling-document:1',
    normalizedHash: 'normalized-a',
    ...overrides,
  }
}
