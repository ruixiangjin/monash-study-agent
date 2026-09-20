import { randomUUID } from 'node:crypto'

export const LIGHTRAG_PROTOCOL_VERSION = 1 as const

export const LIGHTRAG_COMMANDS = [
  'health',
  'model-health',
  'ingest-document',
  'delete-document',
  'sync-course-batch',
  'query-course',
] as const

export type LightRAGWorkerCommand = typeof LIGHTRAG_COMMANDS[number]

export interface LightRAGWorkerRequest {
  readonly protocolVersion: typeof LIGHTRAG_PROTOCOL_VERSION
  readonly requestId: string
  readonly command: LightRAGWorkerCommand
  readonly payload: Readonly<Record<string, unknown>>
}

export interface LightRAGWorkerSuccessResponse {
  readonly protocolVersion: typeof LIGHTRAG_PROTOCOL_VERSION
  readonly requestId: string
  readonly ok: true
  readonly result: unknown
}

export interface LightRAGWorkerErrorResponse {
  readonly protocolVersion: typeof LIGHTRAG_PROTOCOL_VERSION
  readonly requestId: string
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

export type LightRAGWorkerResponse = LightRAGWorkerSuccessResponse | LightRAGWorkerErrorResponse

export class LightRAGProtocolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'LightRAGProtocolError'
    this.code = code
  }
}

export function createWorkerRequest(
  command: LightRAGWorkerCommand,
  payload: Readonly<Record<string, unknown>>,
  requestId: string = randomUUID(),
): LightRAGWorkerRequest {
  const request = { protocolVersion: LIGHTRAG_PROTOCOL_VERSION, requestId, command, payload }
  validateWorkerRequest(request)
  return request
}

export function validateWorkerRequest(value: unknown): asserts value is LightRAGWorkerRequest {
  if (!isRecord(value) || value.protocolVersion !== LIGHTRAG_PROTOCOL_VERSION) {
    throw new LightRAGProtocolError('PROTOCOL_VERSION_UNSUPPORTED', 'Unsupported LightRAG protocol version')
  }
  if (!isNonEmptyString(value.requestId)) {
    throw new LightRAGProtocolError('REQUEST_ID_INVALID', 'requestId must be a non-empty string')
  }
  if (!isCommand(value.command)) {
    throw new LightRAGProtocolError('COMMAND_UNKNOWN', `Unsupported LightRAG command: ${String(value.command)}`)
  }
  if (!isRecord(value.payload)) {
    throw new LightRAGProtocolError('PAYLOAD_INVALID', 'payload must be a JSON object')
  }
}

export function parseWorkerResponse(stdout: string, expectedRequestId: string): LightRAGWorkerResponse {
  let value: unknown
  try {
    value = JSON.parse(stdout) as unknown
  } catch (error) {
    throw new LightRAGProtocolError('RESPONSE_JSON_INVALID', `Worker returned invalid JSON: ${errorMessage(error)}`)
  }
  if (!isRecord(value) || value.protocolVersion !== LIGHTRAG_PROTOCOL_VERSION) {
    throw new LightRAGProtocolError('PROTOCOL_VERSION_UNSUPPORTED', 'Worker returned an unsupported protocol version')
  }
  if (value.requestId !== expectedRequestId) {
    throw new LightRAGProtocolError('REQUEST_ID_MISMATCH', 'Worker response requestId does not match the request')
  }
  if (value.ok === true && 'result' in value) return value as LightRAGWorkerSuccessResponse
  if (value.ok === false && isRecord(value.error)
    && isNonEmptyString(value.error.code)
    && isNonEmptyString(value.error.message)) {
    return value as LightRAGWorkerErrorResponse
  }
  throw new LightRAGProtocolError('RESPONSE_INVALID', 'Worker returned an invalid protocol response')
}

function isCommand(value: unknown): value is LightRAGWorkerCommand {
  return typeof value === 'string' && (LIGHTRAG_COMMANDS as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
