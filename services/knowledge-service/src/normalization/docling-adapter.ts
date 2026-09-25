import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

import type { NormalizedRegion } from '@monash-study/shared-types'

/** JSON result emitted by the pinned Docling worker. */
export interface DoclingConversion {
  readonly markdown: string
  readonly pageNumbers: readonly number[]
  readonly regions: readonly NormalizedRegion[]
  readonly inputFormat: string
  readonly doclingVersion: string
  readonly ocrEngine: string
  readonly usedFullPageOcr: boolean
  readonly pictureCount: number
  readonly tableCount: number
}

/** Configuration for the local Python Docling bridge. */
export interface DoclingAdapterConfig {
  readonly pythonPath: string
  readonly workerPath: string
}

/** Runs the project-pinned Docling Standard Pipeline outside the Node process. */
export class DoclingAdapter {
  readonly #pythonPath: string
  readonly #workerPath: string

  constructor(config: DoclingAdapterConfig) {
    this.#pythonPath = resolve(config.pythonPath)
    this.#workerPath = resolve(config.workerPath)
  }

  /** Convert one PDF, DOCX, or PPTX file into Markdown and source locators. */
  async convert(path: string): Promise<DoclingConversion> {
    const { stdout, stderr, code } = await runProcess(this.#pythonPath, [this.#workerPath, '--input', path])
    if (code !== 0) throw new Error(`Docling conversion failed for ${path}: ${stderr.trim() || `exit ${code}`}`)
    let value: unknown
    try {
      value = JSON.parse(stdout)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Docling returned invalid JSON for ${path}: ${reason}`)
    }
    return parseConversion(value, path)
  }
}

async function runProcess(command: string, args: readonly string[]): Promise<{
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      code: code ?? 1,
    }))
  })
}

function parseConversion(value: unknown, path: string): DoclingConversion {
  if (!isRecord(value)
    || typeof value.markdown !== 'string'
    || !Array.isArray(value.pageNumbers)
    || !Array.isArray(value.regions)
    || typeof value.inputFormat !== 'string'
    || typeof value.doclingVersion !== 'string'
    || typeof value.ocrEngine !== 'string'
    || typeof value.usedFullPageOcr !== 'boolean'
    || typeof value.pictureCount !== 'number'
    || typeof value.tableCount !== 'number') {
    throw new Error(`Docling result has invalid fields for ${path}`)
  }
  return value as unknown as DoclingConversion
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
