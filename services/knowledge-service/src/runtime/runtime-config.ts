import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { RuntimeConfig } from '@monash-study/shared-types'

export interface LoadedRuntimeConfig extends RuntimeConfig {
  readonly configPath: string
  readonly repositoryRoot: string
  readonly lightrag: RuntimeConfig['lightrag'] & {
    readonly workingRoot: string
    readonly sqlitePath: string
  }
}

/** Load the single non-secret runtime configuration used by Node and Python. */
export function loadRuntimeConfig(configPath?: string): LoadedRuntimeConfig {
  const moduleRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  const repositoryRoot = findRepositoryRoot(moduleRoot)
  const resolvedConfigPath = resolve(configPath ?? join(repositoryRoot, 'config', 'runtime.json'))
  const raw = JSON.parse(readFileSync(resolvedConfigPath, 'utf8')) as unknown
  assertRuntimeConfig(raw, resolvedConfigPath)
  return {
    ...raw,
    configPath: resolvedConfigPath,
    repositoryRoot,
    lightrag: {
      ...raw.lightrag,
      workingRoot: resolveRuntimePath(repositoryRoot, raw.lightrag.workingRoot),
      sqlitePath: resolveRuntimePath(repositoryRoot, raw.lightrag.sqlitePath),
    },
  }
}

function resolveRuntimePath(repositoryRoot: string, value: string): string {
  return resolve(repositoryRoot, value)
}

function findRepositoryRoot(moduleRoot: string): string {
  if (readablePackageJson(moduleRoot)) return moduleRoot
  const compiledRoot = resolve(moduleRoot, '..')
  if (readablePackageJson(compiledRoot)) return compiledRoot
  throw new Error(`Cannot locate repository root from ${moduleRoot}`)
}

function readablePackageJson(directory: string): boolean {
  try {
    return typeof JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) === 'object'
  } catch {
    return false
  }
}

function assertRuntimeConfig(value: unknown, configPath: string): asserts value is RuntimeConfig {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.knowledgeProvider !== 'lightrag'
    || !isRecord(value.lightrag)
    || !isRecord(value.lightrag.llm)
    || !isRecord(value.lightrag.embedding)
    || !isRecord(value.lightrag.query)) {
    throw new Error(`Invalid runtime config: ${configPath}`)
  }
  if (!isString(value.lightrag.workingRoot)
    || !isString(value.lightrag.sqlitePath)
    || !isString(value.lightrag.llm.model)
    || !isString(value.lightrag.llm.baseUrl)
    || !isString(value.lightrag.embedding.model)
    || !isPositiveInteger(value.lightrag.embedding.dimension)
    || !isPositiveInteger(value.lightrag.embedding.maxTokens)
    || !isPositiveInteger(value.lightrag.embedding.batchSize)
    || !isPositiveInteger(value.lightrag.embedding.maxAsync)
    || value.lightrag.query.mode !== 'mix'
    || typeof value.lightrag.query.rerank !== 'boolean'
    || !isPositiveInteger(value.lightrag.query.topK)
    || !isPositiveInteger(value.lightrag.query.chunkTopK)) {
    throw new Error(`Invalid runtime config values: ${configPath}`)
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
