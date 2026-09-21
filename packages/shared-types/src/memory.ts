export const MEMORY_KINDS = [
  'preference',
  'study_progress',
  'weakness',
  'learning_episode',
  'study_strategy',
] as const

export type MemoryKind = (typeof MEMORY_KINDS)[number]
export type CanonicalMemoryKind = Exclude<MemoryKind, 'learning_episode'>
export type MemoryScope = 'global' | 'course' | 'topic'
export type MemoryStatus = 'active' | 'resolved' | 'archived'
export type MemorySourceType = 'user_explicit' | 'system_observed' | 'derived' | 'agent_inferred'
export type MemoryOperation = 'ADD' | 'UPDATE' | 'RESOLVE' | 'NOOP' | 'ARCHIVE' | 'DELETE'
export type PersistedMemoryOperation = Exclude<MemoryOperation, 'NOOP'>

export interface StudentMemory {
  readonly memoryId: string
  readonly memoryKey: string | null
  readonly kind: MemoryKind
  readonly scope: MemoryScope
  readonly course: string | null
  readonly topic: string | null
  readonly content: string
  readonly status: MemoryStatus
  readonly importance: number
  readonly confidence: number
  readonly sourceType: MemorySourceType
  readonly sourceSessionId: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastConfirmedAt: string | null
  readonly lastAccessedAt: string | null
  readonly accessCount: number
}

export interface MemoryEmbedding {
  readonly memoryId: string
  readonly model: string
  readonly vector: readonly number[]
  readonly contentHash: string
  readonly createdAt: string
}

export interface MemoryEmbeddingInput {
  readonly model: string
  readonly vector: readonly number[]
}

export interface MemoryEvent {
  readonly eventId: string
  readonly memoryId: string
  readonly operation: PersistedMemoryOperation
  readonly timestamp: string
}

export interface MemoryWriteResult {
  readonly operation: MemoryOperation
  readonly memory: StudentMemory | null
}
