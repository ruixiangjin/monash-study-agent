import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createStudyApplication,
} from '@monash-study/study-application'
import {
  DeepSeekHarnessRuntime,
  type DeepSeekHarnessDriver,
  type DeepSeekHarnessRunResult,
} from '@monash-study/dsh-integration'
import {
  InMemoryAgentEventSink,
  MAIN_STUDY_AGENT_PROMPT_VERSION,
  renderResearchTaskPrompt,
  RESEARCH_SUBAGENT_NAME,
  StudyRuntimeError,
  type StudyAgentRuntime,
  type StudyTurnInput,
  type StudyTurnOptions,
  type StudyTurnResult,
} from '@monash-study/study-core'

function result(runId: string, answer = 'A safe answer.'): StudyTurnResult {
  return {
    runId,
    answer,
    conversation: { sessionId: 'session-1', conversationId: 'session-1' },
    turnId: '1',
    modelProfile: 'fast',
    promptVersion: MAIN_STUDY_AGENT_PROMPT_VERSION,
    evidence: [],
    toolsUsed: [],
    subagentsUsed: [],
    researchActions: 0,
  }
}

class FakeRuntime implements StudyAgentRuntime {
  readonly inputs: StudyTurnInput[] = []
  closeCount = 0

  constructor(private readonly output: StudyTurnResult = result('runtime-run')) {}

  async runTurn(input: StudyTurnInput, _options?: StudyTurnOptions): Promise<StudyTurnResult> {
    this.inputs.push(input)
    return this.output
  }

  async close(): Promise<void> {
    this.closeCount += 1
  }
}

test('StudyApplication composes a direct turn, Student Context, Post-turn, and idempotent close', async () => {
  const runtime = new FakeRuntime()
  const sink = new InMemoryAgentEventSink()
  const observed: string[] = []
  const application = await createStudyApplication({
    runtime,
    knowledgeService: null,
    resourceReader: null,
    memoryService: null,
    toolServices: {},
    eventSink: sink,
    runIdFactory: () => 'app-run-1',
    studentContextBuilder: {
      async build() {
        return { memories: [] }
      },
    },
    postTurnObserver: {
      async observe(input) {
        observed.push(input.runId)
      },
    },
  })

  const completed = await application.runTurn({
    query: 'Explain the direct path.',
    courseContext: { courseCode: 'FIT2109' },
  })
  assert.equal(completed.runId, 'app-run-1')
  assert.deepEqual(runtime.inputs[0]?.studentContext, { memories: [] })
  assert.deepEqual(observed, ['app-run-1'])
  assert.deepEqual(sink.events.map((event) => event.type), [
    'run_started',
    'memory_observation_started',
    'memory_observation_completed',
    'run_completed',
  ])

  await application.close()
  await application.close()
  assert.equal(runtime.closeCount, 1)
})

test('Student Context and Post-turn failures are nonfatal and preserve terminal lifecycle order', async () => {
  const runtime = new FakeRuntime(result('runtime-run', 'Still answered.'))
  const sink = new InMemoryAgentEventSink()
  const application = await createStudyApplication({
    runtime,
    knowledgeService: null,
    resourceReader: null,
    memoryService: null,
    toolServices: {},
    eventSink: sink,
    runIdFactory: () => 'app-run-failure-hooks',
    studentContextBuilder: {
      async build() {
        throw new Error('private memory provider detail')
      },
    },
    postTurnObserver: {
      async observe() {
        throw new Error('private sqlite path')
      },
    },
  })

  const completed = await application.runTurn({ query: 'Continue despite hook failures.' })
  assert.equal(completed.answer, 'Still answered.')
  assert.deepEqual(sink.events.map((event) => event.type), [
    'run_started',
    'student_context_failed',
    'memory_observation_started',
    'memory_observation_failed',
    'run_completed',
  ])
  assert.equal(sink.events.some((event) => event.errorCode === 'STUDENT_CONTEXT_FAILED'), true)
  assert.equal(sink.events.some((event) => event.errorCode === 'MEMORY_OBSERVATION_FAILED'), true)
  await application.close()
})

test('StudyApplication uses real MemoryService composition with temporary SQLite and cleans it up', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monash-study-application-'))
  const databasePath = join(root, 'memory.sqlite')
  const runtime = new FakeRuntime()
  const sink = new InMemoryAgentEventSink()
  try {
    const application = await createStudyApplication({
      runtime,
      knowledgeService: null,
      resourceReader: null,
      memoryDatabasePath: databasePath,
      memoryEmbeddingProvider: {
        model: 'test-embedding',
        async embed(texts) { return texts.map(() => [1, 0]) },
      },
      memoryCompletionProvider: {
        async complete() { return JSON.stringify({ candidates: [] }) },
      },
      eventSink: sink,
      runIdFactory: () => 'memory-app-run',
    })
    await application.runTurn({
      query: 'Use the real memory composition.',
      courseContext: { courseCode: 'FIT2109' },
    })
    assert.equal(sink.events.some((event) => event.type === 'memory_observation_completed'), true)
    await application.close()
    assert.equal(runtime.closeCount, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('DeepSeekHarnessRuntime rejects concurrent runs, cleans active state, and closes idempotently', async () => {
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate })
  let calls = 0
  let closeCount = 0
  const harness: DeepSeekHarnessDriver = {
    session() {
      return {
        async run(): Promise<DeepSeekHarnessRunResult> {
          calls += 1
          if (calls === 1) await firstGate
          return {
            sessionId: 'session-concurrent',
            finalResponse: 'Answer',
            events: [{ type: 'turn/end', data: { turn: calls } }],
          }
        },
      }
    },
    async close() {
      closeCount += 1
    },
  }
  const runtime = new DeepSeekHarnessRuntime({ harness })
  const first = runtime.runTurn({ query: 'First' }, { runId: 'run-first', modelProfile: 'fast' })
  await assert.rejects(
    runtime.runTurn({ query: 'Second' }, { runId: 'run-second', modelProfile: 'fast' }),
    (error: unknown) => error instanceof StudyRuntimeError && error.code === 'CONCURRENT_RUN',
  )
  releaseFirst()
  await first
  await runtime.runTurn({ query: 'Third' }, { runId: 'run-third', modelProfile: 'fast' })
  await runtime.close()
  await runtime.close()
  assert.equal(closeCount, 1)
})

test('StudyApplication rejects a second concurrent run with stable CONCURRENT_RUN', async () => {
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolveGate) => { release = resolveGate })
  const startedSignal = new Promise<void>((resolveStarted) => { started = resolveStarted })
  const application = await createStudyApplication({
    runtime: {
      async runTurn() {
        started()
        await gate
        return result('application-concurrent')
      },
    },
    knowledgeService: null,
    resourceReader: null,
    memoryService: null,
    toolServices: {},
  })
  const first = application.runTurn({ query: 'First' })
  await startedSignal
  await assert.rejects(
    application.runTurn({ query: 'Second' }),
    (error: unknown) => error instanceof StudyRuntimeError && error.code === 'CONCURRENT_RUN',
  )
  release()
  await first
  await application.close()
})

test('StudyApplication propagates successful native Research metadata to final synthesis', async () => {
  const taskPrompt = renderResearchTaskPrompt({
    taskId: 'application-research',
    objective: 'Compare two course materials.',
    course: 'FIT2109',
  })
  const harness: DeepSeekHarnessDriver = {
    session() {
      return {
        async run(): Promise<DeepSeekHarnessRunResult> {
          return {
            sessionId: 'research-session',
            finalResponse: 'Evidence-backed synthesis.',
            events: [{ type: 'turn/end', data: { turn: 1 } }],
            notifications: [
              {
                method: 'session.event',
                params: {
                  sessionId: 'research-session',
                  event: {
                    type: 'tool/call',
                    data: { name: 'research_subagent', arguments: JSON.stringify({ prompt: taskPrompt }) },
                  },
                },
              },
              {
                method: 'subagent.started',
                params: { parentSessionId: 'research-session', childSessionId: 'research-child' },
              },
              {
                method: 'subagent.finished',
                params: {
                  parentSessionId: 'research-session',
                  childSessionId: 'research-child',
                  provider: 'spawn',
                  status: 'ok',
                  stopReason: 'completed',
                  lastAssistantMessage: [{
                    type: 'text',
                    text: JSON.stringify({
                      taskId: 'application-research',
                      summary: 'Two materials were compared.',
                      findings: [],
                      evidenceIds: [],
                      limitations: [],
                    }),
                  }],
                },
              },
            ],
          }
        },
      }
    },
  }
  const sink = new InMemoryAgentEventSink()
  const application = await createStudyApplication({
    runtime: new DeepSeekHarnessRuntime({ harness }),
    knowledgeService: null,
    resourceReader: null,
    memoryService: null,
    toolServices: {},
    eventSink: sink,
  })
  try {
    const completed = await application.runTurn({
      query: 'Compare the materials.',
      courseContext: { courseCode: 'FIT2109' },
    })
    assert.equal(completed.answer, 'Evidence-backed synthesis.')
    assert.deepEqual(completed.subagentsUsed, [RESEARCH_SUBAGENT_NAME])
    assert.equal(sink.events.some((event) => event.type === 'subagent_completed'), true)
    assert.equal(sink.events.some((event) => event.type === 'run_failed'), false)
  } finally {
    await application.close()
  }
})

test('StudyApplication recovers from native Research failure when Main synthesis succeeds', async () => {
  const taskPrompt = renderResearchTaskPrompt({
    taskId: 'application-research-failed',
    objective: 'Find the relevant course scope.',
    course: 'FIT2109',
  })
  const harness: DeepSeekHarnessDriver = {
    session() {
      return {
        async run(): Promise<DeepSeekHarnessRunResult> {
          return {
            sessionId: 'research-failure-session',
            finalResponse: 'The direct answer remains available.',
            events: [{ type: 'turn/end', data: { turn: 1 } }],
            notifications: [
              {
                method: 'session.event',
                params: {
                  sessionId: 'research-failure-session',
                  event: {
                    type: 'tool/call',
                    data: { name: 'research_subagent', arguments: JSON.stringify({ prompt: taskPrompt }) },
                  },
                },
              },
              {
                method: 'subagent.started',
                params: { parentSessionId: 'research-failure-session', childSessionId: 'failed-child' },
              },
              {
                method: 'subagent.finished',
                params: {
                  parentSessionId: 'research-failure-session',
                  childSessionId: 'failed-child',
                  provider: 'spawn',
                  status: 'error',
                  stopReason: 'failed',
                },
              },
            ],
          }
        },
      }
    },
  }
  const sink = new InMemoryAgentEventSink()
  const application = await createStudyApplication({
    runtime: new DeepSeekHarnessRuntime({ harness }),
    knowledgeService: null,
    resourceReader: null,
    memoryService: null,
    toolServices: {},
    eventSink: sink,
  })
  try {
    const completed = await application.runTurn({
      query: 'Answer with the direct material you have.',
      courseContext: { courseCode: 'FIT2109' },
    })
    assert.equal(completed.answer, 'The direct answer remains available.')
    assert.deepEqual(completed.subagentsUsed, [RESEARCH_SUBAGENT_NAME])
    assert.equal(sink.events.some((event) => event.type === 'subagent_failed'), true)
    assert.equal(sink.events.some((event) => event.type === 'run_completed'), true)
    assert.equal(sink.events.some((event) => event.type === 'run_failed'), false)
  } finally {
    await application.close()
  }
})
