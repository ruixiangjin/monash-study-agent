import type { CourseConversationMessage } from './ui-contract.js'

const SESSION_ID_PREFIX = 'monash-study-'

/** Build a DSH-owned Session identity that can be grouped by course without a second store. */
export function createCourseSessionId(courseCode: string, nonce: string): string {
  return `${SESSION_ID_PREFIX}${courseCode.toLowerCase()}-${nonce}`
}

/** Recover a course marker embedded in a DSH Session id. */
export function courseCodeFromSessionId(sessionId: string, courseCodes: readonly string[]): string | undefined {
  for (const courseCode of courseCodes) {
    if (sessionId.startsWith(`${SESSION_ID_PREFIX}${courseCode.toLowerCase()}-`)) return courseCode
  }
  return undefined
}

/** Read the durable course context from the Main Agent prompt stored in a Session log. */
export function courseCodeFromSessionEvents(events: readonly unknown[], courseCodes: readonly string[]): string | undefined {
  for (const event of events) {
    if (!isRecord(event) || event['type'] !== 'user/message' || !isRecord(event['data'])) continue
    const text = textOfContent(event['data']['content'])
    const match = /^Current runtime context:\s*\ncourseCode:\s*([A-Z0-9_-]+)(?:\n|$)/u.exec(text)
    if (match === null) continue
    const courseCode = courseCodes.find(code => code === match[1])
    if (courseCode !== undefined) return courseCode
  }
  return undefined
}

/** Project persisted DSH user and assistant messages into the Monash chat view. */
export function projectCourseConversationMessages(
  sessionId: string,
  events: readonly unknown[],
): readonly CourseConversationMessage[] {
  const messages: CourseConversationMessage[] = []
  for (const event of events) {
    if (!isRecord(event) || typeof event['seq'] !== 'number' || typeof event['time'] !== 'number') continue
    const type = event['type']
    const data = event['data']
    if (type === 'user/message' && isRecord(data)) {
      const text = textOfContent(data['content'])
      if (text.trim().length === 0) continue
      messages.push({
        id: `${sessionId}:${event['seq']}`,
        role: 'user',
        content: queryOfStudyPrompt(text) ?? text,
        createdAt: event['time'],
      })
    } else if (type === 'assistant/message' && isRecord(data) && isRecord(data['message'])) {
      const text = textOfContent(data['message']['content'])
      if (text.trim().length === 0) continue
      messages.push({
        id: `${sessionId}:${event['seq']}`,
        role: 'assistant',
        content: text,
        createdAt: event['time'],
      })
    }
  }
  return messages
}

/** Prefer the durable DSH title, then fall back to the first stored user question. */
export function titleFromSessionEvents(events: readonly unknown[]): string | undefined {
  let title: string | undefined
  let firstQuestion: string | undefined
  for (const event of events) {
    if (!isRecord(event)) continue
    if (event['type'] === 'session/title' && isRecord(event['data']) && typeof event['data']['title'] === 'string') {
      title = event['data']['title'].trim() || title
    }
    if (firstQuestion !== undefined || event['type'] !== 'user/message' || !isRecord(event['data'])) continue
    const text = textOfContent(event['data']['content'])
    firstQuestion = queryOfStudyPrompt(text) ?? text
  }
  const value = title ?? firstQuestion
  if (value === undefined || value.trim().length === 0) return undefined
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length <= 64 ? normalized : `${normalized.slice(0, 63).trimEnd()}…`
}

/** Extract the actual learner question from a persisted Monash prompt wrapper. */
function queryOfStudyPrompt(text: string): string | undefined {
  const match = /^Current runtime context:[\s\S]*?\n\nUser query:\n([\s\S]*)$/u.exec(text)
  return match?.[1]?.trim() || undefined
}

function textOfContent(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .filter(isRecord)
    .filter(block => block['type'] === 'text' && typeof block['text'] === 'string')
    .map(block => block['text'] as string)
    .join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
