import type { Evidence } from '@monash-study/shared-types'
import {
  failedResearchResult,
  parseResearchResultText,
  parseResearchTaskPrompt,
  RESEARCH_SUBAGENT_NAME,
  RESEARCH_SUBAGENT_TOOL_NAME,
  type ResearchResult,
  type ResearchTask,
} from '@monash-study/study-core'

interface ResearchExecution {
  readonly childId: string
  readonly task: ResearchTask
  readonly result?: ResearchResult
  readonly status: 'completed' | 'failed'
}

export interface ResearchExecutionSnapshot {
  readonly executions: readonly ResearchExecution[]
  readonly subagentsUsed: readonly string[]
}

/**
 * Adapt DSH's session-tree notifications into the product ResearchResult
 * boundary. The adapter trusts neither child text nor child evidence IDs:
 * only IDs already collected by the parent StudyToolBridge survive.
 */
export function collectResearchExecutions(input: {
  readonly runId: string
  readonly rootSessionId: string
  readonly course?: string
  readonly events: readonly unknown[]
  readonly notifications: readonly unknown[]
  readonly evidence: readonly Evidence[]
}): ResearchExecutionSnapshot {
  const validEvidenceIds = new Set(input.evidence.map(item => item.evidenceId))
  const fallbackCourse = input.course?.trim() || 'unknown-course'
  const executions: ResearchExecution[] = []
  const pending: ResearchTask[] = []
  let taskIndex = 0

  const fallbackTask = (prompt?: string): ResearchTask => {
    taskIndex += 1
    return parseResearchTaskPrompt(prompt ?? 'Research the delegated course question.', {
      taskId: `${RESEARCH_SUBAGENT_NAME}-${input.runId}-${taskIndex}`,
      course: fallbackCourse,
    })
  }

  // The SDK notification stream preserves the root tool-call → child-start
  // ordering, which gives us a stable parent/child handoff without relying on
  // provider-specific session ids in the product contract.
  for (const notification of input.notifications) {
    const record = asRecord(notification)
    const method = record?.method
    const params = record?.params
    if (method === 'session.event' && isRootSessionEvent(params, input.rootSessionId)) {
      const event = asRecord(asRecord(params)?.event)
      if (event?.type === 'tool/call') {
        const data = asRecord(event.data)
        if (data?.name === RESEARCH_SUBAGENT_TOOL_NAME) {
          pending.push(taskFromToolCall(data, fallbackTask))
        }
      }
      continue
    }
    if (method === 'subagent.started') {
      const started = asRecord(params)
      if (started?.parentSessionId !== input.rootSessionId || typeof started.childSessionId !== 'string') continue
      executions.push({ childId: started.childSessionId, task: pending.shift() ?? fallbackTask(), status: 'failed' })
      continue
    }
    if (method === 'subagent.finished') {
      const finished = asRecord(params)
      if (finished?.parentSessionId !== input.rootSessionId || typeof finished.childSessionId !== 'string') continue
      const index = executions.findIndex(execution => execution.childId === finished.childSessionId)
      if (index < 0) continue
      const prior = executions[index]
      if (prior === undefined) continue
      if (finished.stopReason !== 'completed' || finished.status !== 'ok') {
        executions[index] = {
          ...prior,
          status: 'failed',
          result: failedResearchResult(prior.task, 'The Research Subagent did not complete successfully.'),
        }
      } else {
        const text = contentText(finished.lastAssistantMessage)
        executions[index] = {
          ...prior,
          status: 'completed',
          result: parseResearchResultText(text, prior.task, validEvidenceIds),
        }
      }
    }
  }

  // Unit/injected Harness drivers may expose root events without the SDK
  // notification wrapper. Keep the adapter useful for those boundaries while
  // never claiming a subagent ran unless a real child-start notification exists.
  if (input.notifications.length === 0) {
    const calls = input.events
      .map(asRecord)
      .filter(event => event?.type === 'tool/call')
      .map(event => asRecord(event?.data))
      .filter((data): data is Record<string, unknown> => data?.name === RESEARCH_SUBAGENT_TOOL_NAME)
    for (const call of calls) pending.push(taskFromToolCall(call, fallbackTask))
  }

  return {
    executions,
    subagentsUsed: executions.length === 0 ? [] : [RESEARCH_SUBAGENT_NAME],
  }
}

function taskFromToolCall(
  data: Record<string, unknown>,
  fallback: (prompt?: string) => ResearchTask,
): ResearchTask {
  const rawArguments = data.arguments
  if (typeof rawArguments !== 'string') return fallback()
  try {
    const args = JSON.parse(rawArguments) as unknown
    const prompt = asRecord(args)?.prompt
    return typeof prompt === 'string' ? fallback(prompt) : fallback()
  } catch {
    return fallback()
  }
}

function isRootSessionEvent(value: unknown, rootSessionId: string): boolean {
  const params = asRecord(value)
  return params?.sessionId === rootSessionId && asRecord(params.event) !== undefined
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map(block => asRecord(block))
    .filter((block): block is Record<string, unknown> => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
