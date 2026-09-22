import { randomUUID } from 'node:crypto'
import type { CourseContext } from '@monash-study/study-core'
import {
  DefaultModelPolicy,
  NoopAgentEventSink,
  StudyRuntimeError,
  toStudyRuntimeError,
  type AgentEvent,
  type AgentEventSink,
  type ModelPolicy,
  type StudyAgentRuntime,
  type StudentContextBuilder,
  type StudyTurnInput,
  type StudyTurnOptions,
  type StudyTurnResult,
} from '@monash-study/study-core'
import type {
  KnowledgeService,
  StudyDecisionService,
  StudyModelService,
  StudyTool,
} from '@monash-study/study-core'

/** Replaceable services coordinated by the future StudyController workflow. */
export interface StudyControllerDependencies {
  readonly decision: StudyDecisionService
  readonly knowledge: KnowledgeService
  readonly model: StudyModelService
  readonly tools: ReadonlyMap<string, StudyTool>
}

export interface StudyControllerOptions {
  readonly eventSink?: AgentEventSink
  readonly runIdFactory?: () => string
  readonly studentContextBuilder?: StudentContextBuilder
}

/** Thin product orchestration boundary over a provider-neutral StudyAgentRuntime. */
export class StudyController {
  private readonly eventSink: AgentEventSink
  private readonly runIdFactory: () => string
  private readonly studentContextBuilder: StudentContextBuilder | undefined

  constructor(
    private readonly runtime: StudyAgentRuntime,
    private readonly modelPolicy: ModelPolicy = new DefaultModelPolicy(),
    options: StudyControllerOptions = {},
  ) {
    this.eventSink = options.eventSink ?? new NoopAgentEventSink()
    this.runIdFactory = options.runIdFactory ?? randomUUID
    this.studentContextBuilder = options.studentContextBuilder
  }

  async runTurn(input: StudyTurnInput, options: StudyTurnOptions = {}): Promise<StudyTurnResult> {
    const runId = options.runId ?? this.runIdFactory()
    const eventSink = options.eventSink ?? this.eventSink
    await emit(eventSink, event(runId, 'run_started'))

    try {
      const normalizedInput = validateStudyTurnInput(input)
      const modelProfile = this.modelPolicy.selectModel('main_agent')
      const studentContext = normalizedInput.studentContext
        ?? await this.studentContextBuilder?.build({
          query: normalizedInput.query,
          ...(normalizedInput.courseContext === undefined ? {} : { courseContext: normalizedInput.courseContext }),
        })
      const runtimeInput = studentContext === undefined
        ? normalizedInput
        : { ...normalizedInput, studentContext }
      const result = await this.runtime.runTurn(runtimeInput, {
        ...options,
        runId,
        modelProfile,
        eventSink,
      })
      const completed = {
        ...result,
        runId,
        modelProfile,
        evidence: result.evidence ?? [],
        toolsUsed: result.toolsUsed ?? [],
      }
      await emit(eventSink, event(runId, 'run_completed', {
        modelProfile,
        sessionId: result.conversation.sessionId,
        conversationId: result.conversation.conversationId,
        turnId: result.turnId,
      }))
      return completed
    } catch (error) {
      const runtimeError = error instanceof StudyRuntimeError
        ? error
        : toStudyRuntimeError(error, 'UNKNOWN')
      await emit(eventSink, event(runId, 'run_failed', { errorCode: runtimeError.code }))
      throw runtimeError
    }
  }
}

function validateStudyTurnInput(input: StudyTurnInput): StudyTurnInput {
  if (input.query.trim().length === 0) {
    throw new StudyRuntimeError('INVALID_INPUT', 'Study Agent query must not be empty.')
  }
  if (input.courseContext !== undefined) validateCourseContext(input.courseContext)
  return {
    ...input,
    query: input.query.trim(),
  }
}

function validateCourseContext(courseContext: CourseContext): void {
  if (courseContext.courseCode.trim().length === 0) {
    throw new StudyRuntimeError('INVALID_INPUT', 'Course context requires a courseCode.')
  }
  if (courseContext.week !== undefined && (!Number.isInteger(courseContext.week) || courseContext.week < 0)) {
    throw new StudyRuntimeError('INVALID_INPUT', 'Course context week must be a non-negative integer.')
  }
  if (courseContext.topic !== undefined && courseContext.topic.trim().length === 0) {
    throw new StudyRuntimeError('INVALID_INPUT', 'Course context topic must not be empty when provided.')
  }
}

function event(
  runId: string,
  type: AgentEvent['type'],
  details: Partial<Pick<AgentEvent, 'sessionId' | 'conversationId' | 'turnId' | 'modelProfile' | 'errorCode'>> = {},
): AgentEvent {
  return {
    runId,
    timestamp: new Date().toISOString(),
    type,
    ...details,
  }
}

async function emit(sink: AgentEventSink, value: AgentEvent): Promise<void> {
  await sink.emit(value)
}
