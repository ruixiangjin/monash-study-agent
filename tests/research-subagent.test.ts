import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolve } from 'node:path'

import {
  collectResearchExecutions,
  DeepSeekHarnessRuntime,
  StudyToolBridge,
  type DeepSeekHarnessDriver,
  type DeepSeekHarnessRunResult,
} from '@monash-study/dsh-integration'
import {
  DefaultModelPolicy,
  InMemoryAgentEventSink,
  MAIN_STUDY_AGENT_PROMPT_VERSION,
  parseResearchResultText,
  RESEARCH_SUBAGENT_ACTION_BUDGET,
  RESEARCH_SUBAGENT_NAME,
  RESEARCH_SUBAGENT_PROMPT_VERSION,
  renderResearchTaskPrompt,
  validateResearchTask,
} from '@monash-study/study-core'
import type { Evidence } from '@monash-study/shared-types'

const EVIDENCE_A: Evidence = {
  evidenceId: 'evidence-a',
  course: 'FIT2109',
  title: 'Git merge notes',
  content: 'Fast-forward merge moves the branch pointer when no divergent commit exists.',
  sourceSystem: 'local',
  retrievalProvider: 'lightrag',
  metadata: {},
}

const EVIDENCE_B: Evidence = {
  ...EVIDENCE_A,
  evidenceId: 'evidence-b',
  title: 'Conflict notes',
  content: 'A merge conflict needs manual resolution before the merge can be completed.',
}

test('ResearchTask and ResearchResult contracts validate their first-version fields', () => {
  const task = validateResearchTask({
    taskId: ' research-1 ',
    objective: ' Compare merge strategies. ',
    course: ' FIT2109 ',
    topic: 'Git',
    week: 4,
  })
  assert.deepEqual(task, {
    taskId: 'research-1',
    objective: 'Compare merge strategies.',
    course: 'FIT2109',
    topic: 'Git',
    week: 4,
  })
  assert.throws(() => validateResearchTask({ taskId: 'x', objective: ' ', course: 'FIT2109' }), /objective/)
  assert.throws(() => validateResearchTask({ taskId: 'x', objective: 'Research', course: 'FIT2109', week: -1 }), /week/)
})

test('ResearchResult attribution filters fabricated Evidence IDs', () => {
  const result = parseResearchResultText(JSON.stringify({
    taskId: 'research-1',
    summary: 'The materials distinguish the two cases.',
    findings: [
      { content: 'Fast-forward merge is covered.', evidenceIds: ['evidence-a', 'fabricated-id'] },
      { content: 'Conflict resolution is also covered.', evidenceIds: ['evidence-b'] },
    ],
    evidenceIds: ['evidence-a', 'fabricated-id'],
    limitations: [],
  }), {
    taskId: 'research-1', objective: 'Compare merges.', course: 'FIT2109',
  }, new Set(['evidence-a', 'evidence-b']))

  assert.deepEqual(result.evidenceIds, ['evidence-a', 'evidence-b'])
  assert.deepEqual(result.findings.map(finding => finding.evidenceIds), [['evidence-a'], ['evidence-b']])
  assert.equal(result.limitations.length, 1)
  assert.match(result.limitations[0] ?? '', /discarded/)
})

test('Research adapter maps multiple native child runs to one product boundary', () => {
  const taskPrompt = renderResearchTaskPrompt({
    taskId: 'research-1', objective: 'Compare merge strategies.', course: 'FIT2109', topic: 'Git',
  })
  const prompt2 = renderResearchTaskPrompt({
    taskId: 'research-2', objective: 'Find conflict handling.', course: 'FIT2109', topic: 'Git',
  })
  const notification = (method: string, params: Record<string, unknown>) => ({ method, params })
  const rootCall = (prompt: string) => notification('session.event', {
    sessionId: 'root',
    event: { type: 'tool/call', data: { name: 'research_subagent', arguments: JSON.stringify({ prompt }) } },
  })
  const started = (childSessionId: string) => notification('subagent.started', {
    parentSessionId: 'root', childSessionId,
  })
  const finished = (childSessionId: string, taskId: string, evidenceId: string) => notification('subagent.finished', {
    parentSessionId: 'root', childSessionId, provider: 'spawn', status: 'ok', stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: JSON.stringify({
      taskId, summary: 'Supported finding', findings: [{ content: 'Supported finding', evidenceIds: [evidenceId] }],
      evidenceIds: [evidenceId], limitations: [],
    }) }],
  })

  const snapshot = collectResearchExecutions({
    runId: 'run-1',
    rootSessionId: 'root',
    course: 'FIT2109',
    events: [],
    notifications: [
      rootCall(taskPrompt), started('child-a'), rootCall(prompt2), started('child-b'),
      finished('child-a', 'research-1', 'evidence-a'), finished('child-b', 'research-2', 'evidence-b'),
    ],
    evidence: [EVIDENCE_A, EVIDENCE_B],
  })

  assert.deepEqual(snapshot.subagentsUsed, [RESEARCH_SUBAGENT_NAME])
  assert.equal(snapshot.executions.length, 2)
  assert.deepEqual(snapshot.executions.map(item => item.status), ['completed', 'completed'])
  assert.deepEqual(snapshot.executions.map(item => item.result?.evidenceIds), [['evidence-a'], ['evidence-b']])
})

test('Research adapter turns a failed native child into a recoverable product result', () => {
  const taskPrompt = renderResearchTaskPrompt({ taskId: 'research-failed', objective: 'Compare merges.', course: 'FIT2109' })
  const notification = (method: string, params: Record<string, unknown>) => ({ method, params })
  const snapshot = collectResearchExecutions({
    runId: 'run-failed',
    rootSessionId: 'root',
    course: 'FIT2109',
    events: [],
    notifications: [
      notification('session.event', {
        sessionId: 'root',
        event: { type: 'tool/call', data: { name: 'research_subagent', arguments: JSON.stringify({ prompt: taskPrompt }) } },
      }),
      notification('subagent.started', { parentSessionId: 'root', childSessionId: 'child-failed' }),
      notification('subagent.finished', {
        parentSessionId: 'root', childSessionId: 'child-failed', provider: 'spawn', status: 'error', stopReason: 'failed',
      }),
    ],
    evidence: [EVIDENCE_A],
  })

  assert.deepEqual(snapshot.subagentsUsed, [RESEARCH_SUBAGENT_NAME])
  assert.equal(snapshot.executions[0]?.status, 'failed')
  assert.match(snapshot.executions[0]?.result?.limitations[0] ?? '', /did not complete/)
})

test('Cordis patch gives the native Research Subagent only bounded read-only tools', () => {
  const patch = readFileSync(resolve(process.cwd(), 'config/main-agent.cordis.patch.yml'), 'utf8')
  const researchConfig = patch.slice(patch.indexOf('name: \'@deepseek-ai/dsh-tool-subagent\''))
  assert.match(researchConfig, /toolName: research_subagent/)
  assert.match(researchConfig, /maxDepth: 1/)
  assert.match(researchConfig, /- search_knowledge/)
  assert.match(researchConfig, /- get_resource/)
  assert.doesNotMatch(researchConfig, /- (?:recall_memory|manage_memory|research_subagent)/)
  assert.match(patch, /- id: tool-subagent\n  disabled: true/)
  assert.match(patch, /- id: tool-subagent-fork\n  disabled: true/)
})

test('Research Subagent has a bounded read-only retrieval budget', async () => {
  const evidence: Evidence = { ...EVIDENCE_A, evidenceId: 'budget-evidence' }
  const bridge = new StudyToolBridge({
    maxResearchActions: 2,
    services: { knowledgeService: { async search() { return [evidence] } } },
  })
  const endpoint = await bridge.start()
  bridge.begin('budget-run', { query: 'Research', courseContext: { courseCode: 'FIT2109' } })
  const call = async (): Promise<any> => {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'search_knowledge', arguments: { query: 'merge' } }),
    })
    return response.json()
  }
  try {
    assert.equal((await call()).ok, true)
    assert.equal((await call()).ok, true)
    const rejected = await call()
    assert.equal(rejected.ok, false)
    assert.match(rejected.error.message, /budget exhausted/)
  } finally {
    bridge.end('budget-run')
    await bridge.close()
  }
  assert.equal(RESEARCH_SUBAGENT_ACTION_BUDGET, 8)
})

test('Native subagent lifecycle is adapted into safe product events and result metadata', async () => {
  const sink = new InMemoryAgentEventSink()
  const taskPrompt = renderResearchTaskPrompt({ taskId: 'research-runtime', objective: 'Compare merges.', course: 'FIT2109' })
  const harness: DeepSeekHarnessDriver = {
    session() {
      return {
        async run(): Promise<DeepSeekHarnessRunResult> {
          return {
            sessionId: 'root',
            finalResponse: 'Synthesized answer.',
            events: [{ type: 'turn/end', data: { turn: 1 } }],
            notifications: [
              { method: 'session.event', params: { sessionId: 'root', event: { type: 'tool/call', data: { name: 'research_subagent', arguments: JSON.stringify({ prompt: taskPrompt }) } } } },
              { method: 'subagent.started', params: { parentSessionId: 'root', childSessionId: 'child' } },
              { method: 'subagent.finished', params: {
                parentSessionId: 'root', childSessionId: 'child', provider: 'spawn', status: 'ok', stopReason: 'completed',
                lastAssistantMessage: [{ type: 'text', text: JSON.stringify({ taskId: 'research-runtime', summary: 'done', findings: [], evidenceIds: [], limitations: [] }) }],
              } },
            ],
          }
        },
      }
    },
  }
  const runtime = new DeepSeekHarnessRuntime({ harness })
  try {
    const result = await runtime.runTurn({ query: 'Research the merge topic.', courseContext: { courseCode: 'FIT2109' } }, { runId: 'run-runtime', eventSink: sink, modelProfile: 'fast' })
    assert.deepEqual(result.subagentsUsed, [RESEARCH_SUBAGENT_NAME])
    assert.equal(result.researchActions, 0)
    assert.equal(sink.events.some(event => event.type === 'subagent_started' && event.subagentName === RESEARCH_SUBAGENT_NAME), true)
    assert.equal(sink.events.some(event => event.type === 'subagent_completed' && event.taskId === 'research-runtime'), true)
    assert.equal(sink.events.some(event => event.type === 'subagent_failed'), false)
  } finally {
    await runtime.close()
  }
  assert.equal(MAIN_STUDY_AGENT_PROMPT_VERSION, 'main-study-agent-v5')
  assert.equal(RESEARCH_SUBAGENT_PROMPT_VERSION, 'research-subagent-v2')
  assert.equal(new DefaultModelPolicy().selectModel('research_agent'), 'strong')
})
