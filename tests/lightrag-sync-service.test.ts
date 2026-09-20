import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import type { NormalizedDocument } from '../packages/shared-types/src/normalized-document.js'
import type {
  LightRAGCourseBatchOperation,
  LightRAGCourseBatchOperationResult,
  LightRAGCourseBatchResult,
  LightRAGDeletionResult,
  LightRAGIngestionResult,
} from '../services/knowledge-service/src/lightrag/lightrag-worker-client.js'
import { LightRAGIndexStateStore } from '../services/knowledge-service/src/lightrag/lightrag-index-state-store.js'
import { LightRAGSyncService } from '../services/knowledge-service/src/lightrag/lightrag-sync-service.js'
import {
  NormalizedDocumentLoader,
  type NormalizedDocumentFilter,
} from '../services/knowledge-service/src/normalization/normalized-document-loader.js'

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

test('plans new, unchanged, changed, and removed course documents', async (context) => {
  const newDocument = normalizedDocument({ documentId: 'document-new', resourceId: 'resource-new' })
  const unchangedDocument = normalizedDocument({ documentId: 'document-same', resourceId: 'resource-same' })
  const changedDocument = normalizedDocument({
    documentId: 'document-changed',
    resourceId: 'resource-changed',
    normalizedHash: 'new-hash',
  })
  const { service, store } = await fixture(context, [newDocument, unchangedDocument, changedDocument])
  store.upsert(indexState(unchangedDocument, '2026-09-21T09:00:00.000Z'))
  store.upsert(indexState({ ...changedDocument, normalizedHash: 'old-hash' }, '2026-09-21T09:00:00.000Z'))
  store.upsert(indexState(
    normalizedDocument({ documentId: 'document-removed', resourceId: 'resource-removed' }),
    '2026-09-21T09:00:00.000Z',
  ))

  const plan = await service.planCourseSync('FIT2109')

  assert.deepEqual(plan.indexed, ['document-new'])
  assert.deepEqual(plan.unchanged, ['document-same'])
  assert.deepEqual(plan.updated, ['document-changed'])
  assert.deepEqual(plan.removed, ['document-removed'])
})

test('applies successful course batch state changes and skips unchanged documents', async (context) => {
  const newDocument = normalizedDocument({ documentId: 'document-new', resourceId: 'resource-new' })
  const unchangedDocument = normalizedDocument({ documentId: 'document-same', resourceId: 'resource-same' })
  const changedDocument = normalizedDocument({
    documentId: 'document-changed',
    resourceId: 'resource-changed',
    normalizedHash: 'new-hash',
  })
  const removedDocument = normalizedDocument({ documentId: 'document-removed', resourceId: 'resource-removed' })
  const { service, client, store } = await fixture(context, [newDocument, unchangedDocument, changedDocument])
  const unchangedAt = '2026-09-21T09:00:00.000Z'
  store.upsert(indexState(unchangedDocument, unchangedAt))
  store.upsert(indexState({ ...changedDocument, normalizedHash: 'old-hash' }, unchangedAt))
  store.upsert(indexState(removedDocument, unchangedAt))

  const result = await service.syncCourse('FIT2109')

  assert.deepEqual(
    client.batches[0]?.operations.map((operation) => operation.kind),
    ['index', 'replace', 'remove'],
  )
  assert.equal(result.indexed, 1)
  assert.equal(result.updated, 1)
  assert.equal(result.unchanged, 1)
  assert.equal(result.removed, 1)
  assert.equal(result.failed, 0)
  assert.equal(store.get(newDocument.documentId)?.normalizedHash, newDocument.normalizedHash)
  assert.equal(store.get(changedDocument.documentId)?.normalizedHash, changedDocument.normalizedHash)
  assert.equal(store.get(unchangedDocument.documentId)?.indexedAt, unchangedAt)
  assert.equal(store.get(removedDocument.documentId), undefined)

  const second = await service.syncCourse('FIT2109')
  assert.equal(second.unchanged, 3)
  assert.equal(client.batches.length, 1)
})

test('preserves or removes state according to course batch failure stage', async (context) => {
  const newDocument = normalizedDocument({ documentId: 'document-new', resourceId: 'resource-new' })
  const deleteFailDocument = normalizedDocument({
    documentId: 'document-delete-fail',
    resourceId: 'resource-delete-fail',
    normalizedHash: 'new-delete-hash',
  })
  const ingestFailDocument = normalizedDocument({
    documentId: 'document-ingest-fail',
    resourceId: 'resource-ingest-fail',
    normalizedHash: 'new-ingest-hash',
  })
  const removedDocument = normalizedDocument({ documentId: 'document-remove-fail', resourceId: 'resource-remove-fail' })
  const { service, client, store } = await fixture(context, [newDocument, deleteFailDocument, ingestFailDocument])
  const indexedAt = '2026-09-21T09:00:00.000Z'
  store.upsert(indexState({ ...deleteFailDocument, normalizedHash: 'old-delete-hash' }, indexedAt))
  store.upsert(indexState({ ...ingestFailDocument, normalizedHash: 'old-ingest-hash' }, indexedAt))
  store.upsert(indexState(removedDocument, indexedAt))
  client.batchResults = [
    failedBatchResult('document-new', 'index', 'ingest', false),
    failedBatchResult('document-delete-fail', 'replace', 'delete', false),
    failedBatchResult('document-ingest-fail', 'replace', 'ingest', true),
    failedBatchResult('document-remove-fail', 'remove', 'delete', false),
  ]

  const result = await service.syncCourse('FIT2109')

  assert.equal(result.failed, 4)
  assert.equal(store.get('document-new'), undefined)
  assert.equal(store.get('document-delete-fail')?.normalizedHash, 'old-delete-hash')
  assert.equal(store.get('document-ingest-fail'), undefined)
  assert.equal(store.get('document-remove-fail')?.indexedAt, indexedAt)
})

async function fixture(
  context: TestContext,
  document: NormalizedDocument | readonly NormalizedDocument[],
): Promise<{
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

function failedBatchResult(
  documentId: string,
  kind: LightRAGCourseBatchOperation['kind'],
  stage: 'delete' | 'ingest',
  oldDeleted: boolean,
): LightRAGCourseBatchOperationResult {
  return {
    documentId,
    kind,
    ok: false,
    stage,
    oldDeleted,
    error: { type: 'TestError', message: `${kind} failed at ${stage}` },
  }
}

class FakeLoader extends NormalizedDocumentLoader {
  readonly #documents: readonly NormalizedDocument[]

  constructor(document: NormalizedDocument | readonly NormalizedDocument[]) {
    super()
    this.#documents = Array.isArray(document) ? document : [document]
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

class FakeClient {
  readonly ingested: NormalizedDocument[] = []
  readonly deleted: Array<{ readonly documentId: string; readonly course: string | null }> = []
  readonly batches: Array<{ readonly course: string; readonly operations: readonly LightRAGCourseBatchOperation[] }> = []
  ingestError: Error | undefined
  batchResults: readonly LightRAGCourseBatchOperationResult[] | undefined

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

  async syncCourseBatch(
    course: string,
    operations: readonly LightRAGCourseBatchOperation[],
  ): Promise<LightRAGCourseBatchResult> {
    this.batches.push({ course, operations })
    return {
      course,
      workingDir: `/tmp/lightrag/${course}`,
      operations: this.batchResults ?? operations.map((operation) => ({
        documentId: operation.kind === 'remove' ? operation.documentId : operation.document.documentId,
        kind: operation.kind,
        ok: true,
      })),
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
