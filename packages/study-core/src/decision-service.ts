import type { Evidence, StudyIntent } from '@monash-study/shared-types'

/** Decisions required by the controller, implemented later by TypeSafe JEV. */
export interface StudyDecisionService {
  classifyIntent(query: string): Promise<StudyIntent>
  requiresFreshData(query: string): Promise<boolean>
  scoreEvidence(query: string, evidence: readonly Evidence[]): Promise<readonly number[]>
  isEvidenceSufficient(query: string, evidence: readonly Evidence[]): Promise<boolean>
}
