import type {
  KnowledgeService,
  StudyDecisionService,
  StudyModelService,
  StudyTool,
} from '@monash-study/study-core'
import type { StudyState } from '@monash-study/shared-types'

/** Replaceable services coordinated by the future StudyController workflow. */
export interface StudyControllerDependencies {
  readonly decision: StudyDecisionService
  readonly knowledge: KnowledgeService
  readonly model: StudyModelService
  readonly tools: ReadonlyMap<string, StudyTool>
}

/** Controller capability exposed to DSH without binding provider implementations. */
export interface StudyController {
  run(query: string): Promise<Readonly<StudyState>>
}
