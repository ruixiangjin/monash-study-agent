import type { AgentEvent, StudyRuntimeErrorCode, StudyTurnResult } from '@monash-study/study-core'
import type { CourseSummary } from '@monash-study/dsh-integration'

export interface StudyUiMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly runId?: string
  readonly createdAt: number
}

export interface ActivityItem {
  readonly id: string
  readonly label: string
  readonly state: 'active' | 'completed' | 'failed'
}

export interface EvidenceCardModel {
  readonly id: string
  readonly resourceId?: string
  readonly title: string
  readonly course?: string
  readonly source: string
  readonly provider: string
  readonly content: string
  readonly score?: number
  readonly metadata: Readonly<Record<string, unknown>>
}

export const ACTIVITY_LABELS: Readonly<Record<AgentEvent['type'], string>> = {
  run_started: 'Starting',
  student_context_failed: 'Continuing without saved student context',
  model_started: 'Thinking',
  model_completed: 'Reasoning completed',
  answer_completed: 'Answer ready',
  memory_observation_started: 'Updating learning memory',
  memory_observation_completed: 'Learning memory updated',
  memory_observation_failed: 'Memory update unavailable',
  subagent_started: 'Researching course materials',
  subagent_completed: 'Research completed',
  subagent_failed: 'Research step unavailable',
  run_completed: 'Completed',
  run_failed: 'Run failed',
}

export function activityLabel(event: AgentEvent): string {
  return ACTIVITY_LABELS[event.type]
}

export function activityState(event: AgentEvent): ActivityItem['state'] {
  if (event.type === 'run_failed' || event.type === 'subagent_failed' || event.type === 'memory_observation_failed') return 'failed'
  if (event.type === 'run_completed' || event.type === 'answer_completed') return 'completed'
  return 'active'
}

export function toActivityItem(event: AgentEvent): ActivityItem {
  return { id: `${event.runId}:${event.type}:${event.timestamp}`, label: activityLabel(event), state: activityState(event) }
}

export function toEvidenceCards(result: StudyTurnResult): readonly EvidenceCardModel[] {
  return result.evidence.map(item => ({
    id: item.evidenceId,
    ...(item.resourceId === undefined ? {} : { resourceId: item.resourceId }),
    title: item.title,
    ...(item.course === undefined ? {} : { course: item.course }),
    source: item.sourceSystem,
    provider: item.retrievalProvider,
    content: item.content,
    ...(item.score === undefined ? {} : { score: item.score }),
    metadata: item.metadata,
  }))
}

export function errorLabel(code: StudyRuntimeErrorCode): string {
  switch (code) {
    case 'INVALID_INPUT': return 'Invalid question'
    case 'SESSION_ERROR': return 'Conversation could not be continued'
    case 'MODEL_ERROR': return 'Model returned no answer'
    case 'HARNESS_ERROR': return 'Agent runtime failed'
    case 'ABORTED': return 'Request cancelled'
    case 'CONCURRENT_RUN': return 'Another study request is running'
    case 'UNKNOWN': return 'Something went wrong'
  }
}

export function emptyCourseState(course: CourseSummary) {
  return {
    course,
    messages: [] as StudyUiMessage[],
    activity: [] as ActivityItem[],
    evidence: [] as EvidenceCardModel[],
    conversation: undefined,
    researchActions: 0,
    running: false,
    error: undefined as { code: StudyRuntimeErrorCode; message: string } | undefined,
  }
}
