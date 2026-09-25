import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type {
  NormalizedContentType,
  NormalizedDocument,
  NormalizedLocator,
  ResourceSource,
} from '@monash-study/shared-types'

export interface NormalizedDocumentFilter {
  readonly course?: string
  readonly source?: ResourceSource
  readonly resourceId?: string
}

export interface NormalizedDocumentLoaderOptions {
  readonly normalizedRoot?: string
}

/** Reads persisted NormalizedDocument JSON without rerunning normalization. */
export class NormalizedDocumentLoader {
  readonly #normalizedRoot: string

  constructor(options: NormalizedDocumentLoaderOptions = {}) {
    if (options.normalizedRoot === undefined) {
      throw new Error('NormalizedDocumentLoader requires an explicit normalizedRoot')
    }
    this.#normalizedRoot = resolve(options.normalizedRoot)
  }

  /** Load all persisted documents, optionally applying exact metadata filters. */
  async list(filter: NormalizedDocumentFilter = {}): Promise<readonly NormalizedDocument[]> {
    const documents: NormalizedDocument[] = []
    for (const filePath of await this.#jsonFiles()) {
      const document = await this.#readDocument(filePath)
      if (matchesFilter(document, filter)) documents.push(document)
    }
    return documents.sort(compareDocuments)
  }

  /** Find one persisted document by its stable document id. */
  async get(documentId: string): Promise<NormalizedDocument | undefined> {
    for (const filePath of await this.#jsonFiles()) {
      const document = await this.#readDocument(filePath)
      if (document.documentId === documentId) return document
    }
    return undefined
  }

  async #jsonFiles(): Promise<readonly string[]> {
    const files: string[] = []
    let courseEntries
    try {
      courseEntries = await readdir(this.#normalizedRoot, { withFileTypes: true })
    } catch (error) {
      throw new Error(`Cannot scan normalized document root ${this.#normalizedRoot}: ${errorMessage(error)}`)
    }

    for (const courseEntry of courseEntries) {
      if (!courseEntry.isDirectory() || courseEntry.name.startsWith('.')) continue
      const coursePath = join(this.#normalizedRoot, courseEntry.name)
      let sourceEntries
      try {
        sourceEntries = await readdir(coursePath, { withFileTypes: true })
      } catch (error) {
        throw new Error(`Cannot scan normalized course directory ${coursePath}: ${errorMessage(error)}`)
      }
      for (const sourceEntry of sourceEntries) {
        if (!sourceEntry.isDirectory() || sourceEntry.name.startsWith('.')) continue
        const sourcePath = join(coursePath, sourceEntry.name)
        let documentEntries
        try {
          documentEntries = await readdir(sourcePath, { withFileTypes: true })
        } catch (error) {
          throw new Error(`Cannot scan normalized source directory ${sourcePath}: ${errorMessage(error)}`)
        }
        for (const documentEntry of documentEntries) {
          if (documentEntry.isFile() && documentEntry.name.endsWith('.json')) {
            files.push(join(sourcePath, documentEntry.name))
          }
        }
      }
    }
    return files.sort((left, right) => left.localeCompare(right))
  }

  async #readDocument(filePath: string): Promise<NormalizedDocument> {
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      throw new Error(`Cannot read NormalizedDocument JSON ${filePath}: ${errorMessage(error)}`)
    }

    let value: unknown
    try {
      value = JSON.parse(raw) as unknown
    } catch (error) {
      throw new Error(`Malformed NormalizedDocument JSON ${filePath}: ${errorMessage(error)}`)
    }
    if (!isNormalizedDocument(value)) {
      throw new Error(`Invalid NormalizedDocument JSON ${filePath}: missing or invalid required fields`)
    }
    return value
  }
}

function matchesFilter(document: NormalizedDocument, filter: NormalizedDocumentFilter): boolean {
  return (filter.course === undefined || document.course === filter.course)
    && (filter.source === undefined || document.source === filter.source)
    && (filter.resourceId === undefined || document.resourceId === filter.resourceId)
}

function compareDocuments(left: NormalizedDocument, right: NormalizedDocument): number {
  return compareNullable(left.course, right.course)
    || left.source.localeCompare(right.source)
    || left.documentId.localeCompare(right.documentId)
}

function compareNullable(left: string | null, right: string | null): number {
  return (left ?? '').localeCompare(right ?? '')
}

function isNormalizedDocument(value: unknown): value is NormalizedDocument {
  if (!isRecord(value)
    || typeof value.documentId !== 'string'
    || typeof value.resourceId !== 'string'
    || typeof value.sourceHash !== 'string'
    || typeof value.title !== 'string'
    || (value.course !== null && typeof value.course !== 'string')
    || (value.week !== null && (typeof value.week !== 'number' || !Number.isFinite(value.week)))
    || !isResourceSource(value.source)
    || !isNormalizedContentType(value.contentType)
    || typeof value.text !== 'string'
    || typeof value.sourcePath !== 'string'
    || !isLocator(value.locator)
    || typeof value.normalizationVersion !== 'string'
    || typeof value.normalizedHash !== 'string') {
    return false
  }
  return true
}

function isResourceSource(value: unknown): value is ResourceSource {
  return value === 'local' || value === 'ed' || value === 'moodle'
}

function isNormalizedContentType(value: unknown): value is NormalizedContentType {
  return value === 'code'
    || value === 'document'
    || value === 'forum-thread'
    || value === 'markdown'
    || value === 'table'
    || value === 'text'
}

function isLocator(value: unknown): value is NormalizedLocator {
  return isRecord(value)
    && (value.kind === 'file' || value.kind === 'forum-thread' || value.kind === 'document')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
