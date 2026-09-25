import { existsSync, readFileSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { RuntimeConfig } from '@monash-study/shared-types'

export interface RuntimeConfigLoadOptions {
  /** Product workspace anchor supplied by a launcher or integration boundary. */
  readonly applicationRoot?: string
  /** Runtime JSON path. Relative paths are resolved against applicationRoot when supplied. */
  readonly configPath?: string
  /** Resource manifest path supplied by the launcher/profile. */
  readonly resourceManifestPath?: string
  /** Injectable environment for tests and launchers. */
  readonly environment?: NodeJS.ProcessEnv
}

export interface ResolvedRuntimePath {
  readonly value: string
  readonly source: string
}

export interface RuntimeConfigurationProvenance {
  readonly applicationRoot: ResolvedRuntimePath
  readonly configPath: ResolvedRuntimePath
  readonly resourceManifestPath: ResolvedRuntimePath
  readonly normalizedRoot: ResolvedRuntimePath
  readonly pythonExecutable: ResolvedRuntimePath
  readonly lightragWorker: ResolvedRuntimePath
  readonly doclingWorker: ResolvedRuntimePath
  readonly memoryEmbeddingWorker: ResolvedRuntimePath
  readonly lightragWorkingRoot: ResolvedRuntimePath
  readonly sqlitePath: ResolvedRuntimePath
}

export interface LoadedRuntimeConfig extends RuntimeConfig {
  readonly applicationRoot: string
  readonly configPath: string
  readonly resourceManifestPath: string
  readonly normalizedRoot: string
  readonly pythonExecutable: string
  readonly workers: {
    readonly lightrag: string
    readonly docling: string
    readonly memoryEmbedding: string
  }
  readonly lightrag: RuntimeConfig['lightrag'] & {
    readonly workingRoot: string
    readonly sqlitePath: string
  }
  readonly provenance: RuntimeConfigurationProvenance
}

/**
 * Resolve the product-owned runtime context once.
 *
 * Explicit launcher inputs take precedence over the development-only module
 * location fallback. Relative paths inside runtime.json are always resolved
 * against applicationRoot, never against the installed package or cwd.
 */
export function loadRuntimeConfig(
  options: RuntimeConfigLoadOptions | string = {},
): LoadedRuntimeConfig {
  const requested = typeof options === 'string' ? { configPath: options } : options
  const environment = requested.environment ?? process.env
  const environmentRoot = nonEmpty(environment.MONASH_STUDY_AGENT_ROOT)
  const environmentConfig = nonEmpty(environment.MONASH_STUDY_AGENT_RUNTIME_CONFIG)
  const environmentManifest = nonEmpty(environment.MONASH_STUDY_AGENT_RESOURCE_MANIFEST)
  const configuredRoot = requested.applicationRoot ?? environmentRoot
  const configuredConfigPath = requested.configPath ?? environmentConfig

  const applicationRoot = configuredRoot === undefined
    ? configuredConfigPath === undefined
      ? pathValue(findDevelopmentApplicationRoot(), 'development module location')
      : inferApplicationRoot(resolve(configuredConfigPath), 'explicit config path')
    : pathValue(
      resolve(configuredRoot),
      requested.applicationRoot === undefined ? 'MONASH_STUDY_AGENT_ROOT' : 'explicit applicationRoot',
    )

  const resolvedConfigPath = configuredConfigPath === undefined
    ? pathValue(join(applicationRoot.value, 'config', 'runtime.json'), 'applicationRoot default config')
    : pathValue(
      resolveAgainst(applicationRoot.value, configuredConfigPath),
      requested.configPath === undefined ? 'MONASH_STUDY_AGENT_RUNTIME_CONFIG' : 'explicit configPath',
    )
  const raw = JSON.parse(readFileSync(resolvedConfigPath.value, 'utf8')) as unknown
  assertRuntimeConfig(raw, resolvedConfigPath.value)

  const manifestInput = requested.resourceManifestPath ?? environmentManifest
  const resourceManifestPath = manifestInput === undefined
    ? pathValue(join(applicationRoot.value, 'resources', 'resources.json'), 'applicationRoot default resource manifest')
    : pathValue(
      resolveAgainst(applicationRoot.value, manifestInput),
      requested.resourceManifestPath === undefined ? 'MONASH_STUDY_AGENT_RESOURCE_MANIFEST' : 'explicit resourceManifestPath',
    )

  const normalizedRoot = configuredPath(raw.paths?.normalizedRoot, 'data/normalized', applicationRoot.value, 'runtime.json paths.normalizedRoot')
  const pythonExecutable = configuredPath(raw.paths?.pythonExecutable, 'services/knowledge-service/.venv/bin/python', applicationRoot.value, 'runtime.json paths.pythonExecutable')
  const lightragWorker = configuredPath(raw.paths?.workers?.lightrag, 'services/knowledge-service/python/lightrag_worker.py', applicationRoot.value, 'runtime.json paths.workers.lightrag')
  const doclingWorker = configuredPath(raw.paths?.workers?.docling, 'services/knowledge-service/python/docling_worker.py', applicationRoot.value, 'runtime.json paths.workers.docling')
  const memoryEmbeddingWorker = configuredPath(raw.paths?.workers?.memoryEmbedding, 'services/memory-service/python/memory_embedding_worker.py', applicationRoot.value, 'runtime.json paths.workers.memoryEmbedding')
  const lightragWorkingRoot = configuredPath(raw.lightrag.workingRoot, raw.lightrag.workingRoot, applicationRoot.value, 'runtime.json lightrag.workingRoot')
  const sqlitePath = configuredPath(raw.lightrag.sqlitePath, raw.lightrag.sqlitePath, applicationRoot.value, 'runtime.json lightrag.sqlitePath')

  return {
    ...raw,
    applicationRoot: applicationRoot.value,
    configPath: resolvedConfigPath.value,
    resourceManifestPath: resourceManifestPath.value,
    normalizedRoot: normalizedRoot.value,
    pythonExecutable: pythonExecutable.value,
    workers: {
      lightrag: lightragWorker.value,
      docling: doclingWorker.value,
      memoryEmbedding: memoryEmbeddingWorker.value,
    },
    lightrag: {
      ...raw.lightrag,
      workingRoot: lightragWorkingRoot.value,
      sqlitePath: sqlitePath.value,
    },
    provenance: {
      applicationRoot,
      configPath: resolvedConfigPath,
      resourceManifestPath,
      normalizedRoot,
      pythonExecutable,
      lightragWorker,
      doclingWorker,
      memoryEmbeddingWorker,
      lightragWorkingRoot,
      sqlitePath,
    },
  }
}

/** Load the product .env once at a launcher/bootstrap boundary. */
export function loadApplicationEnvironment(applicationRoot: string): void {
  const envPath = join(resolve(applicationRoot), '.env')
  if (existsSync(envPath)) loadEnvFile(envPath)
}

/** Render safe path provenance for one launcher-level diagnostic. */
export function formatRuntimeConfiguration(config: LoadedRuntimeConfig, runtime = 'single-dsh-web'): string {
  const entries: readonly [string, ResolvedRuntimePath][] = [
    ['applicationRoot', config.provenance.applicationRoot],
    ['runtimeConfig', config.provenance.configPath],
    ['resourceManifest', config.provenance.resourceManifestPath],
    ['sqlite', config.provenance.sqlitePath],
    ['lightRAGWorkingRoot', config.provenance.lightragWorkingRoot],
    ['normalizedRoot', config.provenance.normalizedRoot],
    ['python', config.provenance.pythonExecutable],
    ['lightRAGWorker', config.provenance.lightragWorker],
    ['doclingWorker', config.provenance.doclingWorker],
    ['memoryEmbeddingWorker', config.provenance.memoryEmbeddingWorker],
  ]
  return [
    'Monash Study Agent runtime configuration',
    `runtime: ${runtime}`,
    ...entries.flatMap(([name, path]) => [`${name}:`, `  value: ${path.value}`, `  source: ${path.source}`]),
  ].join('\n')
}

function configuredPath(value: string | undefined, fallback: string, applicationRoot: string, source: string): ResolvedRuntimePath {
  return pathValue(resolveAgainst(applicationRoot, value ?? fallback), value === undefined ? `${source} default` : source)
}

function resolveAgainst(base: string, value: string): string {
  return resolve(base, value)
}

function inferApplicationRoot(configPath: string, source: string): ResolvedRuntimePath {
  const configDirectory = dirname(configPath)
  return pathValue(resolve(configDirectory, '..'), source)
}

function findDevelopmentApplicationRoot(): string {
  const moduleRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  if (readablePackageJson(moduleRoot)) return moduleRoot
  const compiledRoot = resolve(moduleRoot, '..')
  if (readablePackageJson(compiledRoot)) return compiledRoot
  throw new Error(`Cannot locate development application root from ${moduleRoot}; pass applicationRoot explicitly`)
}

function readablePackageJson(directory: string): boolean {
  try {
    return typeof JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) === 'object'
  } catch {
    return false
  }
}

function pathValue(value: string, source: string): ResolvedRuntimePath {
  return { value: resolve(value), source }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value
}

function assertRuntimeConfig(value: unknown, configPath: string): asserts value is RuntimeConfig {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.knowledgeProvider !== 'lightrag'
    || (value.paths !== undefined && !isRuntimePathConfig(value.paths))
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

function isRuntimePathConfig(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.normalizedRoot !== undefined && !isString(value.normalizedRoot)) return false
  if (value.pythonExecutable !== undefined && !isString(value.pythonExecutable)) return false
  if (value.workers === undefined) return true
  return isRecord(value.workers)
    && (value.workers.lightrag === undefined || isString(value.workers.lightrag))
    && (value.workers.docling === undefined || isString(value.workers.docling))
    && (value.workers.memoryEmbedding === undefined || isString(value.workers.memoryEmbedding))
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
