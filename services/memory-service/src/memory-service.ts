import type { MemoryWriteResult } from '@monash-study/shared-types'

import type {
  MemoryCandidate,
  MemoryCandidateExtractor,
  MemoryObservation,
} from './memory-candidate.js'
import type { MemoryLifecycleManager } from './memory-lifecycle-manager.js'
import type { MemoryContext, MemoryRecallQuery, MemoryRetriever } from './memory-retriever.js'
import type { MemoryResolver } from './memory-resolver.js'
import type { MemoryStore } from './memory-store.js'

/** Independent long-term Memory capability, ready for later Main Agent integration. */
export class MemoryService {
  readonly #store: MemoryStore
  readonly #extractor: MemoryCandidateExtractor
  readonly #resolver: MemoryResolver
  readonly #retriever: MemoryRetriever
  readonly #lifecycle: MemoryLifecycleManager
  readonly #episodeWritesByTurn = new Map<string, Map<string, string>>()

  constructor(dependencies: {
    readonly store: MemoryStore
    readonly extractor: MemoryCandidateExtractor
    readonly resolver: MemoryResolver
    readonly retriever: MemoryRetriever
    readonly lifecycle: MemoryLifecycleManager
  }) {
    this.#store = dependencies.store
    this.#extractor = dependencies.extractor
    this.#resolver = dependencies.resolver
    this.#retriever = dependencies.retriever
    this.#lifecycle = dependencies.lifecycle
  }

  recall(query: MemoryRecallQuery): Promise<readonly MemoryContext[]> {
    return this.#retriever.recall(query)
  }

  async observe(input: MemoryObservation): Promise<readonly MemoryWriteResult[]> {
    const candidates = await this.#extractor.extract(input)
    const results: MemoryWriteResult[] = []
    for (const candidate of candidates) results.push(await this.#apply(candidate))
    return results
  }

  manage(command: MemoryCandidate): Promise<MemoryWriteResult> {
    return this.#apply(command)
  }

  forget(memoryId: string): MemoryWriteResult {
    return this.#store.delete(memoryId)
  }

  consolidateEpisode(episodeId: string, higherMemoryId: string): void {
    this.#store.linkEpisodeConsolidation(episodeId, higherMemoryId)
  }

  async #apply(candidate: MemoryCandidate): Promise<MemoryWriteResult> {
    const duplicateEpisodeId = this.#duplicateEpisodeId(candidate)
    if (duplicateEpisodeId !== undefined) return this.#store.noop(duplicateEpisodeId)
    const result = await this.#lifecycle.apply(this.#resolver.resolve(candidate))
    if (candidate.operation === 'ADD'
      && candidate.kind === 'learning_episode'
      && candidate.sourceTurnId !== undefined
      && result.operation === 'ADD'
      && result.memory !== null) {
      this.#rememberEpisodeWrite(candidate, result.memory.memoryId)
    }
    return result
  }

  #duplicateEpisodeId(candidate: MemoryCandidate): string | undefined {
    if (candidate.operation !== 'ADD'
      || candidate.kind !== 'learning_episode'
      || candidate.sourceTurnId === undefined) return undefined
    return this.#episodeWritesByTurn.get(candidate.sourceTurnId)?.get(episodeDedupKey(candidate))
  }

  #rememberEpisodeWrite(candidate: MemoryCandidate, memoryId: string): void {
    const sourceTurnId = candidate.sourceTurnId
    if (sourceTurnId === undefined) return
    let writes = this.#episodeWritesByTurn.get(sourceTurnId)
    if (writes === undefined) {
      if (this.#episodeWritesByTurn.size >= 256) {
        const oldestTurn = this.#episodeWritesByTurn.keys().next().value as string | undefined
        if (oldestTurn !== undefined) this.#episodeWritesByTurn.delete(oldestTurn)
      }
      writes = new Map()
      this.#episodeWritesByTurn.set(sourceTurnId, writes)
    }
    writes.set(episodeDedupKey(candidate), memoryId)
  }
}

function episodeDedupKey(candidate: MemoryCandidate): string {
  return [
    candidate.scope ?? '',
    normalized(candidate.course),
    normalized(candidate.topic),
    normalized(candidate.content).toLocaleLowerCase('en-US'),
  ].join('\u0000')
}

function normalized(value: string | null | undefined): string {
  return value?.normalize('NFKC').trim().replace(/\s+/g, ' ') ?? ''
}
