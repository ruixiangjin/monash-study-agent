import type {
  MemoryKind,
  MemoryOperation,
  MemoryScope,
  MemorySourceType,
} from '@monash-study/shared-types'

export interface MemoryObservation {
  readonly userMessage: string
  readonly assistantResponse: string
  readonly sourceSessionId: string
  readonly sourceTurnId?: string
  readonly course?: string
  readonly topic?: string
}

export interface MemoryCandidate {
  readonly operation: MemoryOperation
  readonly kind?: MemoryKind
  readonly scope?: MemoryScope
  readonly course?: string | null
  readonly topic?: string | null
  readonly memoryKey?: string
  readonly targetMemoryId?: string
  readonly content?: string
  readonly importance?: number
  readonly confidence?: number
  readonly sourceType?: MemorySourceType
  readonly sourceSessionId?: string
  readonly sourceTurnId?: string
  readonly deleteIntent?: 'explicit_user_forget'
}

export interface MemoryCandidateExtractor {
  extract(observation: MemoryObservation): Promise<readonly MemoryCandidate[]>
}
