import type {
  NormalizedContentType,
  NormalizedLocator,
} from '../../../../packages/shared-types/src/normalized-document.js'
import type { Resource } from '../../../../packages/shared-types/src/resource.js'

/** Handler output completed with Resource metadata by NormalizationService. */
export interface NormalizedDocumentDraft {
  readonly documentId: string
  readonly title: string
  readonly contentType: NormalizedContentType
  readonly text: string
  readonly locator: NormalizedLocator
}

/** One deterministic Resource-to-document conversion strategy. */
export interface ResourceNormalizer {
  readonly id: string
  readonly version: string
  supports(resource: Resource): boolean
  normalize(resource: Resource): Promise<readonly NormalizedDocumentDraft[]>
}

/** Create the stable one-document id used by file-based normalizers. */
export function documentIdForResource(resource: Resource): string {
  return `document_${resource.resourceId.slice('resource_'.length)}`
}
