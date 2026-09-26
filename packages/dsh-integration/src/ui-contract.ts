import type { AgentEvent, StudyConversationRef, StudyRuntimeErrorCode, StudyTurnResult } from '@monash-study/study-core'

/** Stable course summary exposed to the DSH Study page. */
export interface CourseSummary {
  readonly courseCode: string
  readonly resourceCount: number
}

/** One course-owned entry pointing at the authoritative DSH Session. */
export interface CourseConversationSummary {
  readonly sessionId: string
  readonly title: string
  readonly updatedAt: number
}

/** Text message projected from persisted DSH Session history. */
export interface CourseConversationMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly createdAt: number
}

/** Rehydrated chat view for one DSH-owned conversation. */
export interface CourseConversationHistory {
  readonly conversation: { readonly sessionId: string; readonly conversationId: string }
  readonly title: string
  readonly updatedAt: number
  readonly messages: readonly CourseConversationMessage[]
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
