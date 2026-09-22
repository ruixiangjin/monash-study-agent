import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DeepSeekHarnessRuntime,
  type DeepSeekHarnessDriver,
  type DeepSeekHarnessRunResult,
} from '@monash-study/dsh-integration'
import {
  DefaultModelPolicy,
  InMemoryAgentEventSink,
  MAIN_STUDY_AGENT_PROMPT_VERSION,
  renderMainStudyAgentPrompt,
  StudyRuntimeError,
  type StudyAgentRuntime,
  type StudyTurnResult,
} from '@monash-study/study-core'
import { StudyController } from '@monash-study/study-controller'

test('Main Study Agent prompt keeps version, course context, and query invariants', () => {
  const rendered = renderMainStudyAgentPrompt({
    query: 'Explain branches.',
    courseContext: { courseCode: 'FIT2109', week: 4, topic: 'Git' },
  })
  assert.equal(MAIN_STUDY_AGENT_PROMPT_VERSION, 'main-study-agent-v2')
  assert.match(rendered.systemPrompt, /Monash Study Agent/)
  assert.match(rendered.runtimeContext, /courseCode: FIT2109/)
  assert.match(rendered.runtimeContext, /week: 4/)
  assert.match(rendered.runtimeContext, /topic: Git/)
  assert.match(rendered.userPrompt, /Explain branches\./)
  assert.doesNotMatch(renderMainStudyAgentPrompt({ query: 'Hello' }).runtimeContext, /undefined/)
})

test('Round 1 ModelPolicy selects the fast logical profile without an extra model call', () => {
  assert.equal(new DefaultModelPolicy().selectModel('main_agent'), 'fast')
})

test('StudyController validates, selects a model, injects runId, and returns the runtime result', async () => {
  const calls: { query: string; courseCode: string | undefined; profile: string | undefined }[] = []
  const result: StudyTurnResult = {
    runId: 'runtime-run',
    answer: 'Branches are movable pointers.',
    conversation: { sessionId: 'session-a', conversationId: 'session-a' },
    turnId: '1',
    modelProfile: 'fast',
    promptVersion: MAIN_STUDY_AGENT_PROMPT_VERSION,
    evidence: [],
    toolsUsed: [],
  }
  const runtime: StudyAgentRuntime = {
    async runTurn(input, options) {
      calls.push({ query: input.query, courseCode: input.courseContext?.courseCode, profile: options?.modelProfile })
      return result
    },
  }
  let policyCalls = 0
  const controller = new StudyController(runtime, {
    selectModel(task) {
      assert.equal(task, 'main_agent')
      policyCalls += 1
      return 'fast'
    },
  }, { runIdFactory: () => 'controller-run' })

  const actual = await controller.runTurn({ query: '  Explain branches.  ', courseContext: { courseCode: 'FIT2109' } })
  assert.equal(actual.runId, 'controller-run')
  assert.equal(actual.answer, result.answer)
  assert.equal(policyCalls, 1)
  assert.deepEqual(calls, [{ query: 'Explain branches.', courseCode: 'FIT2109', profile: 'fast' }])
})

test('DeepSeekHarnessRuntime creates and then continues the same Harness conversation', async () => {
  const calls: (string | undefined)[] = []
  let turn = 0
  const harness: DeepSeekHarnessDriver = {
    session(sessionId) {
      calls.push(sessionId)
      const id = sessionId ?? 'harness-session-a'
      return {
        async run(_input): Promise<DeepSeekHarnessRunResult> {
          turn += 1
          return {
            sessionId: id,
            finalResponse: turn === 1 ? 'First answer.' : 'ORANGE-731',
            events: [{ type: 'turn/start', data: { turn } }],
          }
        },
      }
    },
  }
  const sink = new InMemoryAgentEventSink()
  const runtime = new DeepSeekHarnessRuntime({ harness })

  const first = await runtime.runTurn({ query: 'Remember ORANGE-731.' }, { runId: 'run-a', eventSink: sink, modelProfile: 'fast' })
  const second = await runtime.runTurn({ query: 'What marker?', conversation: first.conversation }, { runId: 'run-b', eventSink: sink, modelProfile: 'fast' })

  assert.deepEqual(calls, [undefined, 'harness-session-a'])
  assert.deepEqual(first.conversation, { sessionId: 'harness-session-a', conversationId: 'harness-session-a' })
  assert.equal(second.turnId, '2')
  assert.equal(second.answer, 'ORANGE-731')
  assert.deepEqual(sink.events.map((event) => event.type), [
    'model_started', 'model_completed', 'answer_completed',
    'model_started', 'model_completed', 'answer_completed',
  ])
})

test('StudyController emits the required success event order', async () => {
  const sink = new InMemoryAgentEventSink()
  const harness: DeepSeekHarnessDriver = {
    session() {
      return {
        async run(): Promise<DeepSeekHarnessRunResult> {
          return { sessionId: 'session-a', finalResponse: 'answer', events: [{ type: 'turn/start', data: { turn: 1 } }] }
        },
      }
    },
  }
  const controller = new StudyController(
    new DeepSeekHarnessRuntime({ harness }),
    new DefaultModelPolicy(),
    { eventSink: sink, runIdFactory: () => 'run-a' },
  )

  await controller.runTurn({ query: 'Question' })
  assert.deepEqual(sink.events.map((event) => event.type), [
    'run_started', 'model_started', 'model_completed', 'answer_completed', 'run_completed',
  ])
})

test('Harness failures are translated once at the runtime boundary and emit one run_failed', async () => {
  const sink = new InMemoryAgentEventSink()
  const harness: DeepSeekHarnessDriver = {
    session() {
      return {
        async run(): Promise<DeepSeekHarnessRunResult> {
          throw new Error('raw provider detail should remain the cause')
        },
      }
    },
  }
  const controller = new StudyController(
    new DeepSeekHarnessRuntime({ harness }),
    new DefaultModelPolicy(),
    { eventSink: sink, runIdFactory: () => 'run-failure' },
  )

  await assert.rejects(
    controller.runTurn({ query: 'Question' }),
    (error: unknown) => error instanceof StudyRuntimeError
      && error.code === 'HARNESS_ERROR'
      && error.message === 'DeepSeek Harness could not complete the Study Agent turn.',
  )
  assert.equal(sink.events.filter((event) => event.type === 'run_failed').length, 1)
})
