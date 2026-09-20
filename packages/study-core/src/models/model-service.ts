import type { Evidence, StudyState } from '@monash-study/shared-types'

/** Input to a language model provider after retrieval and tool execution. */
export interface StudyGenerationRequest {
  readonly query: string
  readonly state: Readonly<StudyState>
  readonly evidence: readonly Evidence[]
  readonly task: 'rewrite' | 'compress' | 'answer' | 'plan'
}

/** Language capability consumed by the controller, independent of DeepSeek. */
export interface StudyModelService {
  generate(request: StudyGenerationRequest): Promise<string>
}
