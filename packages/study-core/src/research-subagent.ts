import type { StudentContext } from './agent-runtime.js'

/** Stable logical identity used in product results and lifecycle events. */
export const RESEARCH_SUBAGENT_NAME = 'research'

/** DSH-facing tool name. The logical name above remains provider-neutral. */
export const RESEARCH_SUBAGENT_TOOL_NAME = 'research_subagent'

/** Versioned independent prompt identity for the course research child. */
export const RESEARCH_SUBAGENT_PROMPT_VERSION = 'research-subagent-v1'

/** Maximum number of retrieval actions allowed during one Study Agent run. */
export const RESEARCH_SUBAGENT_ACTION_BUDGET = 8

/** Product-owned handoff from Main Agent to the bounded research worker. */
export interface ResearchTask {
  readonly taskId: string
  readonly objective: string
  readonly course: string
  readonly topic?: string
  readonly week?: number
  readonly studentContext?: StudentContext
}

/** One evidence-attributed statement returned by the research worker. */
export interface ResearchFinding {
  readonly content: string
  readonly evidenceIds: readonly string[]
}

/** Structured intermediate result returned to Main Agent synthesis. */
export interface ResearchResult {
  readonly taskId: string
  readonly summary: string
  readonly findings: readonly ResearchFinding[]
  readonly evidenceIds: readonly string[]
  readonly limitations: readonly string[]
}

/** Provider-neutral research capability used by future adapters and tests. */
export interface ResearchSubagent {
  research(task: ResearchTask): Promise<ResearchResult>
}

/** Validate and normalize the small first-version ResearchTask contract. */
export function validateResearchTask(task: ResearchTask): ResearchTask {
  if (task.taskId.trim().length === 0) throw new Error('ResearchTask taskId must not be empty.')
  if (task.objective.trim().length === 0) throw new Error('ResearchTask objective must not be empty.')
  if (task.course.trim().length === 0) throw new Error('ResearchTask course must not be empty.')
  if (task.topic !== undefined && task.topic.trim().length === 0) {
    throw new Error('ResearchTask topic must not be empty when provided.')
  }
  if (task.week !== undefined && (!Number.isInteger(task.week) || task.week < 0)) {
    throw new Error('ResearchTask week must be a non-negative integer.')
  }
  return {
    ...task,
    taskId: task.taskId.trim(),
    objective: task.objective.trim(),
    course: task.course.trim(),
    ...(task.topic === undefined ? {} : { topic: task.topic.trim() }),
  }
}

/** Render an explicit, self-contained child prompt from the product contract. */
export function renderResearchTaskPrompt(task: ResearchTask): string {
  const normalized = validateResearchTask(task)
  return [
    'ResearchTask JSON:',
    JSON.stringify(normalized),
    '',
    'Return only one valid JSON object matching this ResearchResult shape:',
    '{"taskId":"...","summary":"...","findings":[{"content":"...","evidenceIds":["..."]}],"evidenceIds":["..."],"limitations":[]}',
    'Every important finding must cite an evidenceId returned by search_knowledge in this run.',
    'Do not invent evidence IDs or course facts. If the materials are insufficient, state that in limitations.',
  ].join('\n')
}

/** Extract the first JSON object embedded in a model-authored research prompt. */
export function parseResearchTaskPrompt(
  prompt: string,
  fallback: { readonly taskId: string; readonly course: string },
): ResearchTask {
  const value = parseJsonObject(prompt)
  if (isRecord(value)
    && typeof value.taskId === 'string'
    && typeof value.objective === 'string'
    && typeof value.course === 'string') {
    try {
      return validateResearchTask({
        taskId: value.taskId,
        objective: value.objective,
        course: value.course,
        ...(typeof value.topic === 'string' ? { topic: value.topic } : {}),
        ...(typeof value.week === 'number' ? { week: value.week } : {}),
        ...(isRecord(value.studentContext) ? { studentContext: value.studentContext as unknown as StudentContext } : {}),
      })
    } catch {
      // The runtime still has a bounded, safe fallback below.
    }
  }
  return validateResearchTask({
    taskId: fallback.taskId,
    objective: prompt.trim(),
    course: fallback.course,
  })
}

/** Convert a child response to a contract result while filtering untrusted IDs. */
export function parseResearchResultText(
  text: string,
  task: ResearchTask,
  validEvidenceIds: ReadonlySet<string>,
): ResearchResult {
  const parsed = parseJsonObject(text)
  if (!isRecord(parsed)) return failedResearchResult(task, 'The research subagent did not return a valid structured result.')
  return sanitizeResearchResult(parsed, task, validEvidenceIds)
}

/** Filter model-provided evidence references against this run's real retrievals. */
export function sanitizeResearchResult(
  value: Record<string, unknown>,
  task: ResearchTask,
  validEvidenceIds: ReadonlySet<string>,
): ResearchResult {
  const limitations = stringArray(value.limitations)
  if (value.taskId !== task.taskId) {
    limitations.push('The research result taskId did not match the delegated task.')
  }
  const summary = typeof value.summary === 'string' && value.summary.trim().length > 0
    ? value.summary.trim()
    : 'The research subagent returned no usable summary.'
  const findings: ResearchFinding[] = []
  let rejectedEvidenceIds = false
  for (const candidate of Array.isArray(value.findings) ? value.findings : []) {
    if (!isRecord(candidate) || typeof candidate.content !== 'string' || candidate.content.trim().length === 0) continue
    const evidenceIds = filterEvidenceIds(candidate.evidenceIds, validEvidenceIds, () => { rejectedEvidenceIds = true })
    findings.push({ content: candidate.content.trim(), evidenceIds })
  }
  const evidenceIds = filterEvidenceIds(value.evidenceIds, validEvidenceIds, () => { rejectedEvidenceIds = true })
  if (rejectedEvidenceIds) limitations.push('One or more model-provided evidence IDs were not retrieved in this run and were discarded.')
  return {
    taskId: task.taskId,
    summary,
    findings,
    evidenceIds: unique([...evidenceIds, ...findings.flatMap(finding => finding.evidenceIds)]),
    limitations: unique(limitations),
  }
}

/** Safe result used when the child fails or violates the structured contract. */
export function failedResearchResult(task: ResearchTask, limitation: string): ResearchResult {
  return {
    taskId: task.taskId,
    summary: 'Research was not completed.',
    findings: [],
    evidenceIds: [],
    limitations: [limitation],
  }
}

function filterEvidenceIds(
  value: unknown,
  validEvidenceIds: ReadonlySet<string>,
  onRejected: () => void,
): string[] {
  if (!Array.isArray(value)) return []
  const accepted: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) continue
    const evidenceId = candidate.trim()
    if (!validEvidenceIds.has(evidenceId)) {
      onRejected()
      continue
    }
    accepted.push(evidenceId)
  }
  return unique(accepted)
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    const candidate = firstBalancedObject(trimmed)
    if (candidate === undefined) return undefined
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      return undefined
    }
  }
}

function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{') depth += 1
    if (character === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
