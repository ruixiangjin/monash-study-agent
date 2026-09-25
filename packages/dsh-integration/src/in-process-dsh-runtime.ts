import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  MAIN_STUDY_AGENT_PROMPT_VERSION,
  NoopAgentEventSink,
  renderMainStudyAgentPrompt,
  StudyRuntimeError,
  type AgentEvent,
  type AgentEventSink,
  type ModelProfile,
  type StudyAgentRuntime,
  type StudyAgentToolServices,
  type StudyTurnInput,
  type StudyTurnOptions,
  type StudyTurnResult,
} from '@monash-study/study-core'
import { StudyToolBridge, type StudyToolRunSnapshot } from './study-tool-bridge.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    monashStudyRuntime: InProcessDshRuntime
  }
}

const PRESET = 'monash-study-agent'
let currentProcessToolBridge: StudyToolBridge | undefined
const DSH_MODELS: Readonly<Record<ModelProfile, { readonly provider: string; readonly model: string }>> = {
  fast: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  strong: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
}

export interface InProcessDshRuntimeConfig {
  readonly applicationRoot?: string
}

/** Product adapter over the Agent and Session services already owned by DSH Web. */
export class InProcessDshRuntime extends Service implements StudyAgentRuntime {
  static inject = ['agents', 'sessionController']

  private readonly root: Context
  private readonly sessionController: SessionController
  private readonly applicationRoot: string
  private toolBridge: StudyToolBridge | undefined
  private configured = false
  private activeRunId: string | undefined
  private closed = false

  constructor(ctx: Context, config: InProcessDshRuntimeConfig = {}) {
    super(ctx, 'monashStudyRuntime')
    this.root = ctx
    this.sessionController = ctx.sessionController
    const applicationRoot = config.applicationRoot ?? process.env.MONASH_STUDY_AGENT_ROOT
    if (applicationRoot === undefined) {
      throw new Error('InProcessDshRuntime requires an explicit applicationRoot')
    }
    this.applicationRoot = resolve(applicationRoot)
  }

  configure(toolServices: StudyAgentToolServices): this {
    if (this.configured) return this
    const toolBridge = new StudyToolBridge({ services: toolServices })
    this.toolBridge = toolBridge
    currentProcessToolBridge = toolBridge
    this.configured = true
    return this
  }

  async executeTool(name: string, args: unknown, agent: Agent | undefined): Promise<unknown> {
    if (agent === undefined) throw new Error(`Study Agent tool ${name} requires a live Agent`)
    const active = this.root.agents.get(agent.id)
    if (active !== agent) throw new Error(`Study Agent tool ${name} lost its Agent owner`)
    let toolBridge = this.currentToolBridge()
    if (toolBridge === undefined) {
      const uiService = this.root.get('monashStudyUi') as { ensureApplication(): Promise<void> } | undefined
      await uiService?.ensureApplication()
      toolBridge = this.currentToolBridge()
    }
    if (toolBridge === undefined) throw new Error('Study Agent services are not configured')

    const ownsRestoredRun = !toolBridge.hasActiveRun()
    const restoredRunId = ownsRestoredRun ? `restored-${agent.id}-${randomUUID()}` : undefined
    if (restoredRunId !== undefined) {
      const course = isRecord(args) && typeof args.course === 'string' ? args.course : undefined
      toolBridge.begin(restoredRunId, {
        query: name,
        ...(course === undefined ? {} : { courseContext: { courseCode: course } }),
        conversation: { sessionId: agent.id, conversationId: agent.id },
      })
    }
    try {
      return await toolBridge.executeDirect(name, args)
    } finally {
      if (restoredRunId !== undefined) toolBridge.end(restoredRunId)
    }
  }

  async runTurn(input: StudyTurnInput, options: StudyTurnOptions = {}): Promise<StudyTurnResult> {
    const runId = options.runId ?? randomUUID()
    const modelProfile = options.modelProfile ?? 'fast'
    const eventSink = options.eventSink ?? new NoopAgentEventSink()
    if (input.query.trim().length === 0) throw new StudyRuntimeError('INVALID_INPUT', 'Study Agent query must not be empty.')
    if (options.signal?.aborted === true) throw new StudyRuntimeError('ABORTED', 'The Study Agent turn was aborted before Harness execution.')
    if (this.closed) throw new StudyRuntimeError('HARNESS_ERROR', 'DeepSeek Harness could not complete the Study Agent turn.')
    const toolBridge = this.currentToolBridge()
    if (toolBridge === undefined) throw new StudyRuntimeError('HARNESS_ERROR', 'Study Agent services are not configured.')
    if (this.activeRunId !== undefined) throw new StudyRuntimeError('CONCURRENT_RUN', 'Another Study Agent turn is already running.')

    const requestedSessionId = input.conversation?.sessionId as SessionId | undefined
    if (input.conversation !== undefined && input.conversation.conversationId !== input.conversation.sessionId) {
      throw new StudyRuntimeError('SESSION_ERROR', 'The DSH session identity must match the Study conversation identity.')
    }
    this.activeRunId = runId
    let snapshot: StudyToolRunSnapshot = { evidence: [], toolsUsed: [], researchActions: 0 }
    try {
      const created = await this.sessionController.create({
        ...(requestedSessionId === undefined ? {} : { sessionId: requestedSessionId }),
        cwd: this.applicationRoot,
        agentPreset: PRESET,
      })
      const sessionId = created.sessionId
      const agent = this.root.agents.get(sessionId)
      if (agent === undefined) throw new StudyRuntimeError('SESSION_ERROR', 'DSH did not publish the Study Agent session.')
      const model = DSH_MODELS[modelProfile]
      await this.sessionController.selectModel({ sessionId, ...model })
      toolBridge.begin(runId, { ...input, conversation: { sessionId, conversationId: sessionId } })
      await emit(eventSink, event(runId, 'model_started', modelProfile, sessionId))
      const prompt = renderMainStudyAgentPrompt(input, { toolsEnabled: true })
      await this.sessionController.prompt({
        sessionId,
        requestId: `monash-${runId}` as never,
        mode: 'queue',
        content: [{ type: 'text', text: prompt.userPrompt }],
      }, options.signal ?? new AbortController().signal)
      await agent.whenIdle()
      const events = agent.session.snapshotEvents()
      const turnEnd = events.findLast(item => item.type === 'turn/end')
      const answerEvent = events.findLast(item => item.type === 'assistant/message')
      const answer = answerEvent === undefined ? '' : textOfAssistantEvent(answerEvent.data)
      if (answer.trim().length === 0) throw new StudyRuntimeError('MODEL_ERROR', 'The Study Agent model returned an empty answer.')
      const turnId = turnEnd === undefined || !isRecord(turnEnd.data) ? undefined : turnEnd.data['turn']
      if (typeof turnId !== 'number') throw new StudyRuntimeError('HARNESS_ERROR', 'DeepSeek Harness returned no turn identity.')
      snapshot = toolBridge.snapshot(runId)
      const usedResearch = events.some(item => item.type === 'tool/call' && isRecord(item.data) && item.data['name'] === 'research_subagent')
      await emit(eventSink, event(runId, 'model_completed', modelProfile, sessionId, String(turnId)))
      await emit(eventSink, event(runId, 'answer_completed', modelProfile, sessionId, String(turnId)))
      return {
        runId,
        answer,
        conversation: { sessionId, conversationId: sessionId },
        turnId: String(turnId),
        modelProfile,
        promptVersion: MAIN_STUDY_AGENT_PROMPT_VERSION,
        evidence: snapshot.evidence,
        toolsUsed: snapshot.toolsUsed,
        subagentsUsed: usedResearch ? ['Research Subagent'] : [],
        researchActions: snapshot.researchActions,
      }
    } catch (error) {
      if (error instanceof StudyRuntimeError) throw error
      throw new StudyRuntimeError('HARNESS_ERROR', 'DeepSeek Harness could not complete the Study Agent turn.', { cause: error })
    } finally {
      toolBridge.end(runId)
      if (this.activeRunId === runId) this.activeRunId = undefined
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.activeRunId = undefined
    const toolBridge = this.toolBridge
    if (toolBridge !== undefined && currentProcessToolBridge === toolBridge) currentProcessToolBridge = undefined
    await toolBridge?.close()
  }

  /** Resolve the current-process binding even when a restored Agent has a scoped runtime instance. */
  private currentToolBridge(): StudyToolBridge | undefined {
    return currentProcessToolBridge ?? this.toolBridge
  }
}

function textOfAssistantEvent(data: unknown): string {
  if (!isRecord(data) || !isRecord(data['message']) || !Array.isArray(data['message']['content'])) return ''
  return data['message']['content']
    .filter(isRecord)
    .filter(block => block['type'] === 'text' && typeof block['text'] === 'string')
    .map(block => block['text'] as string)
    .join('\n')
}

function event(runId: string, type: AgentEvent['type'], modelProfile: ModelProfile, sessionId: string, turnId?: string): AgentEvent {
  return {
    runId,
    timestamp: new Date().toISOString(),
    type,
    modelProfile,
    sessionId,
    conversationId: sessionId,
    ...(turnId === undefined ? {} : { turnId }),
  }
}

async function emit(sink: AgentEventSink, value: AgentEvent): Promise<void> {
  await sink.emit(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
