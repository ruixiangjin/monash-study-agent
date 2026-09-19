import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface LightRAGWorkerClientOptions {
  readonly workingDir?: string
}

export interface LightRAGHealthResult {
  readonly package: 'lightrag-hku'
  readonly version: string
  readonly pythonVersion: string
  readonly workingDir: string
}

interface WorkerSuccessResponse {
  readonly ok: true
  readonly command: 'health'
  readonly runtime: LightRAGHealthResult
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
    const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    this.#pythonPath = resolve(repositoryRoot, 'services/knowledge-service/.venv/bin/python')
    this.#workerPath = resolve(repositoryRoot, 'services/knowledge-service/python/lightrag_worker.py')
    this.#workingDir = resolve(options.workingDir ?? resolve(repositoryRoot, 'data/runtime/lightrag'))
  }

  async health(): Promise<LightRAGHealthResult> {
    const request = JSON.stringify({ command: 'health', workingDir: this.#workingDir })
    const result = await runWorker(this.#pythonPath, this.#workerPath, request)
    const response = parseResponse(result.stdout, this.#workerPath)
    if (!isWorkerSuccess(response)) {
      if (isWorkerFailure(response)) {
        throw new Error(`LightRAG command ${response.command} failed (${response.error.type}): ${response.error.message}`)
      }
      throw new Error(`LightRAG command health returned an invalid response from ${this.#workerPath}`)
    }
    if (!isHealthResult(response.runtime)) {
      throw new Error(`LightRAG command health returned invalid runtime data from ${this.#workerPath}`)
    }
    return response.runtime
  }
}

async function runWorker(
  pythonPath: string,
  workerPath: string,
  request: string,
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
        reject(new Error(`LightRAG command health failed while running ${workerPath}: ${diagnostics}`))
        return
      }
      resolvePromise(output)
    })
    child.stdin.end(request)
  })
}

function parseResponse(stdout: string, workerPath: string): unknown {
  try {
    return JSON.parse(stdout) as unknown
  } catch (error) {
    throw new Error(`LightRAG command health returned invalid JSON from ${workerPath}: ${errorMessage(error)}`)
  }
}

function isWorkerSuccess(value: unknown): value is WorkerSuccessResponse {
  return isRecord(value) && value.ok === true && value.command === 'health' && isRecord(value.runtime)
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

function isAbsoluteString(value: unknown): value is string {
  return typeof value === 'string' && resolve(value) === value
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
