import type { NormalizedDocument } from '../../../../packages/shared-types/src/normalized-document.js'
import { NormalizedDocumentLoader } from '../normalization/normalized-document-loader.js'
import {
  isDocumentIndexCurrent,
  type LightRAGIndexState,
} from './lightrag-index-state.js'
import { LightRAGIndexStateStore } from './lightrag-index-state-store.js'
import {
  LightRAGWorkerClient,
  type LightRAGCourseBatchOperation,
  type LightRAGCourseBatchResult,
  type LightRAGDeletionResult,
  type LightRAGIngestionResult,
} from './lightrag-worker-client.js'

export interface LightRAGDocumentIndexClient {
  ingestDocument(document: NormalizedDocument): Promise<LightRAGIngestionResult>
  deleteDocument(documentId: string, course: string | null): Promise<LightRAGDeletionResult>
  syncCourseBatch(
    course: string,
    operations: readonly LightRAGCourseBatchOperation[],
  ): Promise<LightRAGCourseBatchResult>
}

export interface LightRAGSyncServiceOptions {
  readonly loader?: NormalizedDocumentLoader
  readonly client?: LightRAGDocumentIndexClient
  readonly stateStore?: LightRAGIndexStateStore
}

export type LightRAGDocumentSyncStatus = 'indexed' | 'updated' | 'unchanged'

export interface LightRAGDocumentSyncResult {
  readonly documentId: string
  readonly resourceId: string
  readonly course: string | null
  readonly status: LightRAGDocumentSyncStatus
  readonly indexedAt?: string
}

export interface LightRAGCourseSyncPlan {
  readonly course: string
  readonly totalDocuments: number
  readonly indexed: readonly string[]
  readonly updated: readonly string[]
  readonly unchanged: readonly string[]
  readonly removed: readonly string[]
}

export interface LightRAGCourseSyncFailure {
  readonly documentId: string
  readonly operation: 'index' | 'update' | 'remove'
  readonly message: string
}

export interface LightRAGCourseSyncResult {
  readonly course: string
  readonly totalDocuments: number
  readonly indexed: number
  readonly updated: number
  readonly unchanged: number
  readonly removed: number
  readonly failed: number
  readonly failures: readonly LightRAGCourseSyncFailure[]
  readonly startedAt: string
  readonly completedAt: string
}

interface CourseSnapshot {
  readonly plan: LightRAGCourseSyncPlan
  readonly documents: ReadonlyMap<string, NormalizedDocument>
}

interface PendingBatchOperation {
  readonly wire: LightRAGCourseBatchOperation
  readonly operation: LightRAGCourseSyncFailure['operation']
  readonly document?: NormalizedDocument
}

/** Coordinates document comparison, deletion, ingestion, and durable state. */
export class LightRAGSyncService {
  readonly #loader: NormalizedDocumentLoader
  readonly #client: LightRAGDocumentIndexClient
  readonly #stateStore: LightRAGIndexStateStore

  constructor(options: LightRAGSyncServiceOptions = {}) {
    this.#loader = options.loader ?? new NormalizedDocumentLoader()
    this.#client = options.client ?? new LightRAGWorkerClient()
    this.#stateStore = options.stateStore ?? new LightRAGIndexStateStore()
  }

  async syncDocument(documentId: string): Promise<LightRAGDocumentSyncResult> {
    const document = await this.#loader.get(documentId)
    if (document === undefined) throw new Error(`NormalizedDocument not found: ${documentId}`)

    const previousState = this.#stateStore.get(documentId)
    if (previousState !== undefined && isDocumentIndexCurrent(document, previousState)) {
      return {
        documentId: document.documentId,
        resourceId: document.resourceId,
        course: document.course,
        status: 'unchanged',
        indexedAt: previousState.indexedAt,
      }
    }

    const status: LightRAGDocumentSyncStatus = previousState === undefined ? 'indexed' : 'updated'
    if (previousState !== undefined) {
      const deletion = await this.#client.deleteDocument(document.documentId, previousState.course)
      if (!deletion.deleted) {
        const detail = deletion.message === undefined ? '' : `: ${deletion.message}`
        throw new Error(`LightRAG delete did not complete for ${document.documentId}${detail}`)
      }
      this.#stateStore.delete(documentId)
    }

    await this.#client.ingestDocument(document)
    const indexedAt = new Date().toISOString()
    this.#stateStore.upsert(toIndexState(document, indexedAt))

    return {
      documentId: document.documentId,
      resourceId: document.resourceId,
      course: document.course,
      status,
      indexedAt,
    }
  }

  async planCourseSync(course: string): Promise<LightRAGCourseSyncPlan> {
    return (await this.#courseSnapshot(course)).plan
  }

  async syncCourse(course: string): Promise<LightRAGCourseSyncResult> {
    const startedAt = new Date().toISOString()
    const { plan, documents } = await this.#courseSnapshot(course)
    const failures: LightRAGCourseSyncFailure[] = []
    const pending: PendingBatchOperation[] = []

    for (const documentId of plan.indexed) {
      const document = requireDocument(documents, documentId)
      pending.push({ wire: { kind: 'index', document }, operation: 'index', document })
    }

    for (const documentId of plan.updated) {
      const document = requireDocument(documents, documentId)
      const previousState = this.#stateStore.get(documentId)
      if (previousState === undefined) {
        pending.push({ wire: { kind: 'index', document }, operation: 'update', document })
        continue
      }
      if (previousState.course !== course) {
        try {
          const deletion = await this.#client.deleteDocument(documentId, previousState.course)
          if (!deletion.deleted) throw new Error(deletion.message ?? 'old course deletion did not complete')
          this.#stateStore.delete(documentId)
          pending.push({ wire: { kind: 'index', document }, operation: 'update', document })
        } catch (error) {
          failures.push({ documentId, operation: 'update', message: errorMessage(error) })
        }
        continue
      }
      pending.push({ wire: { kind: 'replace', document }, operation: 'update', document })
    }

    for (const documentId of plan.removed) {
      pending.push({ wire: { kind: 'remove', documentId }, operation: 'remove' })
    }

    let indexed = 0
    let updated = 0
    let removed = 0
    if (pending.length > 0) {
      const batch = await this.#client.syncCourseBatch(course, pending.map((item) => item.wire))
      const results = new Map(batch.operations.map((result) => [result.documentId, result]))
      for (const item of pending) {
        const documentId = operationDocumentId(item.wire)
        const result = results.get(documentId)
        if (result === undefined) {
          failures.push({ documentId, operation: item.operation, message: 'Batch worker returned no result' })
          continue
        }
        if (!result.ok) {
          if (item.operation === 'update' && result.stage === 'ingest' && result.oldDeleted === true) {
            this.#stateStore.delete(documentId)
          }
          failures.push({
            documentId,
            operation: item.operation,
            message: result.error?.message ?? `Batch ${result.kind} failed`,
          })
          continue
        }

        if (item.operation === 'remove') {
          this.#stateStore.delete(documentId)
          removed += 1
          continue
        }
        const document = item.document
        if (document === undefined) throw new Error(`Missing document for successful ${item.operation}: ${documentId}`)
        this.#stateStore.upsert(toIndexState(document, new Date().toISOString()))
        if (item.operation === 'index') indexed += 1
        else updated += 1
      }
    }

    return {
      course,
      totalDocuments: plan.totalDocuments,
      indexed,
      updated,
      unchanged: plan.unchanged.length,
      removed,
      failed: failures.length,
      failures,
      startedAt,
      completedAt: new Date().toISOString(),
    }
  }

  getIndexState(documentId: string): LightRAGIndexState | undefined {
    return this.#stateStore.get(documentId)
  }

  async #courseSnapshot(course: string): Promise<CourseSnapshot> {
    const currentDocuments = await this.#loader.list({ course })
    const documents = new Map(currentDocuments.map((document) => [document.documentId, document]))
    const indexed: string[] = []
    const updated: string[] = []
    const unchanged: string[] = []

    for (const document of currentDocuments) {
      const state = this.#stateStore.get(document.documentId)
      if (state === undefined) indexed.push(document.documentId)
      else if (isDocumentIndexCurrent(document, state)) unchanged.push(document.documentId)
      else updated.push(document.documentId)
    }

    const removed = this.#stateStore
      .listByCourse(course)
      .filter((state) => !documents.has(state.documentId))
      .map((state) => state.documentId)

    return {
      plan: {
        course,
        totalDocuments: currentDocuments.length,
        indexed,
        updated,
        unchanged,
        removed,
      },
      documents,
    }
  }
}

function toIndexState(document: NormalizedDocument, indexedAt: string): LightRAGIndexState {
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

function requireDocument(documents: ReadonlyMap<string, NormalizedDocument>, documentId: string): NormalizedDocument {
  const document = documents.get(documentId)
  if (document === undefined) throw new Error(`NormalizedDocument not found in course snapshot: ${documentId}`)
  return document
}

function operationDocumentId(operation: LightRAGCourseBatchOperation): string {
  return operation.kind === 'remove' ? operation.documentId : operation.document.documentId
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
