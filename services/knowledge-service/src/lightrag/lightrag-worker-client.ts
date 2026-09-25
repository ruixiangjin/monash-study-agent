import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

import type { NormalizedDocument } from '@monash-study/shared-types'
import { loadRuntimeConfig, type LoadedRuntimeConfig } from '../runtime/runtime-config.js'
import {
  createWorkerRequest,
  parseWorkerResponse,
  type LightRAGWorkerCommand,
} from './lightrag-worker-protocol.js'

export interface LightRAGWorkerClientOptions {
  readonly workingDir?: string
  readonly configPath?: string
  readonly applicationRoot?: string
  readonly runtimeConfig?: LoadedRuntimeConfig
  readonly pythonPath?: string
  readonly workerPath?: string
}

export interface LightRAGHealthResult {
  readonly package: 'lightrag-hku'
  readonly version: string
  readonly pythonVersion: string
  readonly workingDir: string
}

export interface LightRAGModelHealthResult {
  readonly llm: {
    readonly provider: 'deepseek'
    readonly model: string
    readonly baseUrl: string
    readonly thinking: false
    readonly responseReceived: true
  }
  readonly embedding: {
    readonly model: string
    readonly dimension: number
    readonly maxTokens: number
    readonly device: string
    readonly shape: readonly [number, number]
  }
}

export interface LightRAGIngestionResult {
  readonly documentId: string
  readonly resourceId: string
  readonly course: string | null
  readonly workingDir: string
  readonly model: string
  readonly embeddingModel: string
}

export interface LightRAGDeletionResult {
  readonly documentId: string
  readonly course: string | null
  readonly workingDir: string
  readonly deleted: boolean
  readonly status?: string
  readonly message?: string
}

export type LightRAGCourseBatchOperation =
  | { readonly kind: 'index'; readonly document: NormalizedDocument }
  | { readonly kind: 'replace'; readonly document: NormalizedDocument }
  | { readonly kind: 'remove'; readonly documentId: string }

export interface LightRAGCourseBatchOperationResult {
  readonly documentId: string
  readonly kind: LightRAGCourseBatchOperation['kind']
  readonly ok: boolean
  readonly stage?: 'delete' | 'ingest'
  readonly oldDeleted?: boolean
  readonly error?: {
    readonly type: string
    readonly message: string
  }
}

export interface LightRAGCourseBatchResult {
  readonly course: string
  readonly workingDir: string
  readonly operations: readonly LightRAGCourseBatchOperationResult[]
}

export interface LightRAGRetrievedChunk {
  readonly chunkId?: string
  readonly documentId?: string
  readonly filePath?: string
  readonly referenceId?: string
  readonly content: string
  readonly score?: number
}

export interface LightRAGQueryResult {
  readonly course: string
  readonly mode: 'mix'
  readonly chunks: readonly LightRAGRetrievedChunk[]
  readonly unresolved: number
}

interface WorkerSuccessResponse {
  readonly ok: true
  readonly command: 'health'
  readonly runtime: LightRAGHealthResult
}

interface WorkerModelHealthResponse {
  readonly ok: true
  readonly command: 'model-health'
  readonly models: LightRAGModelHealthResult
}

interface WorkerIngestionResponse {
  readonly ok: true
  readonly command: 'ingest-document'
  readonly ingestion: LightRAGIngestionResult
}

interface WorkerDeletionResponse {
  readonly ok: true
  readonly command: 'delete-document'
  readonly deletion: LightRAGDeletionResult
}

interface WorkerCourseBatchResponse {
  readonly ok: true
  readonly command: 'sync-course-batch'
  readonly batch: LightRAGCourseBatchResult
}

interface WorkerQueryResponse {
  readonly ok: true
  readonly command: 'query-course'
  readonly query: LightRAGQueryResult
}

/** Calls the project-local Python worker that owns the LightRAG runtime boundary. */
export class LightRAGWorkerClient {
  readonly #pythonPath: string
  readonly #workerPath: string
  readonly #workingDir: string
  readonly #runtimeConfig: LoadedRuntimeConfig

  constructor(options: LightRAGWorkerClientOptions = {}) {
    this.#runtimeConfig = options.runtimeConfig ?? loadRuntimeConfig({
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.applicationRoot === undefined ? {} : { applicationRoot: options.applicationRoot }),
    })
    this.#pythonPath = resolve(options.pythonPath ?? this.#runtimeConfig.pythonExecutable)
    this.#workerPath = resolve(options.workerPath ?? this.#runtimeConfig.workers.lightrag)
    this.#workingDir = resolve(options.workingDir ?? this.#runtimeConfig.lightrag.workingRoot)
  }

  async health(): Promise<LightRAGHealthResult> {
    const response = await this.#execute('health')
    if (!isWorkerSuccess(response)) throw invalidResponse('health', this.#workerPath, response)
    if (!isHealthResult(response.runtime)) {
      throw new Error(`LightRAG command health returned invalid runtime data from ${this.#workerPath}`)
    }
    return response.runtime
  }

  async modelHealth(): Promise<LightRAGModelHealthResult> {
    const response = await this.#execute('model-health')
    if (!isWorkerModelHealth(response)) throw invalidResponse('model-health', this.#workerPath, response)
    if (!isModelHealthResult(response.models)) {
      throw new Error(`LightRAG command model-health returned invalid model data from ${this.#workerPath}`)
    }
    return response.models
  }

  async ingestDocument(document: NormalizedDocument): Promise<LightRAGIngestionResult> {
    const response = await this.#execute('ingest-document', { document })
    if (!isWorkerIngestion(response)) throw invalidResponse('ingest-document', this.#workerPath, response)
    if (!isIngestionResult(response.ingestion)) {
      throw new Error(`LightRAG command ingest-document returned invalid ingestion data from ${this.#workerPath}`)
    }
    return response.ingestion
  }

  async deleteDocument(documentId: string, course: string | null): Promise<LightRAGDeletionResult> {
    const response = await this.#execute('delete-document', { documentId, course })
    if (!isWorkerDeletion(response)) throw invalidResponse('delete-document', this.#workerPath, response)
    if (!isDeletionResult(response.deletion)) {
      throw new Error(`LightRAG command delete-document returned invalid deletion data from ${this.#workerPath}`)
    }
    return response.deletion
  }

  async syncCourseBatch(
    course: string,
    operations: readonly LightRAGCourseBatchOperation[],
  ): Promise<LightRAGCourseBatchResult> {
    const response = await this.#execute('sync-course-batch', { course, operations })
    if (!isWorkerCourseBatch(response)) throw invalidResponse('sync-course-batch', this.#workerPath, response)
    if (!isCourseBatchResult(response.batch)) {
      throw new Error(`LightRAG command sync-course-batch returned invalid batch data from ${this.#workerPath}`)
    }
    return response.batch
  }

  async queryCourse(
    course: string,
    query: string,
    options: { readonly topK?: number; readonly chunkTopK?: number } = {},
  ): Promise<LightRAGQueryResult> {
    const response = await this.#execute('query-course', {
      course,
      query,
      topK: options.topK ?? this.#runtimeConfig.lightrag.query.topK,
      chunkTopK: options.chunkTopK ?? this.#runtimeConfig.lightrag.query.chunkTopK,
    })
    if (!isWorkerQuery(response)) throw invalidResponse('query-course', this.#workerPath, response)
    if (!isQueryResult(response.query)) {
      throw new Error(`LightRAG command query-course returned invalid query data from ${this.#workerPath}`)
    }
    return response.query
  }

  async #execute(
    command: LightRAGWorkerCommand,
    extra: Record<string, unknown> = {},
  ): Promise<unknown> {
    const request = createWorkerRequest(command, {
      runtimeConfigPath: this.#runtimeConfig.configPath,
      applicationRoot: this.#runtimeConfig.applicationRoot,
      workingDir: this.#workingDir,
      ...extra,
    })
    const result = await runWorker(this.#pythonPath, this.#workerPath, JSON.stringify(request), command)
    const response = parseWorkerResponse(result.stdout, request.requestId)
    if (!response.ok) {
      throw new Error(`LightRAG command ${command} failed (${response.error.code}): ${response.error.message}`)
    }
    if (!isRecord(response.result)) {
      throw new Error(`LightRAG command ${command} returned a non-object result from ${this.#workerPath}`)
    }
    return { ok: true, command, ...response.result }
  }
}

async function runWorker(
  pythonPath: string,
  workerPath: string,
  request: string,
  command: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(pythonPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new Error(`Could not start LightRAG worker at ${workerPath} with ${pythonPath}: ${errorMessage(error)}`))
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => reject(new Error(`Could not start LightRAG worker at ${workerPath} with ${pythonPath}: ${errorMessage(error)}`)))
    child.on('close', (code) => {
      const output = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
      if (code !== 0) {
        const diagnostics = output.stderr.trim() || `exit ${code ?? 'unknown'}`
        reject(new Error(`LightRAG command ${command} failed while running ${workerPath}: ${diagnostics}`))
        return
      }
      resolvePromise(output)
    })
    child.stdin.end(request)
  })
}

function isWorkerSuccess(value: unknown): value is WorkerSuccessResponse {
  return isRecord(value) && value.ok === true && value.command === 'health' && isRecord(value.runtime)
}

function isWorkerModelHealth(value: unknown): value is WorkerModelHealthResponse {
  return isRecord(value) && value.ok === true && value.command === 'model-health' && isRecord(value.models)
}

function isWorkerIngestion(value: unknown): value is WorkerIngestionResponse {
  return isRecord(value) && value.ok === true && value.command === 'ingest-document' && isRecord(value.ingestion)
}

function isWorkerDeletion(value: unknown): value is WorkerDeletionResponse {
  return isRecord(value) && value.ok === true && value.command === 'delete-document' && isRecord(value.deletion)
}

function isWorkerCourseBatch(value: unknown): value is WorkerCourseBatchResponse {
  return isRecord(value) && value.ok === true && value.command === 'sync-course-batch' && isRecord(value.batch)
}

function isWorkerQuery(value: unknown): value is WorkerQueryResponse {
  return isRecord(value) && value.ok === true && value.command === 'query-course' && isRecord(value.query)
}

function isHealthResult(value: unknown): value is LightRAGHealthResult {
  return isRecord(value)
    && value.package === 'lightrag-hku'
    && typeof value.version === 'string'
    && typeof value.pythonVersion === 'string'
    && isAbsoluteString(value.workingDir)
}

function isModelHealthResult(value: unknown): value is LightRAGModelHealthResult {
  return isRecord(value)
    && isRecord(value.llm)
    && value.llm.provider === 'deepseek'
    && typeof value.llm.model === 'string'
    && typeof value.llm.baseUrl === 'string'
    && value.llm.thinking === false
    && value.llm.responseReceived === true
    && isRecord(value.embedding)
    && typeof value.embedding.model === 'string'
    && typeof value.embedding.dimension === 'number'
    && typeof value.embedding.maxTokens === 'number'
    && typeof value.embedding.device === 'string'
    && Array.isArray(value.embedding.shape)
    && value.embedding.shape.length === 2
    && value.embedding.shape.every((item: unknown) => typeof item === 'number')
}

function isIngestionResult(value: unknown): value is LightRAGIngestionResult {
  return isRecord(value)
    && typeof value.documentId === 'string'
    && typeof value.resourceId === 'string'
    && (value.course === null || typeof value.course === 'string')
    && isAbsoluteString(value.workingDir)
    && typeof value.model === 'string'
    && typeof value.embeddingModel === 'string'
}

function isDeletionResult(value: unknown): value is LightRAGDeletionResult {
  return isRecord(value)
    && typeof value.documentId === 'string'
    && (value.course === null || typeof value.course === 'string')
    && isAbsoluteString(value.workingDir)
    && typeof value.deleted === 'boolean'
    && (value.status === undefined || typeof value.status === 'string')
    && (value.message === undefined || typeof value.message === 'string')
}

function isCourseBatchResult(value: unknown): value is LightRAGCourseBatchResult {
  return isRecord(value)
    && typeof value.course === 'string'
    && isAbsoluteString(value.workingDir)
    && Array.isArray(value.operations)
    && value.operations.every(isCourseBatchOperationResult)
}

function isCourseBatchOperationResult(value: unknown): value is LightRAGCourseBatchOperationResult {
  return isRecord(value)
    && typeof value.documentId === 'string'
    && (value.kind === 'index' || value.kind === 'replace' || value.kind === 'remove')
    && typeof value.ok === 'boolean'
    && (value.stage === undefined || value.stage === 'delete' || value.stage === 'ingest')
    && (value.oldDeleted === undefined || typeof value.oldDeleted === 'boolean')
    && (value.error === undefined || (
      isRecord(value.error)
      && typeof value.error.type === 'string'
      && typeof value.error.message === 'string'
    ))
}

function isQueryResult(value: unknown): value is LightRAGQueryResult {
  return isRecord(value)
    && typeof value.course === 'string'
    && value.mode === 'mix'
    && typeof value.unresolved === 'number'
    && Array.isArray(value.chunks)
    && value.chunks.every(isRetrievedChunk)
}

function isRetrievedChunk(value: unknown): value is LightRAGRetrievedChunk {
  return isRecord(value)
    && (value.chunkId === undefined || typeof value.chunkId === 'string')
    && (value.documentId === undefined || typeof value.documentId === 'string')
    && (value.filePath === undefined || typeof value.filePath === 'string')
    && (value.referenceId === undefined || typeof value.referenceId === 'string')
    && typeof value.content === 'string'
    && (value.score === undefined || typeof value.score === 'number')
}

function invalidResponse(command: string, workerPath: string, response: unknown): Error {
  void response
  return new Error(`LightRAG command ${command} returned an invalid response from ${workerPath}`)
}

function isAbsoluteString(value: unknown): value is string {
  return typeof value === 'string' && resolve(value) === value
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
