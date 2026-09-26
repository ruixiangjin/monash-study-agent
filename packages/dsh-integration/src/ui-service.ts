import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { loadRuntimeConfig } from '@monash-study/knowledge-service'
import {
  createStudyApplication,
  type StudyApplication,
} from '@monash-study/study-application'
import {
  toStudyRuntimeError,
  type AgentEvent,
  StudyRuntimeError,
} from '@monash-study/study-core'
import type { ResourceManifest } from '@monash-study/shared-types'
import type {
  CourseConversationHistory,
  CourseConversationSummary,
  CourseSummary,
  MonashStudyTurnRequest,
  MonashStudyTurnResponse,
} from './ui-contract.js'
import { InProcessDshRuntime } from './in-process-dsh-runtime.js'
import {
  courseCodeFromSessionEvents,
  courseCodeFromSessionId,
  createCourseSessionId,
  projectCourseConversationMessages,
  titleFromSessionEvents,
} from './session-conversations.js'

const PRESET = 'monash-study-agent'

/** Configuration supplied by the DSH profile for the UI integration. */
export interface MonashStudyUiConfig {
  readonly applicationRoot?: string
  readonly runtimeConfigPath?: string
  readonly resourceManifestPath?: string
}

/** High-level UI boundary; DSH-specific transport stays outside StudyApplication. */
export class MonashStudyUiService extends TypertRemoteService {
  static inject = ['monashStudyRuntime', 'sessionController']

  private readonly application: LazyStudyApplication
  private readonly manifestPath: string
  private readonly runtimeConfigPath: string | undefined
  private readonly applicationRoot: string
  private readonly sessionController: SessionController
  private readonly events = new Map<string, RunEventQueue>()

  constructor(ctx: Context, config: MonashStudyUiConfig = {}) {
    super(ctx, 'monashStudyUi', { namespace: 'monashStudy' })
    this.runtimeConfigPath = config.runtimeConfigPath
    this.applicationRoot = config.applicationRoot ?? process.env.MONASH_STUDY_AGENT_ROOT
      ?? applicationRootFromEnvironment()
    this.sessionController = ctx.sessionController
    const runtimeConfig = loadRuntimeConfig({
      ...(config.applicationRoot === undefined ? {} : { applicationRoot: config.applicationRoot }),
      ...(config.runtimeConfigPath === undefined ? {} : { configPath: config.runtimeConfigPath }),
      ...(config.resourceManifestPath === undefined ? {} : { resourceManifestPath: config.resourceManifestPath }),
    })
    this.manifestPath = config.resourceManifestPath
      ?? runtimeConfig.resourceManifestPath
    this.application = new LazyStudyApplication(() => createStudyApplication({
      runtimeConfig,
      resourceManifestPath: this.manifestPath,
      runtimeFactory: toolServices => ctx.root.monashStudyRuntime.configure(toolServices),
    }))
    ctx.effect(() => () => this.close(), 'monash-study-ui: StudyApplication lifecycle')
  }

  /** Execute one stable StudyApplication turn and return a safe UI projection. */
  @Remote
  async runTurn(request: MonashStudyTurnRequest, signal: AbortSignal): Promise<MonashStudyTurnResponse> {
    const queue = this.queue(request.runId)
    try {
      signal.throwIfAborted()
      const courseCodes = (await this.listCourses(signal)).map(course => course.courseCode)
      if (!courseCodes.includes(request.courseCode)) {
        throw new StudyRuntimeError('INVALID_INPUT', 'Select a course available in the current study library.')
      }
      let conversation = request.conversation
      if (conversation === undefined) {
        const sessionId = await this.createDshConversation(request.courseCode)
        conversation = { sessionId, conversationId: sessionId }
      }
      const ownerCourse = await this.courseForSession(conversation.sessionId, courseCodes, signal)
      if (ownerCourse !== request.courseCode) {
        throw new StudyRuntimeError('SESSION_ERROR', 'This conversation belongs to a different course.')
      }
      const application = await this.application.get()
      const result = await application.runTurn({
        query: request.query,
        courseContext: { courseCode: request.courseCode },
        conversation,
      }, {
        runId: request.runId,
        signal,
        eventSink: { emit: (event: AgentEvent) => { queue.push(event) } },
      })
      return { status: 'completed', result }
    } catch (error) {
      console.error('monash-study-ui StudyApplication turn failed', error)
      const runtimeError = toStudyRuntimeError(error, 'UNKNOWN')
      return { status: 'failed', errorCode: runtimeError.code, message: safeMessage(runtimeError) }
    } finally {
      queue.complete()
      this.scheduleCleanup(request.runId, queue)
    }
  }

  /** Ensure restored DSH Agent tool calls have the same product services as UI turns. */
  async ensureApplication(): Promise<void> {
    await this.application.get()
  }

  /** List course summaries derived from the existing Resource Manifest. */
  @Remote
  async listCourses(signal: AbortSignal): Promise<readonly CourseSummary[]> {
    signal.throwIfAborted()
    const manifest = JSON.parse(await readFile(this.manifestPath, 'utf8')) as ResourceManifest
    return Object.entries(manifest.statistics.byCourse)
      .filter(([courseCode]) => courseCode.trim().length > 0)
      .map(([courseCode, resourceCount]) => ({ courseCode, resourceCount }))
      .sort((left, right) => left.courseCode.localeCompare(right.courseCode))
  }

  /** Create the authoritative DSH Session and namespace its id by course. */
  @Remote
  async createConversation(courseCode: string, signal: AbortSignal): Promise<CourseConversationSummary> {
    signal.throwIfAborted()
    const courseCodes = (await this.listCourses(signal)).map(course => course.courseCode)
    if (!courseCodes.includes(courseCode)) {
      throw new StudyRuntimeError('INVALID_INPUT', 'Select a course available in the current study library.')
    }
    const sessionId = await this.createDshConversation(courseCode)
    return { sessionId, title: 'New Chat', updatedAt: Date.now() }
  }

  /** List this course's Sessions from DSH's own Session index and history. */
  @Remote
  async listCourseConversations(courseCode: string, signal: AbortSignal): Promise<readonly CourseConversationSummary[]> {
    signal.throwIfAborted()
    const courseCodes = (await this.listCourses(signal)).map(course => course.courseCode)
    if (!courseCodes.includes(courseCode)) {
      throw new StudyRuntimeError('INVALID_INPUT', 'Select a course available in the current study library.')
    }
    const { items } = await this.sessionController.list({}, signal)
    const conversations: CourseConversationSummary[] = []
    for (const item of items) {
      signal.throwIfAborted()
      if (item.origin === 'subagent') continue
      const idCourse = courseCodeFromSessionId(item.sessionId, courseCodes)
      let history: Awaited<ReturnType<SessionController['inspect']>> | undefined
      let ownerCourse = idCourse
      if (ownerCourse === undefined) {
        if (item.projections?.values['agentPreset'] !== PRESET) continue
        history = await this.sessionController.inspect(SessionId(item.sessionId), signal)
        if (activePreset(history.meta.agentPreset, history.events) !== PRESET) continue
        ownerCourse = courseCodeFromSessionEvents(history.events, courseCodes)
      }
      if (ownerCourse !== courseCode) continue
      const projectedTitle = item.projections?.values['title']
      if (history === undefined && typeof projectedTitle !== 'string' && !item.blank) {
        history = await this.sessionController.inspect(SessionId(item.sessionId), signal)
      }
      const title = typeof projectedTitle === 'string' && projectedTitle.trim().length > 0
        ? projectedTitle
        : history === undefined ? undefined : titleFromSessionEvents(history.events)
      conversations.push({
        sessionId: item.sessionId,
        title: title ?? (item.blank ? 'New Chat' : 'Course conversation'),
        updatedAt: item.updatedAt,
      })
    }
    return conversations.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /** Rehydrate the visible messages from the DSH Session Store. */
  @Remote
  async loadConversation(courseCode: string, sessionId: string, signal: AbortSignal): Promise<CourseConversationHistory> {
    signal.throwIfAborted()
    const courseCodes = (await this.listCourses(signal)).map(course => course.courseCode)
    if (!courseCodes.includes(courseCode)) {
      throw new StudyRuntimeError('INVALID_INPUT', 'Select a course available in the current study library.')
    }
    const history = await this.sessionController.inspect(SessionId(sessionId), signal)
    if (activePreset(history.meta.agentPreset, history.events) !== PRESET
      || await this.courseForSession(sessionId, courseCodes, signal, history.events, history.meta.agentPreset) !== courseCode) {
      throw new StudyRuntimeError('SESSION_ERROR', 'This conversation belongs to a different course or is unavailable.')
    }
    const lastEventAt = history.events.at(-1)?.time ?? history.meta.createdAt
    return {
      conversation: { sessionId, conversationId: sessionId },
      title: titleFromSessionEvents(history.events) ?? 'New Chat',
      updatedAt: lastEventAt,
      messages: projectCourseConversationMessages(sessionId, history.events),
    }
  }

  /** Stream one run's safe AgentEvent values over DSH's native Remote transport. */
  @Remote({ mode: 'stream' })
  async *runEvents(runId: string, signal: AbortSignal): AsyncIterable<AgentEvent> {
    yield* this.queue(runId).iterate(signal)
  }

  /** Dispose the shared Application if a turn caused it to be created. */
  close(): Promise<void> {
    return this.application.close()
  }

  private async createDshConversation(courseCode: string): Promise<string> {
    const sessionId = createCourseSessionId(courseCode, randomUUID())
    const created = await this.sessionController.create({
      sessionId: SessionId(sessionId),
      cwd: this.applicationRoot,
      agentPreset: PRESET,
    })
    return created.sessionId
  }

  private async courseForSession(
    sessionId: string,
    courseCodes: readonly string[],
    signal: AbortSignal,
    knownEvents?: readonly unknown[],
    initialPreset?: string,
  ): Promise<string | undefined> {
    const idCourse = courseCodeFromSessionId(sessionId, courseCodes)
    if (idCourse !== undefined) return idCourse
    const history = knownEvents === undefined
      ? await this.sessionController.inspect(SessionId(sessionId), signal)
      : undefined
    const events = knownEvents ?? history?.events ?? []
    const preset = activePreset(initialPreset ?? history?.meta.agentPreset, events)
    return preset === PRESET ? courseCodeFromSessionEvents(events, courseCodes) : undefined
  }

  private queue(runId: string): RunEventQueue {
    const existing = this.events.get(runId)
    if (existing !== undefined) return existing
    const queue = new RunEventQueue()
    this.events.set(runId, queue)
    return queue
  }

  private scheduleCleanup(runId: string, queue: RunEventQueue): void {
    const timer = setTimeout(() => {
      if (this.events.get(runId) === queue) this.events.delete(runId)
    }, 60_000)
    timer.unref?.()
  }
}

function applicationRootFromEnvironment(): string {
  const applicationRoot = process.env.MONASH_STUDY_AGENT_ROOT
  if (applicationRoot === undefined) throw new Error('Monash Study UI requires an explicit application root')
  return applicationRoot
}

function activePreset(initialPreset: string | undefined, events: readonly unknown[]): string | undefined {
  let preset = initialPreset
  for (const event of events) {
    if (!isRecord(event) || event['type'] !== 'agent-preset/selected' || !isRecord(event['data'])) continue
    if (typeof event['data']['agentPreset'] === 'string') preset = event['data']['agentPreset']
  }
  return preset
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** One shared, lazily-created Application with an idempotent lifecycle. */
export class LazyStudyApplication {
  #applicationPromise: Promise<StudyApplication> | undefined
  #closePromise: Promise<void> | undefined
  #closed = false

  constructor(readonly create: () => Promise<StudyApplication>) {}

  get(): Promise<StudyApplication> {
    if (this.#closed) return Promise.reject(new Error('Monash Study UI service is closed.'))
    this.#applicationPromise ??= this.create()
    return this.#applicationPromise
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closed = true
    const applicationPromise = this.#applicationPromise
    this.#closePromise = applicationPromise === undefined
      ? Promise.resolve()
      : applicationPromise.then(application => application.close(), () => undefined)
    return this.#closePromise
  }
}

class RunEventQueue {
  readonly #buffer: AgentEvent[] = []
  readonly #waiters = new Set<() => void>()
  #completed = false

  push(event: AgentEvent): void {
    if (this.#completed) return
    this.#buffer.push(event)
    for (const wake of this.#waiters) wake()
    this.#waiters.clear()
  }

  complete(): void {
    this.#completed = true
    for (const wake of this.#waiters) wake()
    this.#waiters.clear()
  }

  async *iterate(signal: AbortSignal): AsyncIterable<AgentEvent> {
    const onAbort = (): void => {
      this.#completed = true
      for (const wake of this.#waiters) wake()
      this.#waiters.clear()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (this.#buffer.length > 0 || !this.#completed) {
        signal.throwIfAborted()
        while (this.#buffer.length > 0) {
          yield this.#buffer.shift() as AgentEvent
        }
        if (this.#completed) break
        await new Promise<void>(resolveWaiter => this.#waiters.add(resolveWaiter))
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function safeMessage(error: Error): string {
  return error.message.length > 240 ? `${error.message.slice(0, 237)}...` : error.message
}
