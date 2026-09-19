import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import type { NormalizedDocument } from '../packages/shared-types/src/normalized-document.js'
import type {
  LightRAGDeletionResult,
  LightRAGIngestionResult,
} from '../services/knowledge-service/src/lightrag/lightrag-worker-client.js'
import { LightRAGIndexStateStore } from '../services/knowledge-service/src/lightrag/lightrag-index-state-store.js'
import { LightRAGSyncService } from '../services/knowledge-service/src/lightrag/lightrag-sync-service.js'
import { NormalizedDocumentLoader } from '../services/knowledge-service/src/normalization/normalized-document-loader.js'

test('indexes a new document and writes state only after ingestion', async (context) => {
  const document = normalizedDocument()
  const { service, client, store } = await fixture(context, document)

  const result = await service.syncDocument(document.documentId)

  assert.equal(result.status, 'indexed')
  assert.equal(client.ingested.length, 1)
  assert.equal(client.deleted.length, 0)
  assert.equal(store.get(document.documentId)?.normalizedHash, document.normalizedHash)
})

test('skips unchanged documents without delete or ingestion', async (context) => {
  const document = normalizedDocument()
  const { service, client, store } = await fixture(context, document)
  const indexedAt = '2026-09-21T09:00:00.000Z'
  store.upsert(indexState(document, indexedAt))

  const result = await service.syncDocument(document.documentId)

  assert.equal(result.status, 'unchanged')
  assert.equal(result.indexedAt, indexedAt)
  assert.equal(client.ingested.length, 0)
  assert.equal(client.deleted.length, 0)
})

test('deletes the old document before indexing a changed document', async (context) => {
  const document = normalizedDocument({ normalizedHash: 'new-normalized' })
  const oldDocument = normalizedDocument({ normalizedHash: 'old-normalized' })
  const { service, client, store } = await fixture(context, document)
  store.upsert(indexState(oldDocument, '2026-09-21T09:00:00.000Z'))

  const result = await service.syncDocument(document.documentId)

  assert.equal(result.status, 'updated')
  assert.deepEqual(client.deleted, [{ documentId: document.documentId, course: 'FIT2109' }])
  assert.deepEqual(client.ingested.map((item) => item.normalizedHash), ['new-normalized'])
  assert.equal(store.get(document.documentId)?.normalizedHash, 'new-normalized')
})

test('uses the old course when a document moves between course indexes', async (context) => {
  const oldDocument = normalizedDocument({ course: 'FIT2109' })
  const document = normalizedDocument({ course: 'FIT2014' })
  const { service, client, store } = await fixture(context, document)
  store.upsert(indexState(oldDocument, '2026-09-21T09:00:00.000Z'))

  await service.syncDocument(document.documentId)

  assert.deepEqual(client.deleted, [{ documentId: document.documentId, course: 'FIT2109' }])
  assert.equal(client.ingested[0]?.course, 'FIT2014')
  assert.equal(store.get(document.documentId)?.course, 'FIT2014')
})

test('removes old state before a failed re-ingestion so the next run can retry', async (context) => {
  const document = normalizedDocument({ normalizedHash: 'new-normalized' })
  const oldDocument = normalizedDocument({ normalizedHash: 'old-normalized' })
  const { service, client, store } = await fixture(context, document)
  store.upsert(indexState(oldDocument, '2026-09-21T09:00:00.000Z'))
  client.ingestError = new Error('model unavailable')

  await assert.rejects(service.syncDocument(document.documentId), /model unavailable/)

  assert.equal(client.deleted.length, 1)
  assert.equal(store.get(document.documentId), undefined)
})

async function fixture(context: TestContext, document: NormalizedDocument): Promise<{
  readonly service: LightRAGSyncService
  readonly client: FakeClient
  readonly store: LightRAGIndexStateStore
}> {
  const root = await mkdtemp(join(tmpdir(), 'monash-lightrag-sync-'))
  context.after(async () => rm(root, { recursive: true, force: true }))
  const store = new LightRAGIndexStateStore({ databasePath: join(root, 'state.sqlite') })
  const client = new FakeClient()
  const loader = new FakeLoader(document)
  return {
    service: new LightRAGSyncService({ loader, client, stateStore: store }),
    client,
    store,
  }
}

class FakeLoader extends NormalizedDocumentLoader {
  readonly #document: NormalizedDocument

  constructor(document: NormalizedDocument) {
    super()
    this.#document = document
  }

  override async get(documentId: string): Promise<NormalizedDocument | undefined> {
    return documentId === this.#document.documentId ? this.#document : undefined
  }
}

class FakeClient {
  readonly ingested: NormalizedDocument[] = []
  readonly deleted: Array<{ readonly documentId: string; readonly course: string | null }> = []
  ingestError: Error | undefined

  async ingestDocument(document: NormalizedDocument): Promise<LightRAGIngestionResult> {
    if (this.ingestError !== undefined) throw this.ingestError
    this.ingested.push(document)
    return {
      documentId: document.documentId,
      resourceId: document.resourceId,
      course: document.course,
      workingDir: '/tmp/lightrag',
      model: 'deepseek-flash',
      embeddingModel: 'BAAI/bge-m3',
    }
  }

  async deleteDocument(documentId: string, course: string | null): Promise<LightRAGDeletionResult> {
    this.deleted.push({ documentId, course })
    return {
      documentId,
      course,
      workingDir: '/tmp/lightrag',
      deleted: true,
      status: 'success',
      message: 'Document deleted',
    }
  }
}

function indexState(document: NormalizedDocument, indexedAt: string) {
  return {
    documentId: document.documentId,
    resourceId: document.resourceId,
    course: document.course,
    sourceHash: document.sourceHash,
    normalizedHash: document.normalizedHash,
    normalizationVersion: document.normalizationVersion,
    sourcePath: document.sourcePath,
    indexedAt,
  }
}

function normalizedDocument(overrides: Partial<NormalizedDocument> = {}): NormalizedDocument {
  return {
    documentId: 'document-a',
    resourceId: 'resource-a',
    sourceHash: 'source-a',
    title: 'Document A',
    course: 'FIT2109',
    week: null,
    source: 'moodle',
    contentType: 'markdown',
    text: '# Document A\n',
    sourcePath: '/tmp/document-a.md',
    locator: { kind: 'file' },
    normalizationVersion: '1:text:1',
    normalizedHash: 'normalized-a',
    ...overrides,
  }
}
