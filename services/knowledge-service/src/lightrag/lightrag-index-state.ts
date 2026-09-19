import type { NormalizedDocument } from '../../../../packages/shared-types/src/normalized-document.js'

/** Metadata for the version of a document that was successfully indexed. */
export interface LightRAGIndexState {
  readonly documentId: string
  readonly resourceId: string
  readonly course: string | null

  readonly sourceHash: string
  readonly normalizedHash: string
  readonly normalizationVersion: string
  readonly sourcePath: string

  readonly indexedAt: string
}

/** Return true when the persisted LightRAG index represents this document. */
export function isDocumentIndexCurrent(
  document: NormalizedDocument,
  state: LightRAGIndexState,
): boolean {
  return document.documentId === state.documentId
    && document.resourceId === state.resourceId
    && document.course === state.course
    && document.sourceHash === state.sourceHash
    && document.normalizedHash === state.normalizedHash
    && document.normalizationVersion === state.normalizationVersion
    && document.sourcePath === state.sourcePath
}
