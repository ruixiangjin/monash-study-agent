import { mkdtemp, rm } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DeepSeekHarnessRuntime } from '@monash-study/dsh-integration'
import {
  BgeM3MemoryEmbeddingProvider,
  DeepSeekFlashMemoryCandidateExtractor,
  DeepSeekFlashMemoryProvider,
  MemoryLifecycleManager,
  MemoryResolver,
  MemoryRetriever,
  MemoryService,
  MemoryStore,
} from '@monash-study/memory-service'
import {
  DefaultModelPolicy,
  InMemoryAgentEventSink,
  MemoryStudentContextBuilder,
} from '@monash-study/study-core'
import { StudyController } from '@monash-study/study-controller'

async function main(): Promise<void> {
  const smokeRoot = await mkdtemp(join(tmpdir(), 'monash-study-agent-hybrid-memory-smoke-'))
  const databasePath = join(smokeRoot, 'hybrid-memory.sqlite')
  const store = new MemoryStore({ databasePath })
  const embeddingProvider = new BgeM3MemoryEmbeddingProvider()
  const memoryService = new MemoryService({
    store,
    extractor: new DeepSeekFlashMemoryCandidateExtractor(new DeepSeekFlashMemoryProvider()),
    resolver: new MemoryResolver(store),
    retriever: new MemoryRetriever(store, embeddingProvider),
    lifecycle: new MemoryLifecycleManager(store, embeddingProvider),
  })
  const sink = new InMemoryAgentEventSink()
  const runtime = new DeepSeekHarnessRuntime({
    toolServices: {
      memoryReader: memoryService,
      memoryManager: memoryService,
    },
  })
  const controller = new StudyController(runtime, new DefaultModelPolicy(), {
    eventSink: sink,
    studentContextBuilder: new MemoryStudentContextBuilder(memoryService),
    postTurnObserver: memoryService,
  })

  try {
    const started = performance.now()
    print('Round 3 Hybrid Memory Smoke')
    print(`database: ${databasePath}`)

    const background = await controller.runTurn({
      courseContext: { courseCode: 'FIT2109', topic: 'git' },
      query: 'I keep confusing git reset and git revert when I study them.',
    })
    const observed = store.listActive().find((memory) => (
      memory.sourceSessionId === background.conversation.sessionId
      && /reset|revert/i.test(memory.content)
    ))
    assert(observed !== undefined, 'Post-turn Observation did not persist the Git weakness')
    assert(store.listEvents(observed.memoryId).some((event) => event.operation === 'ADD'), 'Observed Memory ADD event is missing')
    assert(sink.events.some((event) => (
      event.runId === background.runId && event.type === 'memory_observation_completed'
    )), 'Post-turn Observation completion event is missing')
    print('[A] Post-turn Observation: PASS')
    print(`session=${background.conversation.sessionId} memoryId=${observed.memoryId} kind=${observed.kind}`)

    const managed = await controller.runTurn({
      courseContext: { courseCode: 'FIT2109', topic: 'git' },
      query: 'Remember that when explaining Git to me, use a commit graph first. Use manage_memory now and confirm only after it succeeds.',
    })
    assert(managed.toolsUsed.includes('manage_memory'), 'Real Harness did not call manage_memory')
    const strategy = store.listActive().find((memory) => (
      (memory.kind === 'study_strategy' || memory.kind === 'preference')
      && /commit graph|graph/i.test(memory.content)
    ))
    assert(strategy !== undefined, 'manage_memory did not persist the Git explanation strategy')
    assert(managed.evidence.length === 0, 'Memory Tool result entered the Evidence layer')
    print('[B] manage_memory Tool: PASS')
    print(`tools=${managed.toolsUsed.join(',')} memoryId=${strategy.memoryId} operationEvents=${store.listEvents(strategy.memoryId).length}`)

    const directRecall = await memoryService.recall({
      query: 'How should Git concepts be explained?',
      course: 'FIT2109',
      topic: 'git',
    })
    assert(directRecall.some((context) => context.memory.memoryId === strategy.memoryId), 'Persisted strategy was not recallable')

    const crossSession = await controller.runTurn({
      courseContext: { courseCode: 'FIT2109', topic: 'git' },
      query: 'How should you explain Git concepts to me? State the method briefly.',
    })
    assert(crossSession.conversation.sessionId !== managed.conversation.sessionId, 'Cross-session smoke reused the Harness session')
    assert(/graph/i.test(crossSession.answer), 'New Harness session did not use the recalled Git strategy')
    print('[C] Cross-session Recall: PASS')
    print(`writeSession=${managed.conversation.sessionId} recallSession=${crossSession.conversation.sessionId}`)
    print(`latency=${Math.round(performance.now() - started)}ms`)
    print('Overall: PASS')
  } finally {
    await runtime.close()
    store.close()
    await rm(smokeRoot, { recursive: true, force: true })
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function print(message: string): void {
  process.stdout.write(`${message}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`Round 3 Hybrid Memory Smoke: FAIL — ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
