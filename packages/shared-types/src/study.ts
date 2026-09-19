import type { Evidence } from './evidence.js'

/** Intent categories selected by the future JEV decision provider. */
export type StudyIntent =
  | 'course_knowledge'
  | 'live_course_info'
  | 'resource_lookup'
  | 'course_sync'
  | 'general'

/** Mutable workflow facts coordinated by StudyController implementations. */
export interface StudyState {
  query: string
  course: string | null
  intent: StudyIntent | null
  needsFreshData: boolean | null
  complexity: number | null
  retrievalQueries: string[]
  evidence: Evidence[]
  toolsUsed: string[]
}
