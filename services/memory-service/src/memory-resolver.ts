import type {
  CanonicalMemoryKind,
  MemoryScope,
  MemorySourceType,
  StudentMemory,
} from '@monash-study/shared-types'

import type { MemoryCandidate } from './memory-candidate.js'
import type { MemoryStore } from './memory-store.js'

export interface ResolvedMemoryWrite {
  readonly kind: CanonicalMemoryKind | 'learning_episode'
  readonly scope: MemoryScope
  readonly course: string | null
  readonly topic: string | null
  readonly memoryKey: string | null
  readonly content: string
  readonly importance: number
  readonly confidence: number
  readonly sourceType: MemorySourceType
  readonly sourceSessionId: string | null
}

export type MemoryDecision =
  | { readonly operation: 'ADD'; readonly write: ResolvedMemoryWrite }
  | { readonly operation: 'UPDATE'; readonly memoryId: string; readonly write: ResolvedMemoryWrite }
  | { readonly operation: 'RESOLVE'; readonly memoryId: string }
  | { readonly operation: 'ARCHIVE'; readonly memoryId: string }
  | { readonly operation: 'DELETE'; readonly memoryId: string }
  | { readonly operation: 'NOOP'; readonly memoryId?: string }

const SOURCE_PRIORITY: Readonly<Record<MemorySourceType, number>> = {
  agent_inferred: 1,
  derived: 2,
  system_observed: 3,
  user_explicit: 4,
}

/** Converts extracted candidates into deterministic store operations. */
export class MemoryResolver {
  readonly #store: MemoryStore

  constructor(store: MemoryStore) {
    this.#store = store
  }

  resolve(candidate: MemoryCandidate): MemoryDecision {
    if (candidate.operation === 'NOOP') return { operation: 'NOOP' }
    const existing = findExisting(this.#store, candidate)

    if (candidate.operation === 'DELETE') {
      if (candidate.sourceType !== 'user_explicit' || existing === undefined) {
        return noop(existing)
      }
      return { operation: 'DELETE', memoryId: existing.memoryId }
    }
    if (candidate.operation === 'RESOLVE') {
      if (existing === undefined
        || (existing.kind !== 'weakness' && existing.kind !== 'study_progress')
        || !hasSufficientPriority(candidate.sourceType, existing.sourceType)) {
        return noop(existing)
      }
      return existing.status === 'resolved'
        ? noop(existing)
        : { operation: 'RESOLVE', memoryId: existing.memoryId }
    }
    if (candidate.operation === 'ARCHIVE') {
      if (existing?.kind !== 'learning_episode') return noop(existing)
      return existing.status === 'archived'
        ? noop(existing)
        : { operation: 'ARCHIVE', memoryId: existing.memoryId }
    }

    const write = requireWrite(candidate)
    if (write.kind === 'learning_episode') {
      return candidate.operation === 'ADD' ? { operation: 'ADD', write } : { operation: 'NOOP' }
    }
    if (existing === undefined) return { operation: 'ADD', write }
    if (existing.kind === 'learning_episode' || !hasSufficientPriority(write.sourceType, existing.sourceType)) {
      return noop(existing)
    }
    if (existing.status === 'active'
      && existing.content === write.content
      && existing.importance === write.importance
      && existing.confidence === write.confidence
      && existing.sourceType === write.sourceType) {
      return noop(existing)
    }
    return { operation: 'UPDATE', memoryId: existing.memoryId, write }
  }
}

function findExisting(store: MemoryStore, candidate: MemoryCandidate): StudentMemory | undefined {
  if (candidate.targetMemoryId !== undefined) return store.get(candidate.targetMemoryId)
  if (candidate.memoryKey !== undefined) return store.getByKey(candidate.memoryKey)
  return undefined
}

function requireWrite(candidate: MemoryCandidate): ResolvedMemoryWrite {
  if (candidate.kind === undefined
    || candidate.scope === undefined
    || candidate.content === undefined
    || candidate.importance === undefined
    || candidate.confidence === undefined
    || candidate.sourceType === undefined) {
    throw new Error('Resolved ADD/UPDATE candidate is missing write fields')
  }
  if (candidate.kind !== 'learning_episode' && candidate.memoryKey === undefined) {
    throw new Error('Canonical ADD/UPDATE candidate requires memoryKey')
  }
  return {
    kind: candidate.kind,
    scope: candidate.scope,
    course: candidate.course?.trim() || null,
    topic: candidate.topic?.trim() || null,
    memoryKey: candidate.kind === 'learning_episode' ? null : candidate.memoryKey ?? null,
    content: candidate.content.trim(),
    importance: candidate.importance,
    confidence: candidate.confidence,
    sourceType: candidate.sourceType,
    sourceSessionId: candidate.sourceSessionId?.trim() || null,
  }
}

function hasSufficientPriority(
  candidate: MemorySourceType | undefined,
  existing: MemorySourceType,
): boolean {
  return candidate !== undefined && SOURCE_PRIORITY[candidate] >= SOURCE_PRIORITY[existing]
}

function noop(memory?: StudentMemory): MemoryDecision {
  return memory === undefined
    ? { operation: 'NOOP' }
    : { operation: 'NOOP', memoryId: memory.memoryId }
}
