import { readFile } from 'node:fs/promises'

import type { Resource } from '../../../../packages/shared-types/src/resource.js'
import type {
  NormalizedDocumentDraft,
  ResourceNormalizer,
} from './resource-normalizer.js'

interface EdMessage {
  readonly id: string
  readonly author: string
  readonly role: string
  readonly publishedAt: string | null
  readonly content: string
  readonly images: readonly string[]
  readonly firstSeenTag: number | null
  readonly lastSeenTag: number | null
  readonly lastChangedTag: number | null
}

interface EdAnswer extends EdMessage {
  readonly accepted: boolean
  readonly comments: readonly EdMessage[]
}

interface EdThread extends EdMessage {
  readonly number: number | null
  readonly title: string
  readonly category: string
  readonly url: string | null
  readonly comments: readonly EdMessage[]
  readonly answers: readonly EdAnswer[]
}

/** Splits one Ed downloader Discussions JSON file into one document per thread. */
export class ForumNormalizer implements ResourceNormalizer {
  readonly id = 'ed-forum'
  readonly version = '1'

  supports(resource: Resource): boolean {
    return resource.source === 'ed'
      && resource.resourceType === 'discussion'
      && resource.extension === 'json'
      && / - Discussions\.json$/i.test(resource.path)
  }

  async normalize(resource: Resource): Promise<readonly NormalizedDocumentDraft[]> {
    const value: unknown = JSON.parse(await readFile(resource.path, 'utf8'))
    if (!isRecord(value) || !Array.isArray(value.threads)) {
      throw new Error(`Ed discussion resource has no threads array: ${resource.path}`)
    }
    return value.threads.map((thread, index) => {
      const parsed = parseThread(thread, index)
      return {
        documentId: threadDocumentId(resource.course, parsed.id),
        title: parsed.title,
        contentType: 'forum-thread' as const,
        text: renderThread(parsed),
        locator: {
          kind: 'forum-thread' as const,
          threadId: parsed.id,
          ...(parsed.number === null ? {} : { threadNumber: parsed.number }),
          ...(parsed.url === null ? {} : { sourceUrl: parsed.url }),
          metadata: {
            category: parsed.category,
            author: parsed.author,
            authorRole: parsed.role,
            publishedAt: parsed.publishedAt,
            acceptedAnswerCount: parsed.answers.filter((answer) => answer.accepted).length,
            lastChangedTag: parsed.lastChangedTag,
          },
        },
      }
    })
  }
}

function parseThread(value: unknown, index: number): EdThread {
  if (!isRecord(value)) throw new Error(`Ed thread at index ${index} is not an object`)
  const base = parseMessage(value, `thread at index ${index}`)
  return {
    ...base,
    number: optionalNumber(value.number),
    title: requiredString(value.title, `thread ${base.id} title`),
    category: optionalString(value.category) ?? 'Uncategorised',
    url: optionalString(value.url),
    comments: parseArray(value.comments, (item, commentIndex) => parseMessage(item, `thread ${base.id} comment ${commentIndex}`)),
    answers: parseArray(value.answers, (item, answerIndex) => parseAnswer(item, base.id, answerIndex)),
  }
}

function parseAnswer(value: unknown, threadId: string, index: number): EdAnswer {
  if (!isRecord(value)) throw new Error(`Answer ${index} in thread ${threadId} is not an object`)
  const base = parseMessage(value, `thread ${threadId} answer ${index}`)
  return {
    ...base,
    accepted: value.accepted === true,
    comments: parseArray(value.comments, (item, commentIndex) => parseMessage(item, `answer ${base.id} comment ${commentIndex}`)),
  }
}

function parseMessage(value: unknown, context: string): EdMessage {
  if (!isRecord(value)) throw new Error(`Ed ${context} is not an object`)
  return {
    id: requiredString(value.id, `${context} id`),
    author: optionalString(value.author) ?? 'Unknown author',
    role: optionalString(value.role) ?? '',
    publishedAt: optionalString(value.publishedAt),
    content: optionalString(value.content) ?? '',
    images: parseArray(value.images, (item) => requiredString(item, `${context} image URL`)),
    firstSeenTag: optionalNumber(value.first_seen_tag),
    lastSeenTag: optionalNumber(value.last_seen_tag),
    lastChangedTag: optionalNumber(value.last_changed_tag),
  }
}

function renderThread(thread: EdThread): string {
  const lines = [
    `# ${thread.title}`,
    '',
    `- Thread ID: ${thread.id}`,
    ...(thread.number === null ? [] : [`- Thread number: ${thread.number}`]),
    `- Category: ${thread.category}`,
    `- Author: ${renderAuthor(thread)}`,
    ...(thread.publishedAt === null ? [] : [`- Created: ${thread.publishedAt}`]),
    ...(thread.lastChangedTag === null ? [] : [`- Last changed sync tag: ${thread.lastChangedTag}`]),
    ...(thread.url === null ? [] : [`- Source URL: ${thread.url}`]),
    '',
    '## Original Post',
    '',
    thread.content || '_No text content._',
    ...renderImages(thread.images),
  ]
  if (thread.comments.length > 0) {
    lines.push('', '## Replies to Original Post')
    for (const comment of thread.comments) lines.push(...renderMessage(comment, 'Reply'))
  }
  if (thread.answers.length > 0) {
    lines.push('', '## Answers')
    for (const answer of thread.answers) {
      const label = answer.accepted ? 'Accepted Answer' : 'Answer'
      lines.push(...renderMessage(answer, label))
      for (const comment of answer.comments) lines.push(...renderMessage(comment, 'Reply to Answer', 4))
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function renderMessage(message: EdMessage, label: string, headingLevel = 3): string[] {
  const heading = '#'.repeat(headingLevel)
  return [
    '',
    `${heading} ${label} — ${renderAuthor(message)}`,
    '',
    ...(message.publishedAt === null ? [] : [`Published: ${message.publishedAt}`, '']),
    message.content || '_No text content._',
    ...renderImages(message.images),
  ]
}

function renderImages(images: readonly string[]): string[] {
  if (images.length === 0) return []
  return ['', 'Images:', ...images.map((image) => `- ${image}`)]
}

function renderAuthor(message: Pick<EdMessage, 'author' | 'role'>): string {
  return message.role.length === 0 ? message.author : `${message.author} (${message.role})`
}

function threadDocumentId(course: string | null, threadId: string): string {
  const coursePart = (course ?? 'unclassified').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const threadPart = threadId.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return `forum-ed-${coursePart}-${threadPart}`
}

function parseArray<T>(value: unknown, parse: (item: unknown, index: number) => T): T[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Expected an array or null')
  return value.map(parse)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Expected ${field} to be a non-empty string`)
  return value
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
