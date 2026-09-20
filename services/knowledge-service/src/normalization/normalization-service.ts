import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

import type { NormalizedDocument, Resource } from '@monash-study/shared-types'
import { CodeNormalizer } from './code-normalizer.js'
import { CsvNormalizer } from './csv-normalizer.js'
import { DocumentNormalizer } from './document-normalizer.js'
import { ForumNormalizer } from './forum-normalizer.js'
import type { NormalizedDocumentDraft, ResourceNormalizer } from './resource-normalizer.js'
import { TextNormalizer } from './text-normalizer.js'

const NORMALIZATION_SCHEMA_VERSION = '1'

/** Result status used by the CLI and maintenance workflows. */
export type NormalizationStatus = 'failed' | 'normalized' | 'unchanged' | 'unsupported'

/** Observable result of normalizing one Resource. */
export interface NormalizationResult {
  readonly resourceId: string
  readonly status: NormalizationStatus
  readonly documents: readonly NormalizedDocument[]
  readonly error?: string
}

/** Configuration for the normalization router and persistent output. */
export interface NormalizationServiceConfig {
  readonly outputRoot?: string
  readonly normalizers?: readonly ResourceNormalizer[]
}

interface StoredDocumentReference {
  readonly documentId: string
  readonly jsonPath: string
  readonly markdownPath: string
  readonly normalizedHash: string
}

interface NormalizationState {
  readonly schemaVersion: 1
  readonly resourceId: string
  readonly sourceHash: string
  readonly normalizationVersion: string
  readonly status: Exclude<NormalizationStatus, 'unchanged'>
  readonly normalizedAt: string
  readonly documents: readonly StoredDocumentReference[]
  readonly error?: string
}

/** Routes Resources to deterministic normalizers and persists reusable output. */
export class NormalizationService {
  readonly #outputRoot: string
  readonly #normalizers: readonly ResourceNormalizer[]

  constructor(config: NormalizationServiceConfig = {}) {
    this.#outputRoot = resolve(config.outputRoot ?? 'data/normalized')
    this.#normalizers = config.normalizers ?? [
      new ForumNormalizer(),
      new TextNormalizer(),
      new CodeNormalizer(),
      new CsvNormalizer(),
      new DocumentNormalizer(),
    ]
  }

  /** Normalize one Resource, returning documents regardless of cache reuse. */
  async normalize(resource: Resource): Promise<readonly NormalizedDocument[]> {
    const result = await this.normalizeWithStatus(resource)
    if (result.status === 'failed') throw new Error(result.error ?? `Normalization failed for ${resource.resourceId}`)
    return result.documents
  }

  /** Normalize one Resource while reporting normalized, unchanged, or unsupported. */
  async normalizeWithStatus(resource: Resource): Promise<NormalizationResult> {
    const normalizer = this.#normalizers.find((candidate) => candidate.supports(resource))
    if (normalizer === undefined) {
      await this.#writeState({
        schemaVersion: 1,
        resourceId: resource.resourceId,
        sourceHash: resource.hash,
        normalizationVersion: 'unsupported',
        status: 'unsupported',
        normalizedAt: new Date().toISOString(),
        documents: [],
      })
      return { resourceId: resource.resourceId, status: 'unsupported', documents: [] }
    }

    const normalizationVersion = `${NORMALIZATION_SCHEMA_VERSION}:${normalizer.id}:${normalizer.version}`
    const previous = await this.#readState(resource.resourceId)
    if (previous?.status === 'normalized'
      && previous.sourceHash === resource.hash
      && previous.normalizationVersion === normalizationVersion) {
      const cached = await this.#loadDocuments(previous)
      if (cached !== undefined) {
        return { resourceId: resource.resourceId, status: 'unchanged', documents: cached }
      }
    }

    try {
      const drafts = await normalizer.normalize(resource)
      const documents = drafts.map((draft) => finalizeDocument(resource, normalizationVersion, draft))
      assertUniqueDocumentIds(documents, resource.resourceId)
      const references = await Promise.all(documents.map((document) => this.#writeDocument(document)))
      await this.#removeStaleDocuments(previous, new Set(documents.map((document) => document.documentId)))
      await this.#writeState({
        schemaVersion: 1,
        resourceId: resource.resourceId,
        sourceHash: resource.hash,
        normalizationVersion,
        status: 'normalized',
        normalizedAt: new Date().toISOString(),
        documents: references,
      })
      return { resourceId: resource.resourceId, status: 'normalized', documents }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.#writeState({
        schemaVersion: 1,
        resourceId: resource.resourceId,
        sourceHash: resource.hash,
        normalizationVersion,
        status: 'failed',
        normalizedAt: new Date().toISOString(),
        documents: [],
        error: message,
      })
      return { resourceId: resource.resourceId, status: 'failed', documents: [], error: message }
    }
  }

  /** Normalize Resources serially so document conversion does not compete for models. */
  async normalizeMany(resources: readonly Resource[]): Promise<readonly NormalizationResult[]> {
    const results: NormalizationResult[] = []
    for (const resource of resources) results.push(await this.normalizeWithStatus(resource))
    return results
  }

  /** Read the persisted state used for incremental decisions. */
  async getState(resourceId: string): Promise<Readonly<NormalizationState> | undefined> {
    return await this.#readState(resourceId)
  }

  async #writeDocument(document: NormalizedDocument): Promise<StoredDocumentReference> {
    const course = safeSegment(document.course ?? 'UNCLASSIFIED')
    const source = safeSegment(document.source)
    const documentId = safeSegment(document.documentId)
    const directory = resolve(this.#outputRoot, course, source)
    const markdownPath = resolve(directory, `${documentId}.md`)
    const jsonPath = resolve(directory, `${documentId}.json`)
    await writeAtomic(markdownPath, renderStoredMarkdown(document))
    await writeAtomic(jsonPath, `${JSON.stringify(document, null, 2)}\n`)
    return {
      documentId: document.documentId,
      jsonPath: relative(this.#outputRoot, jsonPath),
      markdownPath: relative(this.#outputRoot, markdownPath),
      normalizedHash: document.normalizedHash,
    }
  }

  async #writeState(state: NormalizationState): Promise<void> {
    await writeAtomic(this.#statePath(state.resourceId), `${JSON.stringify(state, null, 2)}\n`)
  }

  async #readState(resourceId: string): Promise<NormalizationState | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#statePath(resourceId), 'utf8'))
      return isNormalizationState(value) ? value : undefined
    } catch (error) {
      if (isMissingFile(error)) return undefined
      throw error
    }
  }

  async #loadDocuments(state: NormalizationState): Promise<readonly NormalizedDocument[] | undefined> {
    const documents: NormalizedDocument[] = []
    for (const reference of state.documents) {
      const jsonPath = safeOutputPath(this.#outputRoot, reference.jsonPath)
      const markdownPath = safeOutputPath(this.#outputRoot, reference.markdownPath)
      try {
        const [value, markdownInfo]: [unknown, Awaited<ReturnType<typeof stat>>] = await Promise.all([
          readFile(jsonPath, 'utf8').then((json) => JSON.parse(json) as unknown),
          stat(markdownPath),
        ])
        if (!markdownInfo.isFile() || !isNormalizedDocument(value)) return undefined
        const { normalizedHash, ...withoutHash } = value
        const calculatedHash = createHash('sha256').update(JSON.stringify(withoutHash)).digest('hex')
        if (normalizedHash !== reference.normalizedHash || normalizedHash !== calculatedHash) return undefined
        documents.push(value)
      } catch (error) {
        if (isMissingFile(error)) return undefined
        throw error
      }
    }
    return documents
  }

  async #removeStaleDocuments(previous: NormalizationState | undefined, currentIds: ReadonlySet<string>): Promise<void> {
    if (previous === undefined) return
    for (const reference of previous.documents) {
      if (currentIds.has(reference.documentId)) continue
      await rm(safeOutputPath(this.#outputRoot, reference.jsonPath), { force: true })
      await rm(safeOutputPath(this.#outputRoot, reference.markdownPath), { force: true })
    }
  }

  #statePath(resourceId: string): string {
    return resolve(this.#outputRoot, '.state', `${safeSegment(resourceId)}.json`)
  }
}

function finalizeDocument(
  resource: Resource,
  normalizationVersion: string,
  draft: NormalizedDocumentDraft,
): NormalizedDocument {
  const withoutHash = {
    documentId: draft.documentId,
    resourceId: resource.resourceId,
    sourceHash: resource.hash,
    title: draft.title,
    course: resource.course,
    week: resource.week,
    source: resource.source,
    contentType: draft.contentType,
    text: draft.text,
    sourcePath: resource.path,
    locator: draft.locator,
    normalizationVersion,
  }
  return {
    ...withoutHash,
    normalizedHash: createHash('sha256').update(JSON.stringify(withoutHash)).digest('hex'),
  }
}

function renderStoredMarkdown(document: NormalizedDocument): string {
  return [
    '---',
    `documentId: ${JSON.stringify(document.documentId)}`,
    `resourceId: ${JSON.stringify(document.resourceId)}`,
    `sourceHash: ${JSON.stringify(document.sourceHash)}`,
    `title: ${JSON.stringify(document.title)}`,
    `course: ${JSON.stringify(document.course)}`,
    `week: ${JSON.stringify(document.week)}`,
    `source: ${JSON.stringify(document.source)}`,
    `contentType: ${JSON.stringify(document.contentType)}`,
    `sourcePath: ${JSON.stringify(document.sourcePath)}`,
    `normalizationVersion: ${JSON.stringify(document.normalizationVersion)}`,
    `normalizedHash: ${JSON.stringify(document.normalizedHash)}`,
    '---',
    '',
    document.text.trimEnd(),
    '',
  ].join('\n')
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}

function safeOutputPath(root: string, storedPath: string): string {
  const path = resolve(root, storedPath)
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Normalized output escapes root: ${storedPath}`)
  return path
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (segment.length === 0 || segment === '.' || segment === '..') throw new Error(`Unsafe normalized path segment: ${value}`)
  return segment
}

function assertUniqueDocumentIds(documents: readonly NormalizedDocument[], resourceId: string): void {
  const ids = new Set(documents.map((document) => document.documentId))
  if (ids.size !== documents.length) throw new Error(`Normalizer produced duplicate document ids for ${resourceId}`)
}

function isNormalizationState(value: unknown): value is NormalizationState {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.resourceId === 'string'
    && typeof value.sourceHash === 'string'
    && typeof value.normalizationVersion === 'string'
    && (value.status === 'normalized' || value.status === 'failed' || value.status === 'unsupported')
    && typeof value.normalizedAt === 'string'
    && Array.isArray(value.documents)
}

function isNormalizedDocument(value: unknown): value is NormalizedDocument {
  return isRecord(value)
    && typeof value.documentId === 'string'
    && typeof value.resourceId === 'string'
    && typeof value.sourceHash === 'string'
    && typeof value.text === 'string'
    && typeof value.sourcePath === 'string'
    && typeof value.normalizationVersion === 'string'
    && typeof value.normalizedHash === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}
