import type { NormalizedDocument } from '../../../../packages/shared-types/src/normalized-document.js'
import { NormalizedDocumentLoader } from '../normalization/normalized-document-loader.js'
import {
  isDocumentIndexCurrent,
  type LightRAGIndexState,
} from './lightrag-index-state.js'
import { LightRAGIndexStateStore } from './lightrag-index-state-store.js'
import {
  LightRAGWorkerClient,
  type LightRAGDeletionResult,
  type LightRAGIngestionResult,
} from './lightrag-worker-client.js'

export interface LightRAGDocumentIndexClient {
  ingestDocument(document: NormalizedDocument): Promise<LightRAGIngestionResult>
  deleteDocument(documentId: string, course: string | null): Promise<LightRAGDeletionResult>
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

  getIndexState(documentId: string): LightRAGIndexState | undefined {
    return this.#stateStore.get(documentId)
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
