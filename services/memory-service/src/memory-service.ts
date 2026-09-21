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
    return this.#lifecycle.apply(this.#resolver.resolve(candidate))
  }
}
