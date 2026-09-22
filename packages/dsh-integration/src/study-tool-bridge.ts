import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { Evidence } from '@monash-study/shared-types'
import type {
  StudyAgentToolServices,
  StudyTurnInput,
  StudentMemoryContext,
} from '@monash-study/study-core'

export interface StudyToolBridgeOptions {
  readonly services: StudyAgentToolServices
  readonly host?: string
}

export interface StudyToolRunSnapshot {
  readonly evidence: readonly Evidence[]
  readonly toolsUsed: readonly string[]
}

interface ActiveRun {
  readonly runId: string
  readonly input: StudyTurnInput
  readonly evidence: Map<string, Evidence>
  readonly toolsUsed: Set<string>
}

interface ToolRequest {
  readonly name: string
  readonly arguments?: unknown
}

/** Local authenticated bridge that keeps product services in the parent process. */
export class StudyToolBridge {
  readonly #services: StudyAgentToolServices
  readonly #host: string
  #server: Server | undefined
  #url: string | undefined
  #token: string | undefined
  #active: ActiveRun | undefined

  constructor(options: StudyToolBridgeOptions) {
    this.#services = options.services
    this.#host = options.host ?? '127.0.0.1'
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
      throw new Error('Study tool bridge does not support concurrent Harness turns')
    }
    this.#active = { runId, input, evidence: new Map(), toolsUsed: new Set() }
  }

  snapshot(runId: string): StudyToolRunSnapshot {
    if (this.#active?.runId !== runId) return { evidence: [], toolsUsed: [] }
    return {
      evidence: [...this.#active.evidence.values()],
      toolsUsed: [...this.#active.toolsUsed],
    }
  }

  end(runId: string): void {
    if (this.#active?.runId === runId) this.#active = undefined
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
        const query = requiredString(args, 'query')
        const course = optionalString(args, 'course') ?? active.input.courseContext?.courseCode
        if (course === undefined) throw new Error('search_knowledge requires a course')
        const week = optionalInteger(args, 'week')
        const limit = optionalInteger(args, 'limit')
        const evidence = await this.#services.knowledgeService.search({
          query,
          course,
          ...(week === undefined ? {} : { week }),
          ...(limit === undefined ? {} : { limit }),
        })
        for (const item of evidence) active.evidence.set(item.evidenceId, item)
        return { course, query, evidence, evidenceCount: evidence.length }
      }
      case 'get_resource': {
        if (this.#services.resourceReader === undefined) throw new Error('Resource reading is unavailable')
        const resourceId = requiredString(args, 'resourceId')
        return await this.#services.resourceReader.readText(resourceId)
      }
      case 'recall_memory': {
        if (this.#services.memoryReader === undefined) throw new Error('Memory recall is unavailable')
        const query = requiredString(args, 'query')
        const course = optionalString(args, 'course') ?? active.input.courseContext?.courseCode
        const topic = optionalString(args, 'topic')
        const limit = optionalInteger(args, 'limit')
        const globalLimit = optionalInteger(args, 'globalLimit')
        const memories = await this.#services.memoryReader.recall({
          query,
          ...(course === undefined ? {} : { course }),
          ...(topic === undefined ? {} : { topic }),
          ...(limit === undefined ? {} : { limit }),
          ...(globalLimit === undefined ? {} : { globalLimit }),
        })
        return { query, memories: memories.map(toMemoryToolValue) }
      }
      default:
        throw new Error(`Unknown Study Agent tool: ${request.name}`)
    }
  }
}

function toMemoryToolValue(context: StudentMemoryContext): unknown {
  return {
    memory: context.memory,
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
  return error instanceof Error ? error.message : 'Study Agent tool failed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cryptoRandomToken(): string {
  return randomUUID()
}
