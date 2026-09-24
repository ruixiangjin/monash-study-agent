import { createElement, useEffect, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  IconCheckOutline16,
  IconListPenOutline16,
  IconSearchOutline16,
  MarkdownText,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@monash-study/dsh-integration/remote'
import monashStudyRemote from '@monash-study/dsh-integration/remote'
import type { CourseSummary, MonashStudyTurnResponse } from '@monash-study/dsh-integration'
import type { AgentEvent, StudyConversationRef, StudyRuntimeErrorCode, StudyTurnResult } from '@monash-study/study-core'
import {
  activityState,
  emptyCourseState,
  errorLabel,
  toActivityItem,
  toEvidenceCards,
  type ActivityItem,
  type EvidenceCardModel,
  type StudyUiMessage,
} from './presenters.js'
import { inject, registerMonashStudySlots } from './registration.js'

const PANEL_ID = 'monash-study' as MainPanelId
const MARKDOWN_LABELS: MarkdownLabels = {
  code: { copyLabel: 'Copy', copiedLabel: 'Copied' },
  footnotes: 'Footnotes',
}

interface CourseState {
  readonly course: CourseSummary
  readonly messages: readonly StudyUiMessage[]
  readonly activity: readonly ActivityItem[]
  readonly evidence: readonly EvidenceCardModel[]
  readonly conversation: StudyConversationRef | undefined
  readonly researchActions: number
  readonly running: boolean
  readonly error: { readonly code: StudyRuntimeErrorCode; readonly message: string } | undefined
}

interface StudyClient {
  listCourses(signal?: AbortSignal): Promise<readonly CourseSummary[]>
  runTurn(
    request: { runId: string; query: string; courseCode: string; conversation?: StudyConversationRef },
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<MonashStudyTurnResponse>
}

class RemoteStudyClient implements StudyClient {
  constructor(private readonly remote: ClientRemote['monashStudy']) {}

  async listCourses(signal?: AbortSignal): Promise<readonly CourseSummary[]> {
    const response = await this.remote.listCourses(signal)
    if (!response.ok) throw response.error
    return response.value
  }

  async runTurn(
    request: { runId: string; query: string; courseCode: string; conversation?: StudyConversationRef },
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<MonashStudyTurnResponse> {
    const events = (async (): Promise<void> => {
      for await (const event of this.remote.runEvents(request.runId, signal)) onEvent(event)
    })()
    try {
      const response = await this.remote.runTurn(request, signal)
      await events
      if (!response.ok) return { status: 'failed', errorCode: 'UNKNOWN', message: response.error.message }
      return response.value
    } finally {
      await events.catch(() => {})
    }
  }
}

export { inject }

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(monashStudyRemote)
  const client = new RemoteStudyClient(ctx.remote.monashStudy)
  const style = document.createElement('style')
  style.dataset.plugin = '@monash-study/dsh-ui-plugin'
  style.textContent = STYLES
  document.head.append(style)
  const disposeSlots = registerMonashStudySlots(
    ctx,
    ({ size }: { readonly size?: number }) => createElement(IconListPenOutline16, { size }),
    (props: PropsRuntime<'main'>) => createElement(MonashStudyPage, { ...props, client }),
  )
  return async () => {
    disposeSlots()
    style.remove()
    await disposeRemote()
  }
}

function MonashStudyPage({ client }: { client: StudyClient } & PropsRuntime<'main'>) {
  const [courses, setCourses] = useState<readonly CourseSummary[]>([])
  const [selectedCourse, setSelectedCourse] = useState<string | undefined>(undefined)
  const [courseStates, setCourseStates] = useState<Readonly<Record<string, CourseState>>>({})
  const [loadingCourses, setLoadingCourses] = useState(true)
  const [courseError, setCourseError] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void client.listCourses(controller.signal).then(next => {
      setCourses(next)
      setSelectedCourse(current => current ?? next[0]?.courseCode)
      setCourseStates(Object.fromEntries(next.map(course => [course.courseCode, emptyCourseState(course)])))
    }).catch(error => {
      if (!controller.signal.aborted) setCourseError(error instanceof Error ? error.message : 'Courses could not be loaded')
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingCourses(false)
    })
    return () => { controller.abort() }
  }, [client])

  const current = selectedCourse === undefined ? undefined : courseStates[selectedCourse]
  const running = Object.values(courseStates).some(state => state.running)
  const selectCourse = (course: CourseSummary): void => {
    setSelectedCourse(course.courseCode)
    setCourseError(undefined)
  }
  const newChat = (): void => {
    if (current === undefined || current.running) return
    setCourseStates(states => ({ ...states, [current.course.courseCode]: emptyCourseState(current.course) }))
    setDraft('')
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const query = draft.trim()
    if (query.length === 0 || current === undefined || running) return
    const runId = createRunId()
    const controller = new AbortController()
    const userMessage: StudyUiMessage = { id: `${runId}:user`, role: 'user', content: query, runId, createdAt: Date.now() }
    setDraft('')
    setCourseStates(states => ({
      ...states,
      [current.course.courseCode]: {
        ...current,
        messages: [...current.messages, userMessage],
        activity: [],
        evidence: [],
        running: true,
        error: undefined,
      },
    }))
    void client.runTurn({
      runId,
      query,
      courseCode: current.course.courseCode,
      ...(current.conversation === undefined ? {} : { conversation: current.conversation }),
    }, eventItem => {
      setCourseStates(states => {
        const state = states[current.course.courseCode]
        if (state === undefined) return states
        const activity = [...state.activity.filter(item => item.label !== toActivityItem(eventItem).label), toActivityItem(eventItem)]
        return { ...states, [current.course.courseCode]: { ...state, activity } }
      })
    }, controller.signal).then(response => {
      setCourseStates(states => {
        const state = states[current.course.courseCode]
        if (state === undefined) return states
        if (response.status === 'failed') {
          return { ...states, [current.course.courseCode]: { ...state, running: false, error: { code: response.errorCode, message: response.message } } }
        }
        const assistant: StudyUiMessage = { id: `${runId}:assistant`, role: 'assistant', content: response.result.answer, runId, createdAt: Date.now() }
        return { ...states, [current.course.courseCode]: completedState(state, response.result, assistant) }
      })
    }).catch(error => {
      setCourseStates(states => {
        const state = states[current.course.courseCode]
        if (state === undefined) return states
        return { ...states, [current.course.courseCode]: { ...state, running: false, error: { code: 'UNKNOWN', message: error instanceof Error ? error.message : 'Something went wrong' } } }
      })
    })
  }

  return createElement('div', { 'data-monash-study': '', className: 'monash-study-page' },
    createElement('aside', { className: 'monash-study-courses' },
      createElement('div', { className: 'monash-study-section-title' }, 'Courses'),
      loadingCourses ? createElement('div', { className: 'monash-study-muted' }, 'Loading courses…') : null,
      courseError ? createElement('div', { className: 'monash-study-error' }, courseError) : null,
      courses.map(course => createElement('button', {
        type: 'button', key: course.courseCode, className: `monash-study-course${selectedCourse === course.courseCode ? ' active' : ''}`,
        onClick: () => { selectCourse(course) },
      }, createElement('span', null, course.courseCode), createElement('small', null, String(course.resourceCount)))),
    ),
    createElement('main', { className: 'monash-study-chat' },
      createElement('header', { className: 'monash-study-chat-header' },
        createElement('div', null,
          createElement('div', { className: 'monash-study-kicker' }, 'Monash Study Agent'),
          createElement('h1', null, selectedCourse ?? 'Select a course'),
        ),
        createElement(Button, { size: 'sm', variant: 'outline', onClick: newChat, disabled: current === undefined || current.running }, 'New Chat'),
      ),
      createElement('div', { className: 'monash-study-messages' },
        current?.messages.length === 0 ? createElement('div', { className: 'monash-study-empty' }, 'Ask a question about the selected course.') : null,
        current?.messages.map(message => createElement('article', { key: message.id, className: `monash-study-message ${message.role}` },
          createElement('div', { className: 'monash-study-message-role' }, message.role === 'user' ? 'You' : 'Monash Study Agent'),
          message.role === 'assistant'
            ? createElement(MarkdownText, { text: message.content, labels: MARKDOWN_LABELS })
            : createElement('div', { className: 'monash-study-user-text' }, message.content),
        )),
      ),
      current?.activity.length ? createElement(ActivityGroup, { items: current.activity, running: current.running }) : null,
      current?.error ? createElement('div', { className: 'monash-study-runtime-error' }, `${errorLabel(current.error.code)}: ${current.error.message}`) : null,
      createElement('form', { className: 'monash-study-composer', onSubmit: submit },
        createElement('textarea', {
          value: draft, disabled: current === undefined || running, rows: 3,
          placeholder: running ? 'Study Agent is running…' : 'Ask about this course…',
          onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setDraft(event.currentTarget.value) },
          onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
          },
        }),
        createElement('div', { className: 'monash-study-composer-footer' },
          createElement('span', { className: 'monash-study-muted' }, 'Enter to send · Shift + Enter for a new line'),
          createElement(Button, { type: 'submit', variant: 'primary', size: 'sm', disabled: current === undefined || running || draft.trim().length === 0 }, 'Send'),
        ),
      ),
    ),
    createElement(EvidencePanel, { evidence: current?.evidence ?? [], researchActions: current?.researchActions ?? 0 }),
  )
}

function completedState(state: CourseState, result: StudyTurnResult, assistant: StudyUiMessage): CourseState {
  return {
    ...state,
    messages: [...state.messages, assistant],
    conversation: result.conversation,
    evidence: toEvidenceCards(result),
    researchActions: result.researchActions,
    running: false,
    error: undefined,
  }
}

function ActivityGroup({ items, running }: { items: readonly ActivityItem[]; running: boolean }) {
  return createElement('section', { className: 'monash-study-activity' },
    createElement('div', { className: 'monash-study-panel-title' }, running ? 'Agent Activity' : 'Activity'),
    items.map(item => createElement('div', { key: item.id, className: `monash-study-activity-item ${item.state}` },
      item.state === 'completed' ? createElement(IconCheckOutline16, { size: 14 }) : createElement('span', { className: 'monash-study-spinner' }),
      createElement('span', null, item.label),
    )),
  )
}

function EvidencePanel({ evidence, researchActions }: { evidence: readonly EvidenceCardModel[]; researchActions: number }) {
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  return createElement('aside', { className: 'monash-study-evidence' },
    createElement('div', { className: 'monash-study-evidence-header' },
      createElement('div', null,
        createElement('div', { className: 'monash-study-section-title' }, 'Evidence'),
        researchActions > 0 ? createElement(ResearchBadge, { count: researchActions }) : null,
      ),
      createElement(IconSearchOutline16, { size: 16 }),
    ),
    evidence.length === 0 ? createElement('div', { className: 'monash-study-muted' }, 'Evidence will appear after a course question.') : null,
    evidence.map(item => createElement('button', {
      type: 'button', key: item.id, className: `monash-study-evidence-card${expanded === item.id ? ' expanded' : ''}`,
      onClick: () => { setExpanded(current => current === item.id ? undefined : item.id) },
    },
      createElement('strong', null, item.title),
      createElement('span', { className: 'monash-study-evidence-meta' }, `${item.course ?? 'Course unavailable'} · ${item.source} · ${item.provider}${item.score === undefined ? '' : ` · ${item.score.toFixed(2)}`}`),
      expanded === item.id ? createElement('span', { className: 'monash-study-evidence-content' }, item.content) : null,
      expanded === item.id ? createElement('span', { className: 'monash-study-evidence-locator' }, formatMetadata(item.metadata)) : null,
    )),
  )
}

function ResearchBadge({ count }: { count: number }) {
  return createElement(Tag, { tone: 'info' }, `Research · ${count} retrieval actions`)
}

function formatMetadata(metadata: Readonly<Record<string, unknown>>): string {
  const locator = metadata.locator
  if (locator === undefined) return 'Source metadata unavailable'
  return `Locator: ${JSON.stringify(locator)}`
}

function createRunId(): string {
  const browserCrypto = globalThis.crypto
  if (typeof browserCrypto?.randomUUID === 'function') return browserCrypto.randomUUID()
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

const STYLES = `
.monash-study-page{display:grid;grid-template-columns:220px minmax(420px,1fr) 300px;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px}
.monash-study-courses,.monash-study-evidence{min-width:0;padding:24px 16px;background:var(--dsw-alias-bg-layer-1);overflow:auto}
.monash-study-courses{border-right:1px solid var(--dsw-alias-border-l1)}
.monash-study-evidence{border-left:1px solid var(--dsw-alias-border-l1)}
.monash-study-section-title,.monash-study-panel-title{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-secondary)}
.monash-study-course{display:flex;width:100%;justify-content:space-between;align-items:center;margin:5px 0;padding:10px 11px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}
.monash-study-course:hover,.monash-study-course.active{background:var(--dsw-alias-bg-layer-2)}
.monash-study-course.active{box-shadow:inset 2px 0 var(--dsw-alias-brand-primary)}
.monash-study-course small{color:var(--dsw-alias-label-secondary)}
.monash-study-chat{display:flex;min-width:0;min-height:0;flex-direction:column;padding:24px 28px 20px}
.monash-study-chat-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:18px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.monash-study-kicker{font-size:12px;color:var(--dsw-alias-label-secondary)}
.monash-study-chat h1{margin:4px 0 0;font-size:22px;line-height:1.2}
.monash-study-messages{flex:1;min-height:0;overflow:auto;padding:20px 4px}
.monash-study-message{max-width:760px;margin:0 auto 18px;padding:13px 16px;border-radius:12px;line-height:1.55}
.monash-study-message.user{background:var(--dsw-alias-bg-layer-2)}
.monash-study-message.assistant{background:transparent}
.monash-study-message-role{margin-bottom:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.monash-study-user-text{white-space:pre-wrap}
.monash-study-empty{display:grid;place-items:center;height:100%;color:var(--dsw-alias-label-secondary)}
.monash-study-activity{max-width:760px;width:100%;margin:0 auto 14px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.monash-study-activity-item{display:flex;align-items:center;gap:8px;padding-top:8px;color:var(--dsw-alias-label-secondary)}
.monash-study-activity-item.completed{color:var(--dsw-alias-state-success-primary)}
.monash-study-activity-item.failed{color:var(--dsw-alias-state-error-primary)}
.monash-study-spinner{width:12px;height:12px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:monash-study-spin .8s linear infinite}
@keyframes monash-study-spin{to{transform:rotate(360deg)}}
.monash-study-runtime-error{max-width:760px;width:100%;margin:0 auto 12px;padding:10px 12px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}
.monash-study-composer{max-width:760px;width:100%;margin:0 auto;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.monash-study-composer textarea{display:block;width:100%;box-sizing:border-box;resize:vertical;padding:12px 14px;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;line-height:1.45}
.monash-study-composer-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px 8px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.monash-study-muted{color:var(--dsw-alias-label-secondary);font-size:12px}
.monash-study-evidence-header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px}
.monash-study-evidence-card{display:block;width:100%;margin:8px 0;padding:11px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}
.monash-study-evidence-card:hover,.monash-study-evidence-card.expanded{border-color:var(--dsw-alias-brand-primary)}
.monash-study-evidence-card strong,.monash-study-evidence-card span{display:block}
.monash-study-evidence-meta{margin-top:5px;color:var(--dsw-alias-label-secondary);font-size:11px}
.monash-study-evidence-content{margin-top:10px;white-space:pre-wrap;line-height:1.5;color:var(--dsw-alias-label-primary)}
.monash-study-evidence-locator{margin-top:8px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-size:11px}
@media(max-width:1100px){.monash-study-page{grid-template-columns:190px minmax(360px,1fr)}.monash-study-evidence{display:none}}
`
