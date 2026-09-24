import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { loadRuntimeConfig } from '@monash-study/knowledge-service'
import {
  createStudyApplication,
  type StudyApplication,
} from '@monash-study/study-application'
import {
  toStudyRuntimeError,
  type AgentEvent,
} from '@monash-study/study-core'
import type { ResourceManifest } from '@monash-study/shared-types'
import type {
  CourseSummary,
  MonashStudyTurnRequest,
  MonashStudyTurnResponse,
} from './ui-contract.js'

/** Configuration supplied by the DSH profile for the UI integration. */
export interface MonashStudyUiConfig {
  readonly runtimeConfigPath?: string
  readonly resourceManifestPath?: string
}

/** High-level UI boundary; DSH-specific transport stays outside StudyApplication. */
export class MonashStudyUiService extends TypertRemoteService {
  static inject: string[] = []

  readonly #applicationPromise: Promise<StudyApplication>
  readonly #manifestPath: string
  readonly #events = new Map<string, RunEventQueue>()

  constructor(ctx: Context, config: MonashStudyUiConfig = {}) {
    super(ctx, 'monashStudyUi', { namespace: 'monashStudy' })
    const runtimeConfig = loadRuntimeConfig(config.runtimeConfigPath)
    this.#manifestPath = config.resourceManifestPath
      ?? resolve(runtimeConfig.repositoryRoot, 'resources/resources.json')
    this.#applicationPromise = createStudyApplication({
      ...(config.runtimeConfigPath === undefined ? {} : { configPath: config.runtimeConfigPath }),
      resourceManifestPath: this.#manifestPath,
    })
    ctx.effect(() => async () => {
      await this.#applicationPromise.then(application => application.close(), () => undefined)
    }, 'monash-study-ui: StudyApplication lifecycle')
  }

  /** Execute one stable StudyApplication turn and return a safe UI projection. */
  @Remote
  async runTurn(request: MonashStudyTurnRequest, signal: AbortSignal): Promise<MonashStudyTurnResponse> {
    const queue = this.#queue(request.runId)
    try {
      const application = await this.#applicationPromise
      const result = await application.runTurn({
        query: request.query,
        courseContext: { courseCode: request.courseCode },
        ...(request.conversation === undefined ? {} : { conversation: request.conversation }),
      }, {
        runId: request.runId,
        signal,
        eventSink: { emit: (event: AgentEvent) => { queue.push(event) } },
      })
      return { status: 'completed', result }
    } catch (error) {
      const runtimeError = toStudyRuntimeError(error, 'UNKNOWN')
      return { status: 'failed', errorCode: runtimeError.code, message: safeMessage(runtimeError) }
    } finally {
      queue.complete()
      this.#scheduleCleanup(request.runId, queue)
    }
  }

  /** List course summaries derived from the existing Resource Manifest. */
  @Remote
  async listCourses(signal: AbortSignal): Promise<readonly CourseSummary[]> {
    signal.throwIfAborted()
    const manifest = JSON.parse(await readFile(this.#manifestPath, 'utf8')) as ResourceManifest
    return Object.entries(manifest.statistics.byCourse)
      .filter(([courseCode]) => courseCode.trim().length > 0)
      .map(([courseCode, resourceCount]) => ({ courseCode, resourceCount }))
      .sort((left, right) => left.courseCode.localeCompare(right.courseCode))
  }

  /** Stream one run's safe AgentEvent values over DSH's native Remote transport. */
  @Remote({ mode: 'stream' })
  async *runEvents(runId: string, signal: AbortSignal): AsyncIterable<AgentEvent> {
    yield* this.#queue(runId).iterate(signal)
  }

  #queue(runId: string): RunEventQueue {
    const existing = this.#events.get(runId)
    if (existing !== undefined) return existing
    const queue = new RunEventQueue()
    this.#events.set(runId, queue)
    return queue
  }

  #scheduleCleanup(runId: string, queue: RunEventQueue): void {
    const timer = setTimeout(() => {
      if (this.#events.get(runId) === queue) this.#events.delete(runId)
    }, 60_000)
    timer.unref?.()
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
