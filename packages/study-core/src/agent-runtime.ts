import type {
  Evidence,
  MemoryKind,
  MemoryOperation,
  MemoryScope,
  MemorySourceType,
  MemoryWriteResult,
  ResourceText,
  StudentMemory,
} from '@monash-study/shared-types'
import type { CourseContext } from './prompts/main-study-agent-prompt.js'

/** Logical tasks understood by ModelPolicy. Provider model names stay outside this layer. */
export type ModelTask = 'main_agent' | 'research_agent'

/** Logical model choices exposed to product code. Provider names stay outside this layer. */
export type ModelProfile = 'fast' | 'strong'

/** Harness-owned conversation identity carried between Study Agent turns. */
export interface StudyConversationRef {
  readonly sessionId: string
  readonly conversationId: string
}

/** Stable input DTO for one Main Study Agent turn. */
export interface StudyTurnInput {
  readonly query: string
  readonly courseContext?: CourseContext
  readonly conversation?: StudyConversationRef
  readonly studentContext?: StudentContext
}

/** Safe, model-facing projection of one recalled Student Memory. */
export interface StudentMemoryContext {
  readonly memory: StudentMemory
  readonly direct: boolean
  readonly score: {
    readonly semantic: number
    readonly keyword: number
    readonly importance: number
    readonly confidence: number
    readonly recency: number
    readonly total: number
  }
}

/** Context assembled before a Main Agent turn; raw service implementations stay outside core. */
export interface StudentContext {
  readonly memories: readonly StudentMemoryContext[]
}

/** Input accepted by the product-owned Student Context seam. */
export interface StudentContextBuildInput {
  readonly query: string
  readonly courseContext?: CourseContext
}

/** Builds stable context without coupling StudyController to MemoryService. */
export interface StudentContextBuilder {
  build(input: StudentContextBuildInput): Promise<StudentContext>
}

/** Safe completed-turn projection supplied to the post-turn Memory formation seam. */
export interface StudyPostTurnObservation {
  readonly userMessage: string
  readonly assistantResponse: string
  readonly sourceSessionId: string
  readonly sourceTurnId: string
  readonly runId: string
  readonly conversationId: string
  readonly turnId: string
  readonly course?: string
  readonly topic?: string
  readonly week?: number
}

/** Structural capability used by StudyController without importing MemoryService. */
export interface StudyPostTurnObserver {
  observe(input: StudyPostTurnObservation): Promise<readonly unknown[] | void>
}

/** Resource read capability exposed to the Main Agent tool bridge. */
export interface StudyResourceReader {
  readText(resourceId: string): Promise<ResourceText>
}

/** Memory recall capability exposed to the Main Agent tool bridge. */
export interface StudyMemoryReader {
  recall(input: {
    readonly query: string
    readonly course?: string
    readonly topic?: string
    readonly limit?: number
    readonly globalLimit?: number
  }): Promise<readonly StudentMemoryContext[]>
}

export type StudyMemoryDeleteIntent = 'explicit_user_forget'

/** Structural form of the existing MemoryCandidate contract used by manage_memory. */
export interface StudyMemoryManagementCommand {
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
  readonly deleteIntent?: StudyMemoryDeleteIntent
}

/** Memory mutation capability exposed to the Main Agent tool bridge. */
export interface StudyMemoryManager {
  manage(command: StudyMemoryManagementCommand): Promise<MemoryWriteResult>
}

/** Product capabilities exposed through the Main Agent tool bridge. */
export interface StudyAgentToolServices {
  readonly knowledgeService?: {
    search(input: {
      readonly query: string
      readonly course?: string
      readonly week?: number
      readonly limit?: number
    }): Promise<readonly Evidence[]>
  }
  readonly resourceReader?: StudyResourceReader
  readonly memoryReader?: StudyMemoryReader
  readonly memoryManager?: StudyMemoryManager
}

/** Minimal lifecycle events emitted by a Study Agent run. */
export type AgentEventType =
  | 'run_started'
  | 'model_started'
  | 'model_completed'
  | 'answer_completed'
  | 'memory_observation_started'
  | 'memory_observation_completed'
  | 'memory_observation_failed'
  | 'subagent_started'
  | 'subagent_completed'
  | 'subagent_failed'
  | 'run_completed'
  | 'run_failed'

export type AgentEventErrorCode = StudyRuntimeErrorCode | 'MEMORY_OBSERVATION_FAILED' | 'SUBAGENT_FAILED'

/** Product-owned event shape; raw prompts, responses, and secrets are intentionally absent. */
export interface AgentEvent {
  readonly runId: string
  readonly timestamp: string
  readonly type: AgentEventType
  readonly sessionId?: string
  readonly conversationId?: string
  readonly turnId?: string
  readonly modelProfile?: ModelProfile
  readonly resultCount?: number
  readonly evidenceCount?: number
  readonly subagentName?: string
  readonly taskId?: string
  readonly errorCode?: AgentEventErrorCode
}

/** Small observation seam for UI, tests, and later tracing integrations. */
export interface AgentEventSink {
  emit(event: AgentEvent): void | Promise<void>
}

/** Default event sink for normal runs that do not need an observer. */
export class NoopAgentEventSink implements AgentEventSink {
  emit(_event: AgentEvent): void {}
}

/** Test-friendly event sink that records only the safe event metadata. */
export class InMemoryAgentEventSink implements AgentEventSink {
  readonly events: AgentEvent[] = []

  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

/** Stable runtime failure categories exposed above the Harness adapter. */
export type StudyRuntimeErrorCode =
  | 'INVALID_INPUT'
  | 'SESSION_ERROR'
  | 'MODEL_ERROR'
  | 'HARNESS_ERROR'
  | 'ABORTED'
  | 'UNKNOWN'

/** Domain error boundary for provider and Harness failures. */
export class StudyRuntimeError extends Error {
  readonly code: StudyRuntimeErrorCode

  constructor(code: StudyRuntimeErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = 'StudyRuntimeError'
    this.code = code
  }
}

/** Optional controls for one runtime call. runId is supplied by StudyController. */
export interface StudyTurnOptions {
  readonly eventSink?: AgentEventSink
  readonly signal?: AbortSignal
  readonly modelProfile?: ModelProfile
  readonly runId?: string
}

/** Stable result DTO; Harness internals are adapted before reaching this type. */
export interface StudyTurnResult {
  readonly runId: string
  readonly answer: string
  readonly conversation: StudyConversationRef
  readonly turnId: string
  readonly modelProfile: ModelProfile
  readonly promptVersion: string
  readonly evidence: readonly Evidence[]
  readonly toolsUsed: readonly string[]
  readonly subagentsUsed: readonly string[]
  /** Safe count of Knowledge/Resource retrieval actions in this StudyRun. */
  readonly researchActions: number
}

/** Runtime abstraction consumed by StudyController. */
export interface StudyAgentRuntime {
  runTurn(input: StudyTurnInput, options?: StudyTurnOptions): Promise<StudyTurnResult>
}

/** Logical model selection policy; Round 1 uses the default profile without a classifier call. */
export interface ModelPolicy {
  selectModel(task: ModelTask): ModelProfile
}

/** Round 1 policy: every Main Agent turn uses the fast logical profile. */
export class DefaultModelPolicy implements ModelPolicy {
  selectModel(task: ModelTask): ModelProfile {
    if (task === 'main_agent') return 'fast'
    if (task === 'research_agent') return 'strong'
    throw new Error(`Unsupported model task: ${task}`)
  }
}

/** Convert an arbitrary failure to the stable runtime error boundary. */
export function toStudyRuntimeError(error: unknown, fallbackCode: StudyRuntimeErrorCode = 'UNKNOWN'): StudyRuntimeError {
  if (error instanceof StudyRuntimeError) return error
  return new StudyRuntimeError(fallbackCode, runtimeErrorMessage(fallbackCode), { cause: error })
}

function runtimeErrorMessage(code: StudyRuntimeErrorCode): string {
  switch (code) {
    case 'INVALID_INPUT': return 'Study Agent input is invalid.'
    case 'SESSION_ERROR': return 'The Study Agent conversation could not be opened or continued.'
    case 'MODEL_ERROR': return 'The Study Agent model did not return a usable answer.'
    case 'HARNESS_ERROR': return 'DeepSeek Harness could not complete the Study Agent turn.'
    case 'ABORTED': return 'The Study Agent turn was aborted.'
    case 'UNKNOWN': return 'The Study Agent runtime failed unexpectedly.'
  }
}
