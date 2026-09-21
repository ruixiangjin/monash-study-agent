import type { MemoryWriteResult, StudentMemory } from '@monash-study/shared-types'

import { embedMemoryContent, type MemoryEmbeddingProvider } from './memory-embedding-provider.js'
import type { MemoryDecision, ResolvedMemoryWrite } from './memory-resolver.js'
import type { MemoryStore } from './memory-store.js'

export interface MemoryLifecycleManagerOptions {
  readonly activeEpisodeLimitPerCourse?: number
}

/** Applies resolved operations and maintains the bounded active Episode set. */
export class MemoryLifecycleManager {
  readonly #store: MemoryStore
  readonly #embeddingProvider: MemoryEmbeddingProvider
  readonly #episodeLimit: number

  constructor(
    store: MemoryStore,
    embeddingProvider: MemoryEmbeddingProvider,
    options: MemoryLifecycleManagerOptions = {},
  ) {
    this.#store = store
    this.#embeddingProvider = embeddingProvider
    this.#episodeLimit = options.activeEpisodeLimitPerCourse ?? 50
    if (!Number.isInteger(this.#episodeLimit) || this.#episodeLimit < 1) {
      throw new Error('Active episode limit per course must be positive')
    }
  }

  async apply(decision: MemoryDecision): Promise<MemoryWriteResult> {
    if (decision.operation === 'NOOP') return this.#store.noop(decision.memoryId)
    if (decision.operation === 'RESOLVE') return this.#store.resolve(decision.memoryId)
    if (decision.operation === 'ARCHIVE') return this.#store.archive(decision.memoryId)
    if (decision.operation === 'DELETE') return this.#store.delete(decision.memoryId)

    const embedding = await embedMemoryContent(this.#embeddingProvider, decision.write.content)
    if (decision.operation === 'UPDATE') {
      return this.#store.update(decision.memoryId, {
        content: decision.write.content,
        importance: decision.write.importance,
        confidence: decision.write.confidence,
        sourceType: decision.write.sourceType,
        sourceSessionId: decision.write.sourceSessionId,
        embedding,
      })
    }

    const result = this.#store.add(toAddInput(decision.write, embedding))
    if (decision.write.kind === 'learning_episode' && decision.write.course !== null) {
      this.#enforceEpisodeLimit(decision.write.course)
      const memoryId = result.memory?.memoryId
      if (memoryId !== undefined) {
        return { operation: result.operation, memory: this.#store.get(memoryId) ?? null }
      }
    }
    return result
  }

  #enforceEpisodeLimit(course: string): void {
    const active = this.#store.listActiveEpisodes(course)
    const excess = active.length - this.#episodeLimit
    if (excess <= 0) return
    const archiveOrder = [...active].sort((left, right) => {
      const consolidated = Number(this.#store.isEpisodeConsolidated(right.memoryId))
        - Number(this.#store.isEpisodeConsolidated(left.memoryId))
      if (consolidated !== 0) return consolidated
      if (left.importance !== right.importance) return left.importance - right.importance
      if (left.accessCount !== right.accessCount) return left.accessCount - right.accessCount
      const recency = episodeRecency(left).localeCompare(episodeRecency(right))
      return recency !== 0 ? recency : left.memoryId.localeCompare(right.memoryId)
    })
    for (const episode of archiveOrder.slice(0, excess)) this.#store.archive(episode.memoryId)
  }
}

function toAddInput(
  write: ResolvedMemoryWrite,
  embedding: Parameters<MemoryStore['add']>[0]['embedding'],
): Parameters<MemoryStore['add']>[0] {
  const common = {
    scope: write.scope,
    course: write.course,
    topic: write.topic,
    content: write.content,
    importance: write.importance,
    confidence: write.confidence,
    sourceType: write.sourceType,
    sourceSessionId: write.sourceSessionId,
    embedding,
  }
  if (write.kind === 'learning_episode') return { ...common, kind: 'learning_episode' }
  if (write.memoryKey === null) throw new Error('Canonical Memory write requires memoryKey')
  return { ...common, kind: write.kind, memoryKey: write.memoryKey }
}

function episodeRecency(memory: StudentMemory): string {
  return memory.lastAccessedAt ?? memory.updatedAt
}
