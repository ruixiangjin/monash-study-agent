import type { NormalizedDocument } from '@monash-study/shared-types'
import { NormalizedDocumentLoader } from '../normalization/normalized-document-loader.js'
import {
  isDocumentIndexCurrent,
  type LightRAGIndexState,
} from './lightrag-index-state.js'
import {
  LightRAGIndexStateStore,
  type LightRAGSyncOperation,
  type LightRAGSyncRunStatus,
} from './lightrag-index-state-store.js'
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
  readonly runId: string
  readonly runStatus: LightRAGSyncRunStatus
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
  readonly journalOperationId: number
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
    const { plan, documents } = await this.#courseSnapshot(course)
    const journal = this.#stateStore.beginCourseRun(course, [
      ...plan.indexed.map((documentId) => ({ documentId, operation: 'index' as const })),
      ...plan.updated.map((documentId) => ({ documentId, operation: 'update' as const })),
      ...plan.removed.map((documentId) => ({ documentId, operation: 'remove' as const })),
    ])
    const journalOperationIds = new Map(
      journal.operations.map((operation) => [journalKey(operation.operation, operation.documentId), operation.operationId]),
    )
    const failures: LightRAGCourseSyncFailure[] = []
    const pending: PendingBatchOperation[] = []

    for (const documentId of plan.indexed) {
      const document = requireDocument(documents, documentId)
      pending.push({
        wire: { kind: 'index', document },
        operation: 'index',
        journalOperationId: requireJournalOperationId(journalOperationIds, 'index', documentId),
        document,
      })
    }

    for (const documentId of plan.updated) {
      const document = requireDocument(documents, documentId)
      const previousState = this.#stateStore.get(documentId)
      if (previousState === undefined) {
        pending.push({
          wire: { kind: 'index', document },
          operation: 'update',
          journalOperationId: requireJournalOperationId(journalOperationIds, 'update', documentId),
          document,
        })
        continue
      }
      if (previousState.course !== course) {
        try {
          const deletion = await this.#client.deleteDocument(documentId, previousState.course)
          if (!deletion.deleted) throw new Error(deletion.message ?? 'old course deletion did not complete')
          this.#stateStore.delete(documentId)
          pending.push({
            wire: { kind: 'index', document },
            operation: 'update',
            journalOperationId: requireJournalOperationId(journalOperationIds, 'update', documentId),
            document,
          })
        } catch (error) {
          const message = errorMessage(error)
          this.#stateStore.markOperation(requireJournalOperationId(journalOperationIds, 'update', documentId), 'failed', message)
          failures.push({ documentId, operation: 'update', message })
        }
        continue
      }
      pending.push({
        wire: { kind: 'replace', document },
        operation: 'update',
        journalOperationId: requireJournalOperationId(journalOperationIds, 'update', documentId),
        document,
      })
    }

    for (const documentId of plan.removed) {
      pending.push({
        wire: { kind: 'remove', documentId },
        operation: 'remove',
        journalOperationId: requireJournalOperationId(journalOperationIds, 'remove', documentId),
      })
    }

    let indexed = 0
    let updated = 0
    let removed = 0
    if (pending.length > 0) {
      let batch: LightRAGCourseBatchResult
      try {
        batch = await this.#client.syncCourseBatch(course, pending.map((item) => item.wire))
      } catch (error) {
        this.#stateStore.transaction(() => {
          for (const item of pending) this.#stateStore.markOperation(item.journalOperationId, 'incomplete', errorMessage(error))
          this.#stateStore.markRun(journal.run.runId, 'incomplete', errorMessage(error))
        })
        throw error
      }

      const results = new Map(batch.operations.map((result) => [result.documentId, result]))
      try {
        this.#stateStore.transaction(() => {
          for (const item of pending) {
            const documentId = operationDocumentId(item.wire)
            const result = results.get(documentId)
            if (result === undefined) {
              const message = 'Batch worker returned no result'
              this.#stateStore.markOperation(item.journalOperationId, 'failed', message)
              failures.push({ documentId, operation: item.operation, message })
              continue
            }
            if (!result.ok) {
              if (item.operation === 'update' && result.stage === 'ingest' && result.oldDeleted === true) {
                this.#stateStore.delete(documentId)
              }
              const message = result.error?.message ?? `Batch ${result.kind} failed`
              this.#stateStore.markOperation(item.journalOperationId, 'failed', message)
              failures.push({ documentId, operation: item.operation, message })
              continue
            }

            this.#stateStore.markOperation(item.journalOperationId, 'succeeded')
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
          this.#stateStore.markRun(
            journal.run.runId,
            failures.length === 0 ? 'completed' : 'failed',
            failures.length === 0 ? null : `${failures.length} operation(s) failed`,
          )
          if (failures.length === 0) this.#stateStore.markPriorRunsRecovered(course, journal.run.runId)
        })
      } catch (error) {
        this.#stateStore.markRun(journal.run.runId, 'incomplete', errorMessage(error))
        throw error
      }
    } else {
      this.#stateStore.markRun(
        journal.run.runId,
        failures.length === 0 ? 'completed' : 'failed',
        failures.length === 0 ? null : `${failures.length} operation(s) failed`,
      )
      if (failures.length === 0) this.#stateStore.markPriorRunsRecovered(course, journal.run.runId)
    }

    return {
      runId: journal.run.runId,
      runStatus: failures.length === 0 ? 'completed' : 'failed',
      course,
      totalDocuments: plan.totalDocuments,
      indexed,
      updated,
      unchanged: plan.unchanged.length,
      removed,
      failed: failures.length,
      failures,
      startedAt: journal.run.startedAt,
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
      else if (!this.#stateStore.hasIncompleteCourseRun(course) && isDocumentIndexCurrent(document, state)) unchanged.push(document.documentId)
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

function journalKey(operation: LightRAGSyncOperation, documentId: string): string {
  return `${operation}:${documentId}`
}

function requireJournalOperationId(
  operationIds: ReadonlyMap<string, number>,
  operation: LightRAGSyncOperation,
  documentId: string,
): number {
  const operationId = operationIds.get(journalKey(operation, documentId))
  if (operationId === undefined) throw new Error(`Missing journal operation for ${operation}:${documentId}`)
  return operationId
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
