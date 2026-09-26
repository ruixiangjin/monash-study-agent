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
import type {
  CourseConversationHistory,
  CourseConversationSummary,
  CourseSummary,
  MonashStudyTurnResponse,
} from '@monash-study/dsh-integration'
import type { AgentEvent, StudyConversationRef, StudyRuntimeErrorCode, StudyTurnResult } from '@monash-study/study-core'
import {
  activityState,
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
  readonly courseCode: string
  readonly messages: readonly StudyUiMessage[]
  readonly activity: readonly ActivityItem[]
  readonly evidence: readonly EvidenceCardModel[]
  readonly conversation: StudyConversationRef
  readonly researchActions: number
  readonly running: boolean
  readonly error: { readonly code: StudyRuntimeErrorCode; readonly message: string } | undefined
}

interface StudyClient {
  listCourses(signal?: AbortSignal): Promise<readonly CourseSummary[]>
  listCourseConversations(courseCode: string, signal?: AbortSignal): Promise<readonly CourseConversationSummary[]>
  createConversation(courseCode: string, signal?: AbortSignal): Promise<CourseConversationSummary>
  loadConversation(courseCode: string, sessionId: string, signal?: AbortSignal): Promise<CourseConversationHistory>
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

  async listCourseConversations(courseCode: string, signal?: AbortSignal): Promise<readonly CourseConversationSummary[]> {
    const response = await this.remote.listCourseConversations(courseCode, signal)
    if (!response.ok) throw response.error
    return response.value
  }

  async createConversation(courseCode: string, signal?: AbortSignal): Promise<CourseConversationSummary> {
    const response = await this.remote.createConversation(courseCode, signal)
    if (!response.ok) throw response.error
    return response.value
  }

  async loadConversation(courseCode: string, sessionId: string, signal?: AbortSignal): Promise<CourseConversationHistory> {
    const response = await this.remote.loadConversation(courseCode, sessionId, signal)
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
  try {
    const disposeRemote = await ctx.remote.$mount(monashStudyRemote)
    const ui = ctx.inject(['slots', 'layout', 'remote.monashStudy', 'locale', 'theme'], (scope) => {
      const client = new RemoteStudyClient(scope.remote.monashStudy)
      const style = document.createElement('style')
      style.dataset.plugin = '@monash-study/dsh-ui-plugin'
      style.textContent = STYLES
      document.head.append(style)
      const themeDisposer = scope.theme.overrideTokens('@monash-study/dsh-ui-plugin', THEME_TOKENS)
      document.documentElement.dataset.monashStudyAgent = 'true'
      const disposeSlots = registerMonashStudySlots(
        scope,
        ({ size }: { readonly size?: number }) => createElement(IconListPenOutline16, { size }),
        (props: PropsRuntime<'main'>) => createElement(MonashStudyPage, { ...props, client }),
        ({ size }: { readonly size?: number }) => createElement(IconListPenOutline16, { size: size ?? 24 }),
        () => createElement('span', { className: 'monash-study-brand-name' }, 'Monash Study Agent'),
      )
      scope.layout.selectPanel(PANEL_ID)
      return () => {
        disposeSlots()
        themeDisposer()
        delete document.documentElement.dataset.monashStudyAgent
        style.remove()
      }
    })
    try {
      await ui
    } catch (error) {
      await ui.dispose()
      await disposeRemote()
      throw error
    }
    return async () => {
      await ui.dispose()
      await disposeRemote()
    }
  } catch (error) {
    console.error('monash-study-ui client activation failed', error)
    throw error
  }
}

function MonashStudyPage({ client }: { client: StudyClient } & PropsRuntime<'main'>) {
  const [courses, setCourses] = useState<readonly CourseSummary[]>([])
  const [selectedCourse, setSelectedCourse] = useState<string | undefined>(undefined)
  const [courseConversations, setCourseConversations] = useState<Readonly<Record<string, readonly CourseConversationSummary[]>>>({})
  const [conversationStates, setConversationStates] = useState<Readonly<Record<string, CourseState>>>({})
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(undefined)
  const [loadingCourses, setLoadingCourses] = useState(true)
  const [loadingConversations, setLoadingConversations] = useState(false)
  const [openingSessionId, setOpeningSessionId] = useState<string | undefined>(undefined)
  const [creatingChat, setCreatingChat] = useState(false)
  const [courseError, setCourseError] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void client.listCourses(controller.signal).then(next => {
      setCourses(next)
      setSelectedCourse(current => current ?? next[0]?.courseCode)
    }).catch(error => {
      if (!controller.signal.aborted) setCourseError(error instanceof Error ? error.message : 'Courses could not be loaded')
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingCourses(false)
    })
    return () => { controller.abort() }
  }, [client])

  useEffect(() => {
    if (selectedCourse === undefined) return
    const controller = new AbortController()
    setLoadingConversations(true)
    void client.listCourseConversations(selectedCourse, controller.signal).then(next => {
      setCourseConversations(items => ({ ...items, [selectedCourse]: next }))
    }).catch(error => {
      if (!controller.signal.aborted) setCourseError(error instanceof Error ? error.message : 'Conversations could not be loaded')
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingConversations(false)
    })
    return () => { controller.abort() }
  }, [client, selectedCourse])

  const current = selectedSessionId === undefined ? undefined : conversationStates[selectedSessionId]
  const running = Object.values(conversationStates).some(state => state.running)
  const conversations = selectedCourse === undefined ? [] : courseConversations[selectedCourse] ?? []
  const selectCourse = (course: CourseSummary): void => {
    setSelectedCourse(course.courseCode)
    setSelectedSessionId(undefined)
    setDraft('')
    setCourseError(undefined)
  }
  const newChat = (): void => {
    if (selectedCourse === undefined || running || creatingChat) return
    setCreatingChat(true)
    setDraft('')
    void client.createConversation(selectedCourse).then(conversation => {
      const state = emptySessionState(selectedCourse, conversation.sessionId)
      setCourseConversations(items => ({
        ...items,
        [selectedCourse]: [conversation, ...(items[selectedCourse] ?? []).filter(item => item.sessionId !== conversation.sessionId)],
      }))
      setConversationStates(states => ({ ...states, [conversation.sessionId]: state }))
      setSelectedSessionId(conversation.sessionId)
    }).catch(error => {
      setCourseError(error instanceof Error ? error.message : 'A new conversation could not be created')
    }).finally(() => { setCreatingChat(false) })
  }
  const openConversation = (item: CourseConversationSummary): void => {
    if (selectedCourse === undefined || openingSessionId !== undefined || running) return
    setCourseError(undefined)
    const existing = conversationStates[item.sessionId]
    if (existing !== undefined) {
      setSelectedSessionId(item.sessionId)
      setDraft('')
      return
    }
    const controller = new AbortController()
    setOpeningSessionId(item.sessionId)
    void client.loadConversation(selectedCourse, item.sessionId, controller.signal).then(history => {
      setConversationStates(states => ({ ...states, [item.sessionId]: courseStateFromHistory(selectedCourse, history) }))
      setSelectedSessionId(item.sessionId)
      setDraft('')
    }).catch(error => {
      setCourseError(error instanceof Error ? error.message : 'This conversation could not be restored')
    }).finally(() => { setOpeningSessionId(undefined) })
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const query = draft.trim()
    if (query.length === 0 || current === undefined || running) return
    const runId = createRunId()
    const controller = new AbortController()
    const userMessage: StudyUiMessage = { id: `${runId}:user`, role: 'user', content: query, runId, createdAt: Date.now() }
    setDraft('')
    setConversationStates(states => ({
      ...states,
      [current.conversation.sessionId]: {
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
      courseCode: current.courseCode,
      conversation: current.conversation,
    }, eventItem => {
      setConversationStates(states => {
        const state = states[current.conversation.sessionId]
        if (state === undefined) return states
        const activity = [...state.activity.filter(item => item.label !== toActivityItem(eventItem).label), toActivityItem(eventItem)]
        return { ...states, [current.conversation.sessionId]: { ...state, activity } }
      })
    }, controller.signal).then(response => {
      setConversationStates(states => {
        const state = states[current.conversation.sessionId]
        if (state === undefined) return states
        if (response.status === 'failed') {
          return { ...states, [current.conversation.sessionId]: { ...state, running: false, error: { code: response.errorCode, message: response.message } } }
        }
        const assistant: StudyUiMessage = { id: `${runId}:assistant`, role: 'assistant', content: response.result.answer, runId, createdAt: Date.now() }
        return { ...states, [current.conversation.sessionId]: completedState(state, response.result, assistant) }
      })
      if (response.status === 'completed') {
        void client.listCourseConversations(current.courseCode).then(next => {
          setCourseConversations(items => ({ ...items, [current.courseCode]: next }))
        }).catch(() => {})
      }
    }).catch(error => {
      setConversationStates(states => {
        const state = states[current.conversation.sessionId]
        if (state === undefined) return states
        return { ...states, [current.conversation.sessionId]: { ...state, running: false, error: { code: 'UNKNOWN', message: error instanceof Error ? error.message : 'Something went wrong' } } }
      })
    })
  }

  return createElement('div', { 'data-monash-study': '', className: 'monash-study-page' },
    createElement('aside', { className: 'monash-study-courses' },
      createElement('div', { className: 'monash-study-product-heading' },
        createElement(IconListPenOutline16, { size: 20 }),
        createElement('span', null, 'Monash Study Agent'),
      ),
      createElement('div', { className: 'monash-study-section-title' }, 'Courses'),
      loadingCourses ? createElement('div', { className: 'monash-study-muted' }, 'Loading courses…') : null,
      courseError ? createElement('div', { className: 'monash-study-error' }, courseError) : null,
      courses.map(course => createElement('button', {
        type: 'button', key: course.courseCode, className: `monash-study-course${selectedCourse === course.courseCode ? ' active' : ''}`,
        onClick: () => { selectCourse(course) },
      }, createElement('span', null, course.courseCode), createElement('small', null, String(course.resourceCount)))),
      createElement('div', { className: 'monash-study-conversation-header' },
        createElement('div', { className: 'monash-study-section-title' }, 'Conversations'),
        createElement('button', {
          type: 'button', className: 'monash-study-plus', onClick: newChat,
          disabled: selectedCourse === undefined || running || creatingChat,
          'aria-label': 'New Chat',
        }, creatingChat ? '…' : '+'),
      ),
      loadingConversations ? createElement('div', { className: 'monash-study-muted' }, 'Loading conversations…') : null,
      !loadingConversations && conversations.length === 0
        ? createElement('div', { className: 'monash-study-muted monash-study-list-empty' }, 'No conversations yet') : null,
      conversations.map(item => createElement('button', {
        type: 'button', key: item.sessionId,
        className: `monash-study-conversation${selectedSessionId === item.sessionId ? ' active' : ''}`,
        onClick: () => { openConversation(item) },
        disabled: openingSessionId !== undefined || running,
      },
      createElement('span', { className: 'monash-study-conversation-title' }, item.title),
      createElement('small', null, formatUpdatedAt(item.updatedAt)),
      openingSessionId === item.sessionId ? createElement('span', { className: 'monash-study-opening' }, 'Restoring…') : null)),
    ),
    createElement('main', { className: 'monash-study-chat' },
      createElement('header', { className: 'monash-study-chat-header' },
        createElement('div', null,
          createElement('div', { className: 'monash-study-kicker' }, 'Monash Study Agent'),
          createElement('h1', null, selectedCourse ?? 'Select a course'),
        ),
        createElement(Button, { size: 'sm', variant: 'outline', onClick: newChat, disabled: selectedCourse === undefined || running || creatingChat }, 'New Chat'),
      ),
      createElement('div', { className: 'monash-study-messages' },
        current === undefined ? createElement('div', { className: 'monash-study-empty' }, 'Choose a conversation or start a new chat.') : null,
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

function emptySessionState(courseCode: string, sessionId: string): CourseState {
  return {
    courseCode,
    messages: [],
    activity: [],
    evidence: [],
    conversation: { sessionId, conversationId: sessionId },
    researchActions: 0,
    running: false,
    error: undefined,
  }
}

function courseStateFromHistory(courseCode: string, history: CourseConversationHistory): CourseState {
  return {
    ...emptySessionState(courseCode, history.conversation.sessionId),
    messages: history.messages,
  }
}

function formatUpdatedAt(value: number): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const today = new Date()
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
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

const THEME_TOKENS = {
  '--dsw-alias-bg-base': { light: '#f5f7f7', dark: '#192328' },
  '--dsw-alias-bg-layer-1': { light: '#ffffff', dark: '#222e33' },
  '--dsw-alias-bg-layer-2': { light: '#edf2f2', dark: '#2b383d' },
  '--dsw-alias-bg-layer-3': { light: '#e5eded', dark: '#344248' },
  '--dsw-alias-bg-overlay': { light: '#ffffff', dark: '#303d42' },
  '--dsw-alias-border-l1': { light: '#e1e8e8', dark: '#39484d' },
  '--dsw-alias-border-l2': { light: '#cbd7d8', dark: '#506065' },
  '--dsw-alias-brand-primary': { light: '#28747c', dark: '#8bc2c3' },
  '--dsw-alias-brand-primary-invert': { light: '#ffffff', dark: '#172126' },
  '--dsw-alias-label-primary': { light: '#243236', dark: '#e6eeee' },
  '--dsw-alias-label-primary-foreground': { light: '#ffffff', dark: '#172126' },
  '--dsw-alias-label-secondary': { light: '#617276', dark: '#a9b9bc' },
  '--dsw-alias-button-primary-hover': { light: '#205e65', dark: '#a6d3d3' },
  '--dsw-alias-interactive-bg-active': { light: '#dce9e9', dark: 'rgba(139, 194, 195, .2)' },
  '--dsw-alias-interactive-bg-hover-accent': { light: '#e9f1f1', dark: 'rgba(139, 194, 195, .12)' },
  '--dsw-alias-interactive-bg-hover': { light: '#edf2f2', dark: 'rgba(255, 255, 255, .06)' },
  '--dsw-specific-sidebar-fill': { light: '#f0f4f4', dark: '#1d292e' },
} as const

const STYLES = `
html[data-monash-study-agent] [data-slot="sidebar.workspaces"]{display:none!important}
html[data-monash-study-agent] nav[aria-label="Global panels"]>button:not([aria-label="Study"]),html[data-monash-study-agent] nav[aria-label="全局面板"]>button:not([aria-label="Study"]){display:none!important}
.monash-study-page{display:grid;grid-template-columns:248px minmax(420px,1fr) 292px;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px}
.monash-study-courses,.monash-study-evidence{min-width:0;padding:22px 16px;background:var(--dsw-alias-bg-layer-1);overflow:auto}
.monash-study-courses{border-right:1px solid var(--dsw-alias-border-l1)}
.monash-study-evidence{border-left:1px solid var(--dsw-alias-border-l1)}
.monash-study-product-heading{display:flex;align-items:center;gap:9px;margin:0 2px 28px;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:650;letter-spacing:-.01em}
.monash-study-product-heading svg{color:var(--dsw-alias-brand-primary)}
.monash-study-brand-name{font-size:15px;font-weight:650;letter-spacing:-.01em;color:var(--dsw-alias-label-primary)}
.monash-study-section-title,.monash-study-panel-title{font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.08em;color:var(--dsw-alias-label-secondary)}
.monash-study-course{display:flex;width:100%;justify-content:space-between;align-items:center;margin:4px 0;padding:10px 11px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;transition:background-color .15s ease,color .15s ease}
.monash-study-course:hover,.monash-study-conversation:hover{background:var(--dsw-alias-interactive-bg-hover)}
.monash-study-course.active,.monash-study-conversation.active{background:var(--dsw-alias-interactive-bg-active)}
.monash-study-course.active{box-shadow:inset 2px 0 var(--dsw-alias-brand-primary);font-weight:600}
.monash-study-course small,.monash-study-conversation small{color:var(--dsw-alias-label-secondary);font-size:11px}
.monash-study-conversation-header{display:flex;align-items:center;justify-content:space-between;margin:26px 2px 7px;padding-top:19px;border-top:1px solid var(--dsw-alias-border-l1)}
.monash-study-plus{width:26px;height:26px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:19px;line-height:1;cursor:pointer}
.monash-study-plus:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.monash-study-plus:disabled{opacity:.55;cursor:default}
.monash-study-conversation{display:flex;position:relative;width:100%;flex-direction:column;align-items:flex-start;gap:4px;margin:3px 0;padding:9px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}
.monash-study-conversation.active{box-shadow:inset 2px 0 var(--dsw-alias-brand-primary)}
.monash-study-conversation-title{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.monash-study-opening{position:absolute;right:8px;top:10px;color:var(--dsw-alias-brand-primary);font-size:10px}
.monash-study-list-empty{padding:10px 4px}
.monash-study-chat{display:flex;min-width:0;min-height:0;flex-direction:column;padding:25px 28px 20px}
.monash-study-chat-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:18px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.monash-study-kicker{font-size:12px;color:var(--dsw-alias-label-secondary)}
.monash-study-chat h1{margin:4px 0 0;font-size:22px;line-height:1.2;letter-spacing:-.025em}
.monash-study-messages{flex:1;min-height:0;overflow:auto;padding:20px 4px}
.monash-study-message{max-width:760px;margin:0 auto 18px;padding:14px 17px;border-radius:11px;line-height:1.6}
.monash-study-message.user{background:var(--dsw-alias-bg-layer-2)}
.monash-study-message.assistant{background:transparent}
.monash-study-message-role{margin-bottom:5px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.monash-study-user-text{white-space:pre-wrap}
.monash-study-empty{display:grid;place-items:center;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary)}
.monash-study-activity{max-width:760px;width:100%;margin:0 auto 14px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.monash-study-activity-item{display:flex;align-items:center;gap:8px;padding-top:8px;color:var(--dsw-alias-label-secondary)}
.monash-study-activity-item.completed{color:var(--dsw-alias-state-success-primary)}
.monash-study-activity-item.failed{color:var(--dsw-alias-state-error-primary)}
.monash-study-spinner{width:12px;height:12px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:monash-study-spin .8s linear infinite}
@keyframes monash-study-spin{to{transform:rotate(360deg)}}
.monash-study-runtime-error,.monash-study-error{max-width:760px;width:100%;margin:0 auto 12px;padding:10px 12px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px}
.monash-study-composer{max-width:760px;width:100%;margin:0 auto;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.monash-study-composer:focus-within{border-color:var(--dsw-alias-brand-primary)}
.monash-study-composer textarea{display:block;width:100%;box-sizing:border-box;resize:vertical;padding:12px 14px;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;line-height:1.5}
.monash-study-composer-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px 8px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.monash-study-muted{color:var(--dsw-alias-label-secondary);font-size:12px}
.monash-study-evidence-header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px}
.monash-study-evidence-card{display:block;width:100%;margin:8px 0;padding:11px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}
.monash-study-evidence-card:hover,.monash-study-evidence-card.expanded{border-color:var(--dsw-alias-brand-primary)}
.monash-study-evidence-card strong,.monash-study-evidence-card span{display:block}
.monash-study-evidence-meta{margin-top:5px;color:var(--dsw-alias-label-secondary);font-size:11px}
.monash-study-evidence-content{margin-top:10px;white-space:pre-wrap;line-height:1.5;color:var(--dsw-alias-label-primary)}
.monash-study-evidence-locator{margin-top:8px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-size:11px}
@media(max-width:1180px){.monash-study-page{grid-template-columns:220px minmax(360px,1fr)}.monash-study-evidence{display:none}}
@media(max-width:760px){.monash-study-page{grid-template-columns:190px minmax(280px,1fr)}.monash-study-chat{padding:18px 16px 14px}}
`
