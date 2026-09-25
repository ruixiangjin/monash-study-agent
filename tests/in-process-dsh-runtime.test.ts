import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { InProcessDshRuntime } from '@monash-study/dsh-integration'

test('restored-session tool calls use the current-process StudyToolBridge binding', async () => {
  const agentLike = {
    id: 'restored-session',
    whenIdle: async () => {},
    session: {
      snapshotEvents: () => [
        { type: 'turn/end', data: { turn: 2 } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Retrieved answer.' }] } } },
      ],
    },
  }
  const agent = agentLike as never
  let toolResult: unknown
  let restoredRuntime!: InProcessDshRuntime
  const sessionController = {
    async create() {
      return { sessionId: agentLike.id }
    },
    async selectModel() {},
    async prompt() {
      toolResult = await restoredRuntime.executeTool(
        'search_knowledge',
        { query: 'restored query', course: 'FIT2109' },
        agent,
      )
    },
  }
  const createContext = (): Context => {
    const ctx = new Context()
    ctx.provide('agents', { get: () => agent } as never)
    ctx.provide('sessionController', sessionController as never)
    return ctx
  }
  const hostRuntime = new InProcessDshRuntime(createContext(), { applicationRoot: '/tmp/monash-study-agent-binding-test' })
  restoredRuntime = new InProcessDshRuntime(createContext(), { applicationRoot: '/tmp/monash-study-agent-binding-test' })

  hostRuntime.configure({
    knowledgeService: {
      async search() {
        return [{
          evidenceId: 'restored-evidence',
          course: 'FIT2109',
          title: 'Git merge notes',
          content: 'Evidence from the current process.',
          sourceSystem: 'local',
          retrievalProvider: 'lightrag',
          metadata: {},
        }]
      },
    },
  })
  await restoredRuntime.close()

  try {
    const result = await hostRuntime.runTurn({
      query: 'Continue the restored study session.',
      courseContext: { courseCode: 'FIT2109' },
      conversation: { sessionId: agentLike.id, conversationId: agentLike.id },
    })
    assert.equal(result.answer, 'Retrieved answer.')
    assert.deepEqual(toolResult, {
      course: 'FIT2109',
      query: 'restored query',
      evidence: [{
        evidenceId: 'restored-evidence',
        course: 'FIT2109',
        title: 'Git merge notes',
        content: 'Evidence from the current process.',
        sourceSystem: 'local',
        retrievalProvider: 'lightrag',
        metadata: {},
      }],
      evidenceCount: 1,
    })
  } finally {
    await hostRuntime.close()
    await restoredRuntime.close()
  }
})

test('restored direct tool calls lazily initialize services and use a temporary Study turn', async () => {
  const agentLike = { id: 'restored-direct-session' }
  const agent = agentLike as never
  let runtime!: InProcessDshRuntime
  let ensureCount = 0
  const context = new Context()
  context.provide('agents', { get: () => agent } as never)
  context.provide('sessionController', {} as never)
  context.provide('monashStudyUi', {
    async ensureApplication() {
      ensureCount += 1
      runtime.configure({
        knowledgeService: {
          async search() {
            return [{
              evidenceId: 'restored-direct-evidence',
              course: 'FIT2109',
              title: 'Restored Git notes',
              content: 'A three-way merge uses a common ancestor.',
              sourceSystem: 'local',
              retrievalProvider: 'lightrag',
              metadata: {},
            }]
          },
        },
      })
    },
  } as never)
  runtime = new InProcessDshRuntime(context, { applicationRoot: '/tmp/monash-study-agent-direct-tool-test' })

  try {
    const result = await runtime.executeTool(
      'search_knowledge',
      { query: 'three-way merge', course: 'FIT2109' },
      agent,
    )
    assert.equal(ensureCount, 1)
    assert.deepEqual(result, {
      course: 'FIT2109',
      query: 'three-way merge',
      evidence: [{
        evidenceId: 'restored-direct-evidence',
        course: 'FIT2109',
        title: 'Restored Git notes',
        content: 'A three-way merge uses a common ancestor.',
        sourceSystem: 'local',
        retrievalProvider: 'lightrag',
        metadata: {},
      }],
      evidenceCount: 1,
    })
  } finally {
    await runtime.close()
  }
})
