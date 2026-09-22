import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client'
import {
  MAIN_STUDY_AGENT_PROMPT_VERSION,
  MAIN_STUDY_AGENT_NO_TOOLS_SYSTEM_PROMPT,
  MAIN_STUDY_AGENT_SYSTEM_PROMPT,
  NoopAgentEventSink,
  renderMainStudyAgentPrompt,
  StudyRuntimeError,
  type AgentEvent,
  type AgentEventSink,
  type ModelProfile,
  type StudyAgentToolServices,
  type StudyAgentRuntime,
  type StudyTurnInput,
  type StudyTurnOptions,
  type StudyTurnResult,
} from '@monash-study/study-core'
import { StudyToolBridge, type StudyToolRunSnapshot } from './study-tool-bridge.js'

export interface DeepSeekHarnessSession {
  run(input: string): Promise<DeepSeekHarnessRunResult>
}

export interface DeepSeekHarnessDriver {
  session(sessionId?: string): DeepSeekHarnessSession
  close?(): Promise<void>
}

export interface DeepSeekHarnessRunResult {
  readonly sessionId: string
  readonly finalResponse: string
  readonly events: readonly unknown[]
}

export interface DeepSeekHarnessRuntimeOptions {
  /** A fake or already-owned Harness driver for unit tests and composition. */
  readonly harness?: DeepSeekHarnessDriver
  /** Optional factory used to replace process creation in tests. */
  readonly createHarness?: (profile: ModelProfile) => DeepSeekHarnessDriver
  /** Launch options passed to the verified DSH SDK client. */
  readonly harnessOptions?: DeepSeekHarnessOptions
  /** Path to a Cordis patch that installs the Main Study Agent system prompt. */
  readonly promptPatchPath?: string
  /** Logical profile used when a direct runtime call omits StudyTurnOptions.modelProfile. */
  readonly defaultModelProfile?: ModelProfile
  /** Product capabilities exposed through the real Harness tool boundary. */
  readonly toolServices?: StudyAgentToolServices
}

const DSH_MODELS: Readonly<Record<ModelProfile, { readonly provider: string; readonly model: string }>> = {
  fast: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  strong: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
}

/** Adapter from the product runtime contract to the current DeepSeek Harness SDK. */
export class DeepSeekHarnessRuntime implements StudyAgentRuntime {
  readonly #injectedHarness: DeepSeekHarnessDriver | undefined
  readonly #createHarness: ((profile: ModelProfile) => DeepSeekHarnessDriver) | undefined
  readonly #harnessOptions: DeepSeekHarnessOptions
  readonly #promptPatchPath: string
  readonly #defaultModelProfile: ModelProfile
  readonly #systemPrompt: string
  readonly #harnesses = new Map<ModelProfile, DeepSeekHarnessDriver>()
  readonly #toolBridge: StudyToolBridge | undefined

  constructor(options: DeepSeekHarnessRuntimeOptions = {}) {
    loadProjectEnvironment()
    this.#injectedHarness = options.harness
    this.#createHarness = options.createHarness
    this.#defaultModelProfile = options.defaultModelProfile ?? 'fast'
    this.#promptPatchPath = options.promptPatchPath ?? resolve(process.cwd(), 'config/main-agent.cordis.patch.yml')
    this.#harnessOptions = options.harnessOptions ?? {}
    this.#toolBridge = options.toolServices === undefined ? undefined : new StudyToolBridge({ services: options.toolServices })
    this.#systemPrompt = options.toolServices === undefined
      ? MAIN_STUDY_AGENT_NO_TOOLS_SYSTEM_PROMPT
      : MAIN_STUDY_AGENT_SYSTEM_PROMPT
  }

  async runTurn(input: StudyTurnInput, options: StudyTurnOptions = {}): Promise<StudyTurnResult> {
    const runId = options.runId ?? randomUUID()
    const modelProfile = options.modelProfile ?? this.#defaultModelProfile
    const eventSink = options.eventSink ?? new NoopAgentEventSink()
    if (input.query.trim().length === 0) {
      throw new StudyRuntimeError('INVALID_INPUT', 'Study Agent query must not be empty.')
    }
    if (options.signal?.aborted === true) {
      throw new StudyRuntimeError('ABORTED', 'The Study Agent turn was aborted before Harness execution.')
    }

    const prompt = renderMainStudyAgentPrompt(input, { toolsEnabled: this.#toolBridge !== undefined })
    const sessionId = input.conversation?.sessionId
    if (input.conversation !== undefined && input.conversation.conversationId !== sessionId) {
      throw new StudyRuntimeError(
        'SESSION_ERROR',
        'This Harness adapter uses the Harness session identity as its conversation identity.',
      )
    }

    let toolSnapshot: StudyToolRunSnapshot = { evidence: [], toolsUsed: [] }
    this.#toolBridge?.begin(runId, input)
    await emit(eventSink, event(runId, 'model_started', modelProfile))
    try {
      const harness = await this.#getHarness(modelProfile)
      const result = await harness.session(sessionId).run(prompt.userPrompt)
      if (result.finalResponse.trim().length === 0) {
        throw new StudyRuntimeError('MODEL_ERROR', 'The Study Agent model returned an empty answer.')
      }
      const turnId = extractTurnId(result.events)
      if (turnId === undefined) {
        throw new StudyRuntimeError('HARNESS_ERROR', 'DeepSeek Harness returned no turn identity.')
      }
      const conversation = {
        sessionId: result.sessionId,
        // The current DSH SDK exposes one durable session identity for a conversation.
        conversationId: result.sessionId,
      }
      await emit(eventSink, event(runId, 'model_completed', modelProfile, conversation.sessionId, conversation.conversationId, turnId))
      await emit(eventSink, event(runId, 'answer_completed', modelProfile, conversation.sessionId, conversation.conversationId, turnId))
      toolSnapshot = this.#toolBridge?.snapshot(runId) ?? toolSnapshot
      return {
        runId,
        answer: result.finalResponse,
        conversation,
        turnId,
        modelProfile,
        promptVersion: MAIN_STUDY_AGENT_PROMPT_VERSION,
        evidence: toolSnapshot.evidence,
        toolsUsed: toolSnapshot.toolsUsed,
      }
    } catch (error) {
      if (error instanceof StudyRuntimeError) throw error
      throw new StudyRuntimeError('HARNESS_ERROR', 'DeepSeek Harness could not complete the Study Agent turn.', { cause: error })
    } finally {
      this.#toolBridge?.end(runId)
    }
  }

  async close(): Promise<void> {
    const harnesses = new Set(this.#harnesses.values())
    if (this.#injectedHarness !== undefined) harnesses.add(this.#injectedHarness)
    await Promise.all([...harnesses].map((harness) => harness.close?.()))
    await this.#toolBridge?.close()
    this.#harnesses.clear()
  }

  async #getHarness(profile: ModelProfile): Promise<DeepSeekHarnessDriver> {
    if (this.#injectedHarness !== undefined) return this.#injectedHarness
    const existing = this.#harnesses.get(profile)
    if (existing !== undefined) return existing
    const bridge = await this.#toolBridge?.start()
    const created = this.#createHarness?.(profile) ?? this.#createDefaultHarness(profile, bridge)
    this.#harnesses.set(profile, created)
    return created
  }

  #createDefaultHarness(
    profile: ModelProfile,
    bridge: { readonly url: string; readonly token: string } | undefined,
  ): DeepSeekHarnessDriver {
    const model = DSH_MODELS[profile]
    const configuredPatches = this.#harnessOptions.patches ?? []
    const patches = configuredPatches.includes(this.#promptPatchPath)
      ? configuredPatches
      : [...configuredPatches, this.#promptPatchPath]
    const env = {
      ...(this.#harnessOptions.env ?? process.env),
      MONASH_STUDY_AGENT_SYSTEM_PROMPT: this.#systemPrompt,
      ...(bridge === undefined ? {} : {
        MONASH_STUDY_AGENT_TOOL_BRIDGE_URL: bridge.url,
        MONASH_STUDY_AGENT_TOOL_BRIDGE_TOKEN: bridge.token,
      }),
    }
    return new DeepSeekHarness({
      ...this.#harnessOptions,
      patches,
      provider: model.provider,
      model: model.model,
      env,
    })
  }
}

function extractTurnId(events: readonly unknown[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!isRecord(event) || (event.type !== 'turn/start' && event.type !== 'turn/end')) continue
    const data = event.data
    if (!isRecord(data) || typeof data.turn !== 'number' || !Number.isSafeInteger(data.turn)) continue
    return String(data.turn)
  }
  return undefined
}

function event(
  runId: string,
  type: AgentEvent['type'],
  modelProfile: ModelProfile,
  sessionId?: string,
  conversationId?: string,
  turnId?: string,
): AgentEvent {
  return {
    runId,
    timestamp: new Date().toISOString(),
    type,
    modelProfile,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(turnId === undefined ? {} : { turnId }),
  }
}

async function emit(sink: AgentEventSink, value: AgentEvent): Promise<void> {
  await sink.emit(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function loadProjectEnvironment(): void {
  const envPath = resolve(process.cwd(), '.env')
  if (existsSync(envPath)) loadEnvFile(envPath)
}
