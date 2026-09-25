import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

import type { MemoryEmbeddingInput } from '@monash-study/shared-types'

export interface MemoryEmbeddingProvider {
  readonly model: string
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>
}

export interface BgeM3MemoryEmbeddingProviderOptions {
  readonly pythonPath: string
  readonly workerPath: string
  readonly model?: string
  readonly dimension?: number
  readonly maxTokens?: number
  readonly batchSize?: number
}

/** Real local BGE-M3 adapter. Construction is side-effect free; the model loads on embed(). */
export class BgeM3MemoryEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly model: string
  readonly #pythonPath: string
  readonly #workerPath: string
  readonly #dimension: number
  readonly #maxTokens: number
  readonly #batchSize: number

  constructor(options: BgeM3MemoryEmbeddingProviderOptions) {
    this.#pythonPath = resolve(options.pythonPath)
    this.#workerPath = resolve(options.workerPath)
    this.model = options.model ?? 'BAAI/bge-m3'
    this.#dimension = options.dimension ?? 1024
    this.#maxTokens = options.maxTokens ?? 8192
    this.#batchSize = options.batchSize ?? 4
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return []
    if (texts.some((text) => text.trim().length === 0)) throw new Error('Embedding text cannot be empty')
    const output = await runWorker(this.#pythonPath, this.#workerPath, JSON.stringify({
      model: this.model,
      dimension: this.#dimension,
      maxTokens: this.#maxTokens,
      batchSize: this.#batchSize,
      texts,
    }))
    const parsed = JSON.parse(output) as unknown
    if (!isRecord(parsed)
      || parsed.model !== this.model
      || !Array.isArray(parsed.embeddings)
      || parsed.embeddings.length !== texts.length
      || !parsed.embeddings.every((vector: unknown) => isVector(vector, this.#dimension))) {
      throw new Error('BGE-M3 memory worker returned an invalid response')
    }
    return parsed.embeddings as number[][]
  }
}

export async function embedMemoryContent(
  provider: MemoryEmbeddingProvider,
  content: string,
): Promise<MemoryEmbeddingInput> {
  const [vector] = await provider.embed([content])
  if (vector === undefined) throw new Error('Memory embedding provider returned no vector')
  return { model: provider.model, vector }
}

function runWorker(pythonPath: string, workerPath: string, stdin: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pythonPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(`BGE-M3 memory worker exited with code ${String(code)}: ${stderr.trim()}`))
    })
    child.stdin.end(stdin)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isVector(value: unknown, dimension: number): value is number[] {
  return Array.isArray(value)
    && value.length === dimension
    && value.every((item) => typeof item === 'number' && Number.isFinite(item))
}
