import type { StudyDecisionService } from '../../study-core/src/decision-service.js'
import type { KnowledgeService } from '../../study-core/src/knowledge-service.js'
import type { StudyModelService } from '../../study-core/src/models/model-service.js'
import type { StudyTool } from '../../study-core/src/tools/study-tool.js'
import type { StudyState } from '../../shared-types/src/study.js'

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
