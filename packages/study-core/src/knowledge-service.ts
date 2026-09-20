import type { Evidence } from '@monash-study/shared-types'

/** Query accepted by a replaceable knowledge retrieval provider. */
export interface KnowledgeQuery {
  readonly query: string
  readonly course?: string
  readonly week?: number
  readonly limit?: number
}

/** Retrieval capability consumed by StudyController, independent of LightRAG. */
export interface KnowledgeService {
  search(query: KnowledgeQuery): Promise<readonly Evidence[]>
}
