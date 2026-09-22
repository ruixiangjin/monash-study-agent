import assert from 'node:assert/strict'
import test from 'node:test'

import { StudyToolBridge } from '@monash-study/dsh-integration'
import {
  MAIN_STUDY_AGENT_PROMPT_VERSION,
  MemoryStudentContextBuilder,
  renderMainStudyAgentPrompt,
  type StudentMemoryContext,
  type StudyTurnResult,
} from '@monash-study/study-core'
import { StudyController } from '@monash-study/study-controller'
import type { Evidence, ResourceText, StudentMemory } from '@monash-study/shared-types'

const MEMORY: StudentMemory = {
  memoryId: 'memory-1',
  memoryKey: 'preference:explanation-language',
  kind: 'preference',
  scope: 'global',
  course: null,
  topic: null,
  content: 'Prefers Chinese explanations.',
  status: 'active',
  importance: 0.9,
  confidence: 1,
  sourceType: 'user_explicit',
  sourceSessionId: 'session-1',
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
  lastConfirmedAt: null,
  lastAccessedAt: null,
  accessCount: 0,
}

const MEMORY_CONTEXT: StudentMemoryContext = {
  memory: MEMORY,
  direct: true,
  score: { semantic: 0, keyword: 0, importance: 0.9, confidence: 1, recency: 1, total: 1 },
}

test('StudentContextBuilder recalls current course context and prompt renders it', async () => {
  let request: Record<string, unknown> | undefined
  const builder = new MemoryStudentContextBuilder({
    async recall(input) {
      request = input
      return [MEMORY_CONTEXT]
    },
  })
  const studentContext = await builder.build({
    query: 'Explain Git branches.',
    courseContext: { courseCode: 'FIT2109', topic: 'Git' },
  })
  assert.deepEqual(request, {
    query: 'Explain Git branches.',
    course: 'FIT2109',
    topic: 'Git',
    limit: 8,
    globalLimit: 10,
  })
  const runtimePrompt = renderMainStudyAgentPrompt({
    query: 'Explain Git branches.',
    courseContext: { courseCode: 'FIT2109', topic: 'Git' },
    studentContext,
  })
  assert.match(runtimePrompt.runtimeContext, /Prefers Chinese explanations/)
})

test('StudyController injects built Student Context without coupling to MemoryService', async () => {
  let received: Record<string, unknown> | undefined
  const result: StudyTurnResult = {
    runId: 'run-1',
    answer: 'answer',
    conversation: { sessionId: 'session-1', conversationId: 'session-1' },
    turnId: '1',
    modelProfile: 'fast',
    promptVersion: MAIN_STUDY_AGENT_PROMPT_VERSION,
    evidence: [],
    toolsUsed: [],
  }
  const controller = new StudyController({
    async runTurn(input) {
      received = input as unknown as Record<string, unknown>
      return result
    },
  }, undefined, {
    runIdFactory: () => 'run-1',
    studentContextBuilder: { async build() { return { memories: [MEMORY_CONTEXT] } } },
  })
  await controller.runTurn({ query: 'Question', courseContext: { courseCode: 'FIT2109' } })
  assert.deepEqual((received?.studentContext as { memories: unknown[] }).memories, [MEMORY_CONTEXT])
})

test('StudyToolBridge executes all Round 2 read tools and collects Evidence', async () => {
  const evidence: Evidence = {
    evidenceId: 'evidence-1',
    course: 'FIT2109',
    title: 'Git branch notes',
    content: 'A branch is a movable pointer to a commit.',
    sourceSystem: 'local',
    retrievalProvider: 'local',
    metadata: { source: 'test' },
  }
  const resource: ResourceText = {
    resource: {
      resourceId: 'resource-1',
      course: 'FIT2109',
      week: 1,
      title: 'Git notes',
      source: 'local',
      resourceType: 'resource',
      fileType: 'markdown',
      extension: 'md',
      path: '/tmp/git.md',
      relativePath: 'git.md',
      rootId: 'test',
      modifiedAt: '2026-09-22T00:00:00.000Z',
      sizeBytes: 10,
      hash: 'hash',
      textReadable: true,
    },
    content: '# Git notes',
  }
  let memoryRequest: Record<string, unknown> | undefined
  const bridge = new StudyToolBridge({
    services: {
      knowledgeService: { async search() { return [evidence] } },
      resourceReader: { async readText() { return resource } },
      memoryReader: {
        async recall(input) {
          memoryRequest = input
          return [MEMORY_CONTEXT]
        },
      },
    },
  })
  const endpoint = await bridge.start()
  bridge.begin('run-1', { query: 'Question', courseContext: { courseCode: 'FIT2109' } })
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
    })
    return response.json()
  }
  try {
    const knowledge = await call('search_knowledge', { query: 'Git branch' })
    const resourceResult = await call('get_resource', { resourceId: 'resource-1' })
    const memory = await call('recall_memory', { query: 'Git preferences' })
    assert.equal(knowledge.ok, true)
    assert.deepEqual(knowledge.value.evidence, [evidence])
    assert.deepEqual(resourceResult.value, resource)
    assert.equal(memory.ok, true)
    assert.deepEqual(memoryRequest, { query: 'Git preferences', course: 'FIT2109' })
    assert.deepEqual(bridge.snapshot('run-1'), {
      evidence: [evidence],
      toolsUsed: ['search_knowledge', 'get_resource', 'recall_memory'],
    })
  } finally {
    bridge.end('run-1')
    await bridge.close()
  }
})
