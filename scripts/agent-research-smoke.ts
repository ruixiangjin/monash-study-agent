import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

import {
  DeepSeekHarnessRuntime,
} from '@monash-study/dsh-integration'
import {
  DefaultModelPolicy,
  InMemoryAgentEventSink,
  RESEARCH_SUBAGENT_NAME,
} from '@monash-study/study-core'
import { LightRAGKnowledgeService, LocalKnowledgeService } from '@monash-study/knowledge-service'
import type { ResourceManifest } from '@monash-study/shared-types'
import { StudyController } from '@monash-study/study-controller'
import { loadApplicationEnvironment, loadRuntimeConfig } from '@monash-study/knowledge-service'

async function main(): Promise<void> {
  const runtimeConfig = loadRuntimeConfig()
  loadApplicationEnvironment(runtimeConfig.applicationRoot)
  const manifestPath = runtimeConfig.resourceManifestPath
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ResourceManifest
  const resourceReader = new LocalKnowledgeService({ roots: manifest.roots, manifestPath })
  await resourceReader.loadManifest()
  const sink = new InMemoryAgentEventSink()
  const runtime = new DeepSeekHarnessRuntime({
    applicationRoot: runtimeConfig.applicationRoot,
    toolServices: {
      knowledgeService: new LightRAGKnowledgeService({ runtimeConfig }),
      resourceReader,
    },
  })
  const controller = new StudyController(runtime, new DefaultModelPolicy(), { eventSink: sink })
  const started = performance.now()

  try {
    const result = await controller.runTurn({
      courseContext: { courseCode: 'FIT2109', topic: 'Git merge' },
      query: [
        'This is a complex course-research task. Delegate it to research_subagent before answering.',
        'Create a complete ResearchTask for FIT2109 with a fresh taskId and objective.',
        'Ask the Research Subagent to adaptively compare fast-forward merge, three-way merge, and merge conflict resolution.',
        'It should use multiple relevant FIT2109 materials, use get_resource when a precise reading is useful, and return a strict ResearchResult JSON.',
        'After the child completes, synthesize an evidence-backed explanation for the student and mention any limitations.',
      ].join(' '),
    })

    const completed = sink.events.find(event => event.type === 'subagent_completed' && event.subagentName === RESEARCH_SUBAGENT_NAME)
    const failed = sink.events.find(event => event.type === 'subagent_failed' && event.subagentName === RESEARCH_SUBAGENT_NAME)
    assert(result.subagentsUsed.includes(RESEARCH_SUBAGENT_NAME), 'Main Agent did not invoke the Research Subagent')
    assert(completed !== undefined, 'Research Subagent did not emit a completed lifecycle event')
    assert(failed === undefined, 'Research Subagent emitted a failure lifecycle event')
    assert((completed.evidenceCount ?? 0) > 0, 'ResearchResult did not retain real Evidence attribution')
    assert(result.researchActions >= 2, `Expected multi-step research actions, got ${result.researchActions}`)
    assert(result.toolsUsed.includes('search_knowledge'), 'Research smoke did not call search_knowledge')
    assert(result.toolsUsed.includes('get_resource'), 'Research smoke did not call get_resource')
    assert(result.evidence.length > 0, 'Final StudyTurnResult has no Evidence')
    assert(result.evidence.every(item => item.retrievalProvider === 'lightrag'), 'Evidence did not come from real LightRAG')
    assert(result.answer.trim().length > 0, 'Main Agent final synthesis is empty')

    print('Round 4 Real Multi-Agent Research Smoke')
    print('native Harness Research Subagent: PASS')
    print(`subagents used: ${result.subagentsUsed.join(', ')}`)
    print(`research actions: ${result.researchActions}`)
    print(`tools used: ${result.toolsUsed.join(', ')}`)
    print(`evidence count: ${result.evidence.length}`)
    print(`evidence ids: ${result.evidence.map(item => item.evidenceId).join(', ')}`)
    print(`final synthesis: PASS (${Math.round(performance.now() - started)}ms)`)
    print('answer:')
    print(result.answer.trim())
  } finally {
    await runtime.close()
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function print(message: string): void {
  process.stdout.write(`${message}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`Round 4 Real Multi-Agent Research Smoke: FAIL — ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
