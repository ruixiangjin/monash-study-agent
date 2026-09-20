import type { KnowledgeService } from '@monash-study/study-core'

/**
 * LightRAG-facing capability seam. The provider will consume Resource Manifest
 * entries and text readers without owning or mutating raw course files.
 */
export interface LightRAGAdapter extends KnowledgeService {
  syncResources(resourceIds?: readonly string[]): Promise<void>
  removeResources(resourceIds: readonly string[]): Promise<void>
}
