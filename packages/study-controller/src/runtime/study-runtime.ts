import {
  LightRAGKnowledgeService,
  loadRuntimeConfig,
} from '@monash-study/knowledge-service'
import type { KnowledgeService } from '@monash-study/study-core'

export interface StudyRuntime {
  readonly knowledgeService: KnowledgeService
}

export interface StudyRuntimeOptions {
  readonly configPath?: string
  readonly applicationRoot?: string
  readonly knowledgeService?: KnowledgeService
}

/** Application composition root for product-owned runtime capabilities. */
export function createStudyRuntime(options: StudyRuntimeOptions = {}): StudyRuntime {
  if (options.knowledgeService !== undefined) {
    return { knowledgeService: options.knowledgeService }
  }

  const runtimeConfig = loadRuntimeConfig({
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.applicationRoot === undefined ? {} : { applicationRoot: options.applicationRoot }),
  })
  if (runtimeConfig.knowledgeProvider !== 'lightrag') {
    throw new Error(`Unsupported knowledge provider: ${runtimeConfig.knowledgeProvider}`)
  }
  return {
    knowledgeService: new LightRAGKnowledgeService({ runtimeConfig }),
  }
}
