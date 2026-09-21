import { createHash } from 'node:crypto'

import type { Evidence, NormalizedDocument } from '@monash-study/shared-types'
import type { KnowledgeQuery, KnowledgeService } from '@monash-study/study-core'
import { NormalizedDocumentLoader } from '../normalization/normalized-document-loader.js'
import { loadRuntimeConfig, type LoadedRuntimeConfig } from '../runtime/runtime-config.js'
import { LightRAGIndexStateStore } from './lightrag-index-state-store.js'
import {
  LightRAGWorkerClient,
  type LightRAGQueryResult,
  type LightRAGRetrievedChunk,
} from './lightrag-worker-client.js'

export interface LightRAGQueryClient {
  queryCourse(
    course: string,
    query: string,
    options?: { readonly topK?: number; readonly chunkTopK?: number },
  ): Promise<LightRAGQueryResult>
}

export interface LightRAGKnowledgeServiceOptions {
  readonly client?: LightRAGQueryClient
  readonly loader?: NormalizedDocumentLoader
  readonly stateStore?: LightRAGIndexStateStore
  readonly configPath?: string
}

export interface LightRAGSearchResult {
  readonly evidence: readonly Evidence[]
  readonly unresolvedChunks: number
}

/** Provides structured LightRAG retrieval enriched with authoritative course metadata. */
export class LightRAGKnowledgeService implements KnowledgeService {
  readonly #client: LightRAGQueryClient
  readonly #loader: NormalizedDocumentLoader
  readonly #stateStore: LightRAGIndexStateStore
  readonly #runtimeConfig: LoadedRuntimeConfig

  constructor(options: LightRAGKnowledgeServiceOptions = {}) {
    this.#client = options.client ?? new LightRAGWorkerClient()
    this.#loader = options.loader ?? new NormalizedDocumentLoader()
    this.#stateStore = options.stateStore ?? new LightRAGIndexStateStore()
    this.#runtimeConfig = loadRuntimeConfig(options.configPath)
  }

  async search(query: KnowledgeQuery): Promise<readonly Evidence[]> {
    return (await this.searchDetailed(query)).evidence
  }

  async searchDetailed(query: KnowledgeQuery): Promise<LightRAGSearchResult> {
    const text = query.query.trim()
    if (!text) throw new Error('Knowledge query must not be empty')

    const course = query.course?.trim()
    if (!course) throw new Error('Knowledge query requires a course')

    const limit = normalizeLimit(query.limit)
    if (query.week !== undefined && (!Number.isInteger(query.week) || query.week < 0)) {
      throw new Error('Knowledge query week must be a non-negative integer')
    }

    if (this.#stateStore.listByCourse(course).length === 0) {
      return { evidence: [], unresolvedChunks: 0 }
    }

    const documents = await this.#loader.list({ course })
    const documentById = new Map(documents.map((document) => [document.documentId, document]))
    const result = await this.#client.queryCourse(course, text, {
      topK: this.#runtimeConfig.lightrag.query.topK,
      chunkTopK: Math.min(Math.max(limit * 4, this.#runtimeConfig.lightrag.query.chunkTopK), 80),
    })

    const mapped: MappedEvidence[] = []
    const seen = new Set<string>()
    for (const chunk of result.chunks) {
      const documentId = chunk.documentId
      if (documentId === undefined) continue
      const document = documentById.get(documentId)
      if (document === undefined) continue
      if (query.week !== undefined && document.week !== query.week) continue

      const dedupeKey = chunk.chunkId ?? `${documentId}:${hash(chunk.content)}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      mapped.push({
        evidence: toEvidence(course, document, chunk, dedupeKey),
        order: mapped.length,
      })
    }

    if (mapped.some((item) => item.evidence.score !== undefined)) {
      mapped.sort((left, right) => {
        const leftScore = left.evidence.score
        const rightScore = right.evidence.score
        if (leftScore === undefined && rightScore === undefined) return left.order - right.order
        if (leftScore === undefined) return 1
        if (rightScore === undefined) return -1
        return rightScore - leftScore || left.order - right.order
      })
    }
    return {
      evidence: mapped.slice(0, limit).map((item) => item.evidence),
      unresolvedChunks: result.unresolved,
    }
  }
}

interface MappedEvidence {
  readonly evidence: Evidence
  readonly order: number
}

function toEvidence(
  course: string,
  document: NormalizedDocument,
  chunk: LightRAGRetrievedChunk,
  dedupeKey: string,
): Evidence {
  const metadata: Record<string, unknown> = {
    documentId: document.documentId,
    week: document.week,
    resourceSource: document.source,
    contentType: document.contentType,
    sourcePath: document.sourcePath,
    locator: document.locator,
    sourceHash: document.sourceHash,
    normalizedHash: document.normalizedHash,
    normalizationVersion: document.normalizationVersion,
  }
  if (chunk.chunkId !== undefined) metadata.lightragChunkId = chunk.chunkId
  if (chunk.referenceId !== undefined) metadata.lightragReferenceId = chunk.referenceId
  if (chunk.filePath !== undefined) metadata.lightragFilePath = chunk.filePath

  const base = {
    evidenceId: `evidence_lightrag_${hash(`${course}\n${document.documentId}\n${dedupeKey}`).slice(0, 24)}`,
    resourceId: document.resourceId,
    title: document.title,
    content: chunk.content,
    sourceSystem: document.source,
    retrievalProvider: 'lightrag',
    metadata,
  } satisfies Omit<Evidence, 'course' | 'score'>
  const withCourse = document.course === null ? base : { ...base, course: document.course }
  return chunk.score === undefined ? withCourse : { ...withCourse, score: chunk.score }
}

function normalizeLimit(value: number | undefined): number {
  if (value !== undefined && !Number.isFinite(value)) throw new Error('Knowledge query limit must be finite')
  return Math.min(Math.max(Math.trunc(value ?? 8), 1), 20)
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
