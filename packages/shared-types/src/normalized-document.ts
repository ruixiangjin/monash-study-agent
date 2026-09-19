import type { ResourceSource } from './resource.js'

/** Content categories presented to the future LightRAG ingestion layer. */
export type NormalizedContentType =
  | 'code'
  | 'document'
  | 'forum-thread'
  | 'markdown'
  | 'table'
  | 'text'

/** A page region retained from Docling's document model. */
export interface NormalizedRegion {
  readonly kind: 'picture' | 'table'
  readonly page: number
  readonly reference?: string
  readonly bbox?: {
    readonly left: number
    readonly top: number
    readonly right: number
    readonly bottom: number
  }
}

/** Location metadata connecting normalized text to its source. */
export interface NormalizedLocator {
  readonly kind: 'file' | 'forum-thread' | 'document'
  readonly sourceUrl?: string
  readonly threadId?: string
  readonly threadNumber?: number
  readonly pageNumbers?: readonly number[]
  readonly regions?: readonly NormalizedRegion[]
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>
}

/**
 * Stable text representation produced from one Resource.
 * A Resource may produce several documents, while every document retains its
 * Resource id, source hash, and original absolute path.
 */
export interface NormalizedDocument {
  readonly documentId: string
  readonly resourceId: string
  readonly sourceHash: string
  readonly title: string
  readonly course: string | null
  readonly week: number | null
  readonly source: ResourceSource
  readonly contentType: NormalizedContentType
  readonly text: string
  readonly sourcePath: string
  readonly locator: NormalizedLocator
  readonly normalizationVersion: string
  readonly normalizedHash: string
}
