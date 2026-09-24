import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { Evidence } from '@monash-study/shared-types'
import type {
  StudyAgentToolServices,
  StudyMemoryManagementCommand,
  StudyTurnInput,
  StudentMemoryContext,
} from '@monash-study/study-core'
import { RESEARCH_SUBAGENT_ACTION_BUDGET } from '@monash-study/study-core'
import { StudyRuntimeError } from '@monash-study/study-core'

export interface StudyToolBridgeOptions {
  readonly services: StudyAgentToolServices
  readonly host?: string
  /** Shared per-StudyRun cap for Knowledge retrieval actions, including child research. */
  readonly maxResearchActions?: number
}

export interface StudyToolRunSnapshot {
  readonly evidence: readonly Evidence[]
  readonly toolsUsed: readonly string[]
  readonly researchActions: number
}

interface ActiveRun {
  readonly runId: string
  readonly input: StudyTurnInput
  readonly evidence: Map<string, Evidence>
  readonly toolsUsed: Set<string>
  researchActions: number
}

interface ToolRequest {
  readonly name: string
  readonly arguments?: unknown
}

/** Local authenticated bridge that keeps product services in the parent process. */
export class StudyToolBridge {
  readonly #services: StudyAgentToolServices
  readonly #host: string
  readonly #maxResearchActions: number
  #server: Server | undefined
  #url: string | undefined
  #token: string | undefined
  #active: ActiveRun | undefined

  constructor(options: StudyToolBridgeOptions) {
    this.#services = options.services
    this.#host = options.host ?? '127.0.0.1'
    this.#maxResearchActions = options.maxResearchActions ?? RESEARCH_SUBAGENT_ACTION_BUDGET
  }

  async start(): Promise<{ readonly url: string; readonly token: string }> {
    if (this.#server !== undefined && this.#url !== undefined && this.#token !== undefined) {
      return { url: this.#url, token: this.#token }
    }
    this.#token = cryptoRandomToken()
    this.#server = createServer((request, response) => {
      void this.#handle(request, response)
    })
    await new Promise<void>((resolvePromise, reject) => {
      const server = this.#server
      if (server === undefined) return reject(new Error('Study tool bridge server was not created'))
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolvePromise()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, this.#host)
    })
    const address = this.#server.address()
    if (address === null || typeof address === 'string') throw new Error('Study tool bridge did not receive a TCP address')
    this.#url = `http://${this.#host}:${address.port}/tool`
    return { url: this.#url, token: this.#token }
  }

  begin(runId: string, input: StudyTurnInput): void {
    if (this.#active !== undefined) {
      throw new StudyRuntimeError('CONCURRENT_RUN', 'Another Study Agent turn is already running.')
    }
    this.#active = { runId, input, evidence: new Map(), toolsUsed: new Set(), researchActions: 0 }
  }

  snapshot(runId: string): StudyToolRunSnapshot {
    if (this.#active?.runId !== runId) return { evidence: [], toolsUsed: [], researchActions: 0 }
    return {
      evidence: [...this.#active.evidence.values()],
      toolsUsed: [...this.#active.toolsUsed],
      researchActions: this.#active.researchActions,
    }
  }

  end(runId: string): void {
    if (this.#active?.runId === runId) this.#active = undefined
  }

  /** Execute a tool in-process for the Agent that owns the active Study turn. */
  async executeDirect(name: string, args: unknown): Promise<unknown> {
    const active = this.#active
    if (active === undefined) throw new Error('No active Study Agent turn')
    active.toolsUsed.add(name)
    return this.#execute({
      name,
      ...(args === undefined ? {} : { arguments: args }),
    }, active)
  }

  async close(): Promise<void> {
    this.#active = undefined
    const server = this.#server
    this.#server = undefined
    this.#url = undefined
    this.#token = undefined
    if (server === undefined) return
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error === undefined ? resolvePromise() : reject(error))
    })
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/tool') {
      respond(response, 404, { ok: false, error: { message: 'Not found' } })
      return
    }
    if (request.headers.authorization !== `Bearer ${this.#token ?? ''}`) {
      respond(response, 401, { ok: false, error: { message: 'Unauthorized' } })
      return
    }
    try {
      const body = await readJson(request)
      if (!isRecord(body) || typeof body.name !== 'string') throw new Error('Invalid tool request')
      const active = this.#active
      if (active === undefined) throw new Error('No active Study Agent turn')
      const toolRequest: ToolRequest = {
        name: body.name,
        ...(body.arguments === undefined ? {} : { arguments: body.arguments }),
      }
      active.toolsUsed.add(toolRequest.name)
      const value = await this.#execute(toolRequest, active)
      respond(response, 200, { ok: true, value })
    } catch (error) {
      respond(response, 200, { ok: false, error: { message: safeToolError(error) } })
    }
  }

  async #execute(request: ToolRequest, active: ActiveRun): Promise<unknown> {
    const args = isRecord(request.arguments) ? request.arguments : {}
    switch (request.name) {
      case 'search_knowledge': {
        if (this.#services.knowledgeService === undefined) throw new Error('Knowledge search is unavailable')
        consumeResearchAction(active, this.#maxResearchActions)
        const query = requiredString(args, 'query')
        const course = optionalString(args, 'course') ?? active.input.courseContext?.courseCode
        if (course === undefined) throw new Error('search_knowledge requires a course')
        const week = optionalInteger(args, 'week')
        const limit = optionalInteger(args, 'limit')
        let evidence: readonly Evidence[]
        try {
          evidence = await this.#services.knowledgeService.search({
            query,
            course,
            ...(week === undefined ? {} : { week }),
            ...(limit === undefined ? {} : { limit }),
          })
        } catch {
          throw new Error('Knowledge search failed')
        }
        for (const item of evidence) active.evidence.set(item.evidenceId, item)
        return {
          course,
          query,
          evidence: evidence.map(toModelFacingEvidence),
          evidenceCount: evidence.length,
        }
      }
      case 'get_resource': {
        if (this.#services.resourceReader === undefined) throw new Error('Resource reading is unavailable')
        consumeResearchAction(active, this.#maxResearchActions)
        const resourceId = requiredString(args, 'resourceId')
        try {
          return toModelFacingResourceText(await this.#services.resourceReader.readText(resourceId))
        } catch {
          throw new Error('Resource read failed')
        }
      }
      case 'recall_memory': {
        if (this.#services.memoryReader === undefined) throw new Error('Memory recall is unavailable')
        const query = requiredString(args, 'query')
        const course = optionalString(args, 'course') ?? active.input.courseContext?.courseCode
        const topic = optionalString(args, 'topic')
        const limit = optionalInteger(args, 'limit')
        const globalLimit = optionalInteger(args, 'globalLimit')
        let memories: readonly StudentMemoryContext[]
        try {
          memories = await this.#services.memoryReader.recall({
            query,
            ...(course === undefined ? {} : { course }),
            ...(topic === undefined ? {} : { topic }),
            ...(limit === undefined ? {} : { limit }),
            ...(globalLimit === undefined ? {} : { globalLimit }),
          })
        } catch {
          throw new Error('Memory recall failed')
        }
        return { query, memories: memories.map(toMemoryToolValue) }
      }
      case 'manage_memory': {
        if (this.#services.memoryManager === undefined) throw new Error('Memory management is unavailable')
        const command = memoryManagementCommand(args, active)
        try {
          const result = await this.#services.memoryManager.manage(command)
          return {
            operation: result.operation,
            memoryId: result.memory?.memoryId ?? command.targetMemoryId ?? null,
            memoryKey: result.memory?.memoryKey ?? command.memoryKey ?? null,
            status: result.memory?.status ?? (result.operation === 'DELETE' ? 'deleted' : null),
            kind: result.memory?.kind ?? command.kind ?? null,
            scope: result.memory?.scope ?? command.scope ?? null,
          }
        } catch {
          throw new Error('Memory management failed')
        }
      }
      default:
        throw new Error(`Unknown Study Agent tool: ${request.name}`)
    }
  }
}

function consumeResearchAction(active: ActiveRun, maximum: number): void {
  if (active.researchActions >= maximum) {
    throw new Error('Research retrieval action budget exhausted')
  }
  active.researchActions += 1
}

function memoryManagementCommand(
  args: Record<string, unknown>,
  active: ActiveRun,
): StudyMemoryManagementCommand {
  const operation = requiredEnum(args, 'operation', ['ADD', 'UPDATE', 'RESOLVE', 'ARCHIVE', 'DELETE'] as const)
  const sourceType = requiredEnum(args, 'sourceType', [
    'user_explicit', 'system_observed', 'derived', 'agent_inferred',
  ] as const)
  const memoryKey = optionalString(args, 'memoryKey')
  const targetMemoryId = optionalString(args, 'targetMemoryId')
  const common = {
    operation,
    sourceType,
    ...(memoryKey === undefined ? {} : { memoryKey }),
    ...(targetMemoryId === undefined ? {} : { targetMemoryId }),
    ...(active.input.conversation?.sessionId === undefined
      ? {}
      : { sourceSessionId: active.input.conversation.sessionId }),
    sourceTurnId: active.runId,
  } as const

  if (operation === 'ADD' || operation === 'UPDATE') {
    const kind = requiredEnum(args, 'kind', [
      'preference', 'study_progress', 'weakness', 'learning_episode', 'study_strategy',
    ] as const)
    const scope = requiredEnum(args, 'scope', ['global', 'course', 'topic'] as const)
    const content = requiredString(args, 'content')
    const importance = requiredUnitNumber(args, 'importance')
    const confidence = requiredUnitNumber(args, 'confidence')
    if (kind === 'learning_episode' && memoryKey !== undefined) {
      throw new Error('Learning episode management cannot include memoryKey')
    }
    if (kind !== 'learning_episode' && memoryKey === undefined) {
      throw new Error('Canonical Memory management requires memoryKey')
    }
    const course = scope === 'global'
      ? undefined
      : optionalString(args, 'course') ?? active.input.courseContext?.courseCode
    const topic = scope === 'topic'
      ? optionalString(args, 'topic') ?? active.input.courseContext?.topic
      : undefined
    return {
      ...common,
      kind,
      scope,
      content,
      importance,
      confidence,
      ...(course === undefined ? {} : { course }),
      ...(topic === undefined ? {} : { topic }),
    }
  }

  if (targetMemoryId === undefined && memoryKey === undefined) {
    throw new Error(`${operation} requires targetMemoryId or memoryKey`)
  }
  if (operation === 'DELETE') {
    if (sourceType !== 'user_explicit' || args.deleteIntent !== 'explicit_user_forget') {
      throw new Error('DELETE requires explicit user forget intent')
    }
    return { ...common, deleteIntent: 'explicit_user_forget' }
  }
  return common
}

function toMemoryToolValue(context: StudentMemoryContext): unknown {
  const memory = context.memory
  return {
    memory: {
      memoryId: memory.memoryId,
      memoryKey: memory.memoryKey,
      kind: memory.kind,
      scope: memory.scope,
      course: memory.course,
      topic: memory.topic,
      content: memory.content,
      status: memory.status,
      importance: memory.importance,
      confidence: memory.confidence,
      sourceType: memory.sourceType,
    },
    direct: context.direct,
    score: context.score,
  }
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key)
  if (value === undefined) throw new Error(`${key} must be a non-empty string`)
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function requiredUnitNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${key} must be a number between 0 and 1`)
  }
  return value
}

function requiredEnum<const T extends readonly string[]>(
  args: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] {
  const value = args[key]
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${key} must be one of: ${allowed.join(', ')}`)
  }
  return value
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > 1_000_000) throw new Error('Tool request is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.setHeader('content-length', Buffer.byteLength(payload))
  response.end(payload)
}

function safeToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Study Agent tool failed'
  return /api[_-]?key|token|\.env|sqlite|stack|\/Users\/|\/private\/|\/tmp\//i.test(message)
    ? 'Study Agent tool failed'
    : message
}

function toModelFacingEvidence(evidence: Evidence): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  const sourceMetadata = evidence.metadata
  for (const key of ['week', 'resourceSource', 'contentType', 'lightragChunkId', 'lightragReferenceId']) {
    const value = sourceMetadata[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      metadata[key] = value
    }
  }
  const locator = toModelFacingLocator(sourceMetadata.locator)
  if (locator !== undefined) metadata.locator = locator
  return {
    evidenceId: evidence.evidenceId,
    ...(evidence.resourceId === undefined ? {} : { resourceId: evidence.resourceId }),
    ...(evidence.course === undefined ? {} : { course: evidence.course }),
    title: evidence.title,
    content: evidence.content,
    sourceSystem: evidence.sourceSystem,
    retrievalProvider: evidence.retrievalProvider,
    ...(evidence.score === undefined ? {} : { score: evidence.score }),
    metadata,
  }
}

function toModelFacingResourceText(resourceText: {
  readonly resource: {
    readonly resourceId: string
    readonly course: string | null
    readonly week: number | null
    readonly title: string
    readonly source: string
    readonly resourceType: string
    readonly fileType: string
    readonly extension: string | null
    readonly relativePath: string
  }
  readonly content: string
}): Record<string, unknown> {
  return {
    resource: {
      resourceId: resourceText.resource.resourceId,
      course: resourceText.resource.course,
      week: resourceText.resource.week,
      title: resourceText.resource.title,
      source: resourceText.resource.source,
      resourceType: resourceText.resource.resourceType,
      fileType: resourceText.resource.fileType,
      extension: resourceText.resource.extension,
      relativePath: resourceText.resource.relativePath,
    },
    content: resourceText.content,
  }
}

function toModelFacingLocator(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const locator: Record<string, unknown> = {}
  for (const key of ['kind', 'sourceUrl', 'threadId', 'threadNumber']) {
    const item = value[key]
    if (typeof item === 'string' || typeof item === 'number') locator[key] = item
  }
  for (const key of ['pageNumbers']) {
    const item = value[key]
    if (Array.isArray(item) && item.every((page) => typeof page === 'number')) locator[key] = item
  }
  const regions = value.regions
  if (Array.isArray(regions)) {
    locator.regions = regions.flatMap((region) => {
      if (!isRecord(region) || typeof region.page !== 'number') return []
      return [{
        page: region.page,
        ...(typeof region.reference === 'string' ? { reference: region.reference } : {}),
      }]
    })
  }
  return Object.keys(locator).length === 0 ? undefined : locator
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cryptoRandomToken(): string {
  return randomUUID()
}
