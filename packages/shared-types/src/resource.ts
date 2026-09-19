/** Origin systems represented by the unified resource model. */
export type ResourceSource = 'local' | 'ed' | 'moodle'

/** Stable categories used to select resource readers and future normalisers. */
export type ResourceFileType =
  | 'markdown'
  | 'qmd'
  | 'code'
  | 'text'
  | 'data'
  | 'pdf'
  | 'archive'
  | 'office'
  | 'other'

/** Course-facing roles inferred from paths and downloader metadata. */
export type ResourceType =
  | 'assignment'
  | 'course-overview'
  | 'discussion'
  | 'lesson'
  | 'manifest'
  | 'resource'
  | 'tutorial'

/** One configured directory scanned by LocalKnowledgeService. */
export interface ResourceRoot {
  readonly id: string
  readonly source: ResourceSource
  readonly path: string
}

/** Optional facts retained from an Ed or Moodle downloader manifest. */
export interface DownloaderMetadata {
  readonly manifestPath: string
  readonly sourceId?: string
  readonly sourceUrl?: string
  readonly sourceKind?: string
  readonly mimeType?: string
  readonly status?: string
}

/** Unified metadata for one file in a configured knowledge root. */
export interface Resource {
  readonly resourceId: string
  readonly course: string | null
  readonly week: number | null
  readonly title: string
  readonly source: ResourceSource
  readonly resourceType: ResourceType
  readonly fileType: ResourceFileType
  readonly extension: string | null
  readonly path: string
  readonly relativePath: string
  readonly rootId: string
  readonly modifiedAt: string
  readonly sizeBytes: number
  readonly hash: string
  readonly textReadable: boolean
  readonly downloader?: DownloaderMetadata
}

/** Counts included with a manifest for inspection without loading every item. */
export interface ResourceManifestStatistics {
  readonly totalResources: number
  readonly byCourse: Readonly<Record<string, number>>
  readonly bySource: Readonly<Record<ResourceSource, number>>
  readonly byFileType: Readonly<Record<ResourceFileType, number>>
}

/** Versioned snapshot of every resource visible in configured roots. */
export interface ResourceManifest {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly generator: {
    readonly name: 'monash-study-agent'
    readonly version: string
  }
  readonly roots: readonly ResourceRoot[]
  readonly resources: readonly Resource[]
  readonly statistics: ResourceManifestStatistics
}

/** Filters supported by the local manifest catalogue. */
export interface ResourceFilter {
  readonly course?: string
  readonly week?: number
  readonly source?: ResourceSource
  readonly resourceType?: ResourceType
  readonly fileType?: ResourceFileType
  readonly textReadable?: boolean
}

/** Text returned for a resource while retaining its metadata identity. */
export interface ResourceText {
  readonly resource: Resource
  readonly content: string
}
