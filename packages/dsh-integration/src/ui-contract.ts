import type { AgentEvent, StudyConversationRef, StudyRuntimeErrorCode, StudyTurnResult } from '@monash-study/study-core'

/** Stable course summary exposed to the DSH Study page. */
export interface CourseSummary {
  readonly courseCode: string
  readonly resourceCount: number
}

/** Wire input for one UI-originated Study Agent turn. */
export interface MonashStudyTurnRequest {
  readonly runId: string
  readonly query: string
  readonly courseCode: string
  readonly conversation?: StudyConversationRef
}

/** Successful or safely classified failed UI turn response. */
export type MonashStudyTurnResponse =
  | { readonly status: 'completed'; readonly result: StudyTurnResult }
  | { readonly status: 'failed'; readonly errorCode: StudyRuntimeErrorCode; readonly message: string }

/** Product-owned event stream item; raw Harness payloads never cross the UI boundary. */
export type MonashStudyAgentEvent = AgentEvent
