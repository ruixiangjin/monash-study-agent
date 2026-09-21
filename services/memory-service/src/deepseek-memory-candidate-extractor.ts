import type {
  MemoryKind,
  MemoryOperation,
  MemoryScope,
  MemorySourceType,
} from '@monash-study/shared-types'

import type { MemoryCompletionProvider } from './deepseek-memory-provider.js'
import { canonicalizeMemoryKey } from './memory-key.js'
import type {
  MemoryCandidate,
  MemoryCandidateExtractor,
  MemoryObservation,
} from './memory-candidate.js'

const SYSTEM_PROMPT = `You extract durable student-memory candidates from one completed study turn.
Return JSON only: {"candidates":[...]}.
Allowed kinds: preference, study_progress, weakness, learning_episode, study_strategy.
Allowed scopes: global, course, topic.
Allowed operations: ADD, UPDATE, RESOLVE, NOOP, ARCHIVE, DELETE.
Allowed sourceType: user_explicit, system_observed, derived, agent_inferred.
Use canonical keys with prefixes preference:, progress:, weakness:, strategy:.
Learning episodes must not have memoryKey. Never invent facts. Prefer no candidate over weak inference.
DELETE is only for an explicit user request to forget. RESOLVE requires clear evidence that a weakness or progress state ended.`

export class DeepSeekFlashMemoryCandidateExtractor implements MemoryCandidateExtractor {
  readonly #provider: MemoryCompletionProvider

  constructor(provider: MemoryCompletionProvider) {
    this.#provider = provider
  }

  async extract(observation: MemoryObservation): Promise<readonly MemoryCandidate[]> {
    const raw = await this.#provider.complete(SYSTEM_PROMPT, JSON.stringify({
      currentContext: {
        course: observation.course ?? null,
        topic: observation.topic ?? null,
        sourceSessionId: observation.sourceSessionId,
      },
      completedTurn: {
        user: observation.userMessage,
        assistant: observation.assistantResponse,
      },
    }))
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (error) {
      throw new Error(`DeepSeek Memory candidate JSON is invalid: ${errorMessage(error)}`)
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) {
      throw new Error('DeepSeek Memory candidate response must contain candidates[]')
    }
    return parsed.candidates.map((candidate, index) => parseCandidate(
      candidate,
      observation.sourceSessionId,
      index,
    ))
  }
}

function parseCandidate(value: unknown, sourceSessionId: string, index: number): MemoryCandidate {
  if (!isRecord(value) || !isOperation(value.operation)) {
    throw new Error(`Invalid Memory candidate at index ${index}`)
  }
  if (value.operation === 'NOOP') return { operation: 'NOOP' }
  const candidate: MemoryCandidate = {
    operation: value.operation,
    ...(isKind(value.kind) ? { kind: value.kind } : {}),
    ...(isScope(value.scope) ? { scope: value.scope } : {}),
    ...(isNullableString(value.course) ? { course: value.course } : {}),
    ...(isNullableString(value.topic) ? { topic: value.topic } : {}),
    ...(typeof value.memoryKey === 'string'
      ? { memoryKey: canonicalizeMemoryKey(value.memoryKey) }
      : {}),
    ...(typeof value.targetMemoryId === 'string' ? { targetMemoryId: value.targetMemoryId } : {}),
    ...(typeof value.content === 'string' ? { content: value.content.trim() } : {}),
    ...(isUnitNumber(value.importance) ? { importance: value.importance } : {}),
    ...(isUnitNumber(value.confidence) ? { confidence: value.confidence } : {}),
    ...(isSourceType(value.sourceType) ? { sourceType: value.sourceType } : {}),
    sourceSessionId,
  }
  validateCandidate(candidate, index)
  return candidate
}

function validateCandidate(candidate: MemoryCandidate, index: number): void {
  if ((candidate.targetMemoryId === undefined && candidate.memoryKey === undefined)
    && candidate.operation !== 'ADD') {
    throw new Error(`Memory candidate ${index} requires targetMemoryId or memoryKey`)
  }
  if (candidate.operation === 'ADD' || candidate.operation === 'UPDATE') {
    if (candidate.kind === undefined
      || candidate.scope === undefined
      || candidate.content === undefined
      || candidate.content.length === 0
      || candidate.importance === undefined
      || candidate.confidence === undefined
      || candidate.sourceType === undefined) {
      throw new Error(`Memory candidate ${index} is missing write fields`)
    }
    if (candidate.kind === 'learning_episode' && candidate.memoryKey !== undefined) {
      throw new Error(`Learning episode candidate ${index} cannot have memoryKey`)
    }
    if (candidate.kind !== 'learning_episode' && candidate.memoryKey === undefined) {
      throw new Error(`Canonical Memory candidate ${index} requires memoryKey`)
    }
  }
  if (candidate.operation === 'DELETE' && candidate.sourceType !== 'user_explicit') {
    throw new Error(`DELETE candidate ${index} must be user_explicit`)
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isKind(value: unknown): value is MemoryKind {
  return value === 'preference'
    || value === 'study_progress'
    || value === 'weakness'
    || value === 'learning_episode'
    || value === 'study_strategy'
}

function isScope(value: unknown): value is MemoryScope {
  return value === 'global' || value === 'course' || value === 'topic'
}

function isOperation(value: unknown): value is MemoryOperation {
  return value === 'ADD'
    || value === 'UPDATE'
    || value === 'RESOLVE'
    || value === 'NOOP'
    || value === 'ARCHIVE'
    || value === 'DELETE'
}

function isSourceType(value: unknown): value is MemorySourceType {
  return value === 'user_explicit'
    || value === 'system_observed'
    || value === 'derived'
    || value === 'agent_inferred'
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
