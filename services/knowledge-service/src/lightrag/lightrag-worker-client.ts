import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from 'node:process'

import type { NormalizedDocument } from '../../../../packages/shared-types/src/normalized-document.js'

export interface LightRAGWorkerClientOptions {
  readonly workingDir?: string
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

interface WorkerFailureResponse {
  readonly ok: false
  readonly command: string
  readonly error: {
    readonly type: string
    readonly message: string
  }
}

/** Calls the project-local Python worker that owns the LightRAG runtime boundary. */
export class LightRAGWorkerClient {
  readonly #pythonPath: string
  readonly #workerPath: string
  readonly #workingDir: string

  constructor(options: LightRAGWorkerClientOptions = {}) {
    const moduleRelativeRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const repositoryRoot = findRepositoryRoot(moduleRelativeRoot)
    loadProjectEnvironment(repositoryRoot)
    this.#pythonPath = resolve(repositoryRoot, 'services/knowledge-service/.venv/bin/python')
    this.#workerPath = resolve(repositoryRoot, 'services/knowledge-service/python/lightrag_worker.py')
    this.#workingDir = resolve(options.workingDir ?? resolve(repositoryRoot, 'data/runtime/lightrag'))
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

  async #execute(command: 'health' | 'model-health' | 'ingest-document', extra: Record<string, unknown> = {}): Promise<unknown> {
    const request = JSON.stringify({ command, workingDir: this.#workingDir, ...extra })
    const result = await runWorker(this.#pythonPath, this.#workerPath, request, command)
    const response = parseResponse(result.stdout, this.#workerPath, command)
    if (isWorkerFailure(response)) {
      throw new Error(`LightRAG command ${response.command} failed (${response.error.type}): ${response.error.message}`)
    }
    return response
  }
}

function findRepositoryRoot(moduleRelativeRoot: string): string {
  if (existsSync(resolve(moduleRelativeRoot, 'package.json'))) return moduleRelativeRoot
  const compiledRoot = resolve(moduleRelativeRoot, '..')
  if (existsSync(resolve(compiledRoot, 'package.json'))) return compiledRoot
  throw new Error(`Cannot locate repository root from ${moduleRelativeRoot}`)
}

function loadProjectEnvironment(repositoryRoot: string): void {
  const envPath = resolve(repositoryRoot, '.env')
  if (existsSync(envPath)) loadEnvFile(envPath)
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

function parseResponse(stdout: string, workerPath: string, command: string): unknown {
  try {
    return JSON.parse(stdout) as unknown
  } catch (error) {
    throw new Error(`LightRAG command ${command} returned invalid JSON from ${workerPath}: ${errorMessage(error)}`)
  }
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

function isWorkerFailure(value: unknown): value is WorkerFailureResponse {
  return isRecord(value)
    && value.ok === false
    && typeof value.command === 'string'
    && isRecord(value.error)
    && typeof value.error.type === 'string'
    && typeof value.error.message === 'string'
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

function invalidResponse(command: string, workerPath: string, response: unknown): Error {
  if (isWorkerFailure(response)) {
    return new Error(`LightRAG command ${response.command} failed (${response.error.type}): ${response.error.message}`)
  }
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
