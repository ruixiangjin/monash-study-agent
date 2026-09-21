import type { StudentMemory } from '@monash-study/shared-types'

import type { MemoryEmbeddingProvider } from './memory-embedding-provider.js'
import type { MemoryStore } from './memory-store.js'

export interface MemoryRecallQuery {
  readonly query: string
  readonly course?: string
  readonly topic?: string
  readonly limit?: number
  readonly globalLimit?: number
}

export interface MemoryScoreComponents {
  readonly semantic: number
  readonly keyword: number
  readonly importance: number
  readonly confidence: number
  readonly recency: number
  readonly total: number
}

export interface MemoryContext {
  readonly memory: StudentMemory
  readonly direct: boolean
  readonly score: MemoryScoreComponents
}

export interface MemoryRetrieverOptions {
  readonly now?: () => Date
}

const WEIGHTS = {
  semantic: 0.55,
  keyword: 0.2,
  importance: 0.1,
  confidence: 0.1,
  recency: 0.05,
} as const

/** Global direct load plus scoped FTS/BGE hybrid retrieval with explainable scores. */
export class MemoryRetriever {
  readonly #store: MemoryStore
  readonly #embeddingProvider: MemoryEmbeddingProvider
  readonly #now: () => Date

  constructor(
    store: MemoryStore,
    embeddingProvider: MemoryEmbeddingProvider,
    options: MemoryRetrieverOptions = {},
  ) {
    this.#store = store
    this.#embeddingProvider = embeddingProvider
    this.#now = options.now ?? (() => new Date())
  }

  async recall(query: MemoryRecallQuery): Promise<readonly MemoryContext[]> {
    if (query.query.trim().length === 0) throw new Error('Memory recall query cannot be empty')
    const limit = positiveLimit(query.limit ?? 8, 'Memory recall limit')
    const globalLimit = positiveLimit(query.globalLimit ?? 10, 'Global memory limit')
    const global = this.#store.listActiveGlobal(globalLimit).map((memory): MemoryContext => ({
      memory,
      direct: true,
      score: directScore(memory),
    }))
    const scopedMemories = this.#store.listActiveForScope({
      ...(query.course === undefined ? {} : { course: query.course }),
      ...(query.topic === undefined ? {} : { topic: query.topic }),
    })
    const scoped = await this.#rankScoped(query.query, scopedMemories, limit)
    const result = [...global, ...scoped]
    this.#store.recordAccess(result.map((context) => context.memory.memoryId), this.#now().toISOString())
    return result
  }

  async #rankScoped(
    query: string,
    memories: readonly StudentMemory[],
    limit: number,
  ): Promise<readonly MemoryContext[]> {
    if (memories.length === 0) return []
    const [queryVector] = await this.#embeddingProvider.embed([query])
    if (queryVector === undefined) throw new Error('Memory embedding provider returned no query vector')
    const keywordScores = this.#store.searchFts(memories.map((memory) => memory.memoryId), query)
    return memories.map((memory): MemoryContext => {
      const embedding = this.#store.getEmbedding(memory.memoryId)
      if (embedding === undefined) throw new Error(`Active Memory is missing embedding: ${memory.memoryId}`)
      const semantic = normalizedCosine(queryVector, embedding.vector)
      const keyword = keywordScores.get(memory.memoryId) ?? 0
      const recency = recencyScore(memory.updatedAt, this.#now())
      const total = semantic * WEIGHTS.semantic
        + keyword * WEIGHTS.keyword
        + memory.importance * WEIGHTS.importance
        + memory.confidence * WEIGHTS.confidence
        + recency * WEIGHTS.recency
      return {
        memory,
        direct: false,
        score: {
          semantic,
          keyword,
          importance: memory.importance,
          confidence: memory.confidence,
          recency,
          total,
        },
      }
    }).sort((left, right) => (
      right.score.total - left.score.total
      || right.memory.updatedAt.localeCompare(left.memory.updatedAt)
      || left.memory.memoryId.localeCompare(right.memory.memoryId)
    )).slice(0, limit)
  }
}

function directScore(memory: StudentMemory): MemoryScoreComponents {
  return {
    semantic: 0,
    keyword: 0,
    importance: memory.importance,
    confidence: memory.confidence,
    recency: 1,
    total: 1,
  }
}

function normalizedCosine(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    throw new Error('Memory embedding dimensions do not match')
  }
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]
    const rightValue = right[index]
    if (leftValue === undefined || rightValue === undefined) continue
    dot += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0
  const cosine = dot / Math.sqrt(leftMagnitude * rightMagnitude)
  return Math.max(0, Math.min(1, (cosine + 1) / 2))
}

function recencyScore(updatedAt: string, now: Date): number {
  const ageMilliseconds = Math.max(0, now.getTime() - new Date(updatedAt).getTime())
  if (!Number.isFinite(ageMilliseconds)) return 0
  const ageDays = ageMilliseconds / 86_400_000
  return 1 / (1 + ageDays / 30)
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be positive`)
  return value
}
