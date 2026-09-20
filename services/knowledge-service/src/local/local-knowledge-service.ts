import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Writable } from 'node:stream'

import type {
  DownloaderMetadata,
  Resource,
  ResourceFileType,
  ResourceFilter,
  ResourceManifest,
  ResourceManifestStatistics,
  ResourceRoot,
  ResourceSource,
  ResourceText,
  ResourceType,
} from '@monash-study/shared-types'

const CODE_EXTENSIONS = new Set([
  '.awk', '.bash', '.c', '.cc', '.cpp', '.css', '.go', '.h', '.hpp', '.hs', '.html',
  '.java', '.js', '.jsx', '.kt', '.lhs', '.mjs', '.php', '.py', '.r', '.rb', '.rs',
  '.scala', '.sh', '.sql', '.swift', '.ts', '.tsx', '.xml', '.yaml', '.yml',
])
const TEXT_EXTENSIONS = new Set(['.log', '.rst', '.tex', '.text', '.txt'])
const DATA_EXTENSIONS = new Set(['.canvas', '.csv', '.json', '.toml', '.tsv'])
const ARCHIVE_EXTENSIONS = new Set(['.7z', '.gz', '.rar', '.tar', '.tgz', '.zip'])
const OFFICE_EXTENSIONS = new Set(['.doc', '.docx', '.odp', '.ods', '.odt', '.ppt', '.pptx', '.xls', '.xlsx'])
const IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db'])

interface DownloaderHint extends DownloaderMetadata {
  readonly hash?: string
}

/** Configuration for one LocalKnowledgeService instance. */
export interface LocalKnowledgeConfig {
  readonly roots: readonly ResourceRoot[]
  readonly manifestPath?: string
}

/** Options that control one recursive scan. */
export interface ScanOptions {
  readonly writeManifest?: boolean
}

/** Error raised when a registered binary resource is passed to the text reader. */
export class UnsupportedResourceReadError extends Error {
  constructor(resource: Resource) {
    super(`Resource ${resource.resourceId} (${resource.fileType}) has no phase-one text reader`)
    this.name = 'UnsupportedResourceReadError'
  }
}

/**
 * Builds and serves the local Resource Manifest without depending on a retrieval engine.
 * Raw files remain in place; only metadata and explicitly requested text are read.
 */
export class LocalKnowledgeService {
  readonly #config: LocalKnowledgeConfig
  #manifest: ResourceManifest | undefined
  #resources = new Map<string, Resource>()

  constructor(config: LocalKnowledgeConfig) {
    if (config.roots.length === 0) throw new Error('LocalKnowledgeService requires at least one resource root')
    const ids = new Set<string>()
    for (const root of config.roots) {
      if (ids.has(root.id)) throw new Error(`Duplicate resource root id: ${root.id}`)
      ids.add(root.id)
    }
    this.#config = config
  }

  /** Recursively scan all configured roots and optionally persist the resulting manifest. */
  async scan(options: ScanOptions = {}): Promise<ResourceManifest> {
    const resolvedRoots = await Promise.all(this.#config.roots.map(validateRoot))
    const resources: Resource[] = []
    for (const root of resolvedRoots) {
      const paths = await collectFiles(root.path)
      const hints = await loadDownloaderHints(root, paths)
      for (const path of paths) resources.push(await describeFile(root, path, hints.get(path)))
    }
    resources.sort((left, right) => left.path.localeCompare(right.path))
    const manifest: ResourceManifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      generator: { name: 'monash-study-agent', version: '0.1.0' },
      roots: resolvedRoots,
      resources,
      statistics: buildStatistics(resources),
    }
    this.#setManifest(manifest)
    if (options.writeManifest === true) await this.writeManifest()
    return manifest
  }

  /** Load a previously generated manifest into the local catalogue. */
  async loadManifest(path = this.#config.manifestPath): Promise<ResourceManifest> {
    if (path === undefined) throw new Error('No manifest path is configured')
    const value: unknown = JSON.parse(await readFile(resolve(path), 'utf8'))
    const manifest = parseManifest(value)
    this.#setManifest(manifest)
    return manifest
  }

  /** Persist the current manifest as stable, human-inspectable JSON. */
  async writeManifest(path = this.#config.manifestPath): Promise<void> {
    if (path === undefined) throw new Error('No manifest path is configured')
    const manifest = this.#requireManifest()
    const output = resolve(path)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  /** Return the most recent in-memory manifest. */
  getManifest(): ResourceManifest {
    return this.#requireManifest()
  }

  /** Find one resource by its deterministic id. */
  getResource(resourceId: string): Resource | undefined {
    return this.#resources.get(resourceId)
  }

  /** List resources using exact metadata filters. */
  listResources(filter: ResourceFilter = {}): readonly Resource[] {
    return this.#requireManifest().resources.filter((resource) => matchesFilter(resource, filter))
  }

  /** Read UTF-8 content for Markdown, QMD, code, data, and ordinary text resources. */
  async readText(resourceId: string): Promise<ResourceText> {
    const resource = this.#resources.get(resourceId)
    if (resource === undefined) throw new Error(`Unknown resource id: ${resourceId}`)
    if (!resource.textReadable) throw new UnsupportedResourceReadError(resource)
    return { resource, content: await readFile(resource.path, 'utf8') }
  }

  #setManifest(manifest: ResourceManifest): void {
    this.#manifest = manifest
    this.#resources = new Map(manifest.resources.map((resource) => [resource.resourceId, resource]))
  }

  #requireManifest(): ResourceManifest {
    if (this.#manifest === undefined) throw new Error('No Resource Manifest is loaded; call scan() or loadManifest() first')
    return this.#manifest
  }
}

async function validateRoot(root: ResourceRoot): Promise<ResourceRoot> {
  const path = resolve(root.path)
  const info = await stat(path)
  if (!info.isDirectory()) throw new Error(`Resource root is not a directory: ${path}`)
  return { ...root, path }
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name) || entry.name.startsWith('.')) continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  await visit(root)
  return files
}

async function loadDownloaderHints(root: ResourceRoot, paths: readonly string[]): Promise<Map<string, DownloaderHint>> {
  const hints = new Map<string, DownloaderHint>()
  const manifests = paths.filter((path) => /last sync\.json$/i.test(path))
  for (const manifestPath of manifests) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Cannot parse downloader manifest ${manifestPath}: ${reason}`)
    }
    visitDownloaderValue(parsed, (value) => {
      const localPath = stringField(value, 'local_path')
      if (localPath === undefined || localPath.length === 0) return
      const courseDirectory = dirname(manifestPath)
      const candidate = resolveDownloaderPath(root.path, courseDirectory, localPath)
      hints.set(candidate, downloaderHint(manifestPath, value))
    })
  }
  return hints
}

function resolveDownloaderPath(root: string, manifestDirectory: string, localPath: string): string {
  if (isAbsolute(localPath)) return resolve(localPath)
  const fromManifest = resolve(manifestDirectory, localPath)
  if (fromManifest.startsWith(`${root}${sep}`)) return fromManifest
  return resolve(root, localPath)
}

function visitDownloaderValue(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitDownloaderValue(item, visit)
    return
  }
  if (!isRecord(value)) return
  visit(value)
  for (const child of Object.values(value)) visitDownloaderValue(child, visit)
}

function downloaderHint(manifestPath: string, value: Record<string, unknown>): DownloaderHint {
  const optional = (key: string): Record<string, string> => {
    const item = stringField(value, key)
    return item === undefined ? {} : { [key]: item }
  }
  const fields = {
    ...optional('source_id'),
    ...optional('source_url'),
    ...optional('source_kind'),
    ...optional('mime_type'),
    ...optional('status'),
    ...optional('sha256'),
  }
  return {
    manifestPath,
    ...(fields.source_id === undefined ? {} : { sourceId: fields.source_id }),
    ...(fields.source_url === undefined ? {} : { sourceUrl: fields.source_url }),
    ...(fields.source_kind === undefined ? {} : { sourceKind: fields.source_kind }),
    ...(fields.mime_type === undefined ? {} : { mimeType: fields.mime_type }),
    ...(fields.status === undefined ? {} : { status: fields.status }),
    ...(fields.sha256 === undefined ? {} : { hash: fields.sha256 }),
  }
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined
}

async function describeFile(root: ResourceRoot, path: string, hint: DownloaderHint | undefined): Promise<Resource> {
  const info = await stat(path)
  const relativePath = relative(root.path, path)
  const extension = extname(path).toLowerCase()
  const fileType = inferFileType(extension)
  const hash = await hashFile(path)
  const downloader = hint === undefined ? undefined : withoutHash(hint)
  return {
    resourceId: resourceId(root, relativePath),
    course: inferCourse(relativePath),
    week: inferWeek(relativePath),
    title: basename(path, extension),
    source: root.source,
    resourceType: inferResourceType(relativePath),
    fileType,
    extension: extension.length === 0 ? null : extension.slice(1),
    path,
    relativePath,
    rootId: root.id,
    modifiedAt: info.mtime.toISOString(),
    sizeBytes: info.size,
    hash,
    textReadable: isTextReadable(fileType),
    ...(downloader === undefined ? {} : { downloader }),
  }
}

function withoutHash(hint: DownloaderHint): DownloaderMetadata {
  const { hash: _hash, ...metadata } = hint
  return metadata
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), new Writable({
    write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback()
    },
  }))
  return hash.digest('hex')
}

function resourceId(root: ResourceRoot, relativePath: string): string {
  return `resource_${createHash('sha256').update(`${root.source}\0${root.id}\0${relativePath}`).digest('hex').slice(0, 24)}`
}

function inferCourse(path: string): string | null {
  return path.match(/(?:^|[^A-Z0-9])([A-Z]{2,4}\d{4})(?!\d)/i)?.[1]?.toUpperCase() ?? null
}

function inferWeek(path: string): number | null {
  const match = path.match(/(?:^|[^a-z0-9])(?:week|w)\s*[-_ ]*0*(\d{1,2})(?!\d)/i)
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10)
}

function inferResourceType(path: string): ResourceType {
  const lower = path.toLowerCase()
  if (/last sync\.json$/.test(lower)) return 'manifest'
  if (/(^|[/\\])discussions?([/\\]|$)/.test(lower)) return 'discussion'
  if (/(^|[/\\])assignments?([/\\]|$)/.test(lower)) return 'assignment'
  if (/(^|[/\\])(tutorial|workshop|applied session)/.test(lower)) return 'tutorial'
  if (/(^|[/\\])lessons?([/\\]|$)/.test(lower)) return 'lesson'
  if (/(^|[/\\])general([/\\]|$)/.test(lower)) return 'course-overview'
  return 'resource'
}

function inferFileType(extension: string): ResourceFileType {
  if (extension === '.md') return 'markdown'
  if (extension === '.qmd') return 'qmd'
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  if (DATA_EXTENSIONS.has(extension)) return 'data'
  if (extension === '.pdf') return 'pdf'
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive'
  if (OFFICE_EXTENSIONS.has(extension)) return 'office'
  return 'other'
}

function isTextReadable(fileType: ResourceFileType): boolean {
  return fileType === 'markdown' || fileType === 'qmd' || fileType === 'code' || fileType === 'text' || fileType === 'data'
}

function buildStatistics(resources: readonly Resource[]): ResourceManifestStatistics {
  const byCourse: Record<string, number> = {}
  const bySource: Record<ResourceSource, number> = { local: 0, ed: 0, moodle: 0 }
  const byFileType: Record<ResourceFileType, number> = {
    markdown: 0, qmd: 0, code: 0, text: 0, data: 0, pdf: 0, archive: 0, office: 0, other: 0,
  }
  for (const resource of resources) {
    byCourse[resource.course ?? 'UNCLASSIFIED'] = (byCourse[resource.course ?? 'UNCLASSIFIED'] ?? 0) + 1
    bySource[resource.source] += 1
    byFileType[resource.fileType] += 1
  }
  return { totalResources: resources.length, byCourse, bySource, byFileType }
}

function matchesFilter(resource: Resource, filter: ResourceFilter): boolean {
  return (filter.course === undefined || resource.course === filter.course.toUpperCase())
    && (filter.week === undefined || resource.week === filter.week)
    && (filter.source === undefined || resource.source === filter.source)
    && (filter.resourceType === undefined || resource.resourceType === filter.resourceType)
    && (filter.fileType === undefined || resource.fileType === filter.fileType)
    && (filter.textReadable === undefined || resource.textReadable === filter.textReadable)
}

function parseManifest(value: unknown): ResourceManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.roots) || !Array.isArray(value.resources)) {
    throw new Error('Unsupported or invalid Resource Manifest')
  }
  return value as unknown as ResourceManifest
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
