import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  DeepSeekHarnessRuntime,
} from '@monash-study/dsh-integration'
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
  MemoryStudentContextBuilder,
  type StudyMemoryReader,
} from '@monash-study/study-core'
import { StudyController } from '@monash-study/study-controller'
import { LocalKnowledgeService } from '@monash-study/knowledge-service'
import type { Evidence, ResourceManifest } from '@monash-study/shared-types'

const TOOL_EVIDENCE_ID = 'smoke-evidence-ORANGE-731'

async function main(): Promise<void> {
  const smokeRoot = await mkdtemp(join(tmpdir(), 'monash-study-agent-tools-smoke-'))
  const databasePath = join(smokeRoot, 'memory.sqlite')
  const store = new MemoryStore({ databasePath })
  const embeddingProvider = new BgeM3MemoryEmbeddingProvider()
  const memoryService = createMemoryService(store, embeddingProvider)
  const resourceReader = await createResourceReader()
  const knowledgeService = {
    async search(): Promise<readonly Evidence[]> {
      return [{
        evidenceId: TOOL_EVIDENCE_ID,
        resourceId: 'smoke-resource',
        course: 'FIT2109',
        title: 'Tool-calling smoke fixture',
        content: 'The smoke fixture confirms that search_knowledge returned product Evidence.',
        sourceSystem: 'local',
        retrievalProvider: 'local',
        metadata: { smoke: true },
      }]
    },
  }
  const runtime = new DeepSeekHarnessRuntime({
    toolServices: {
      knowledgeService,
      resourceReader,
      memoryReader: memoryService,
      memoryManager: memoryService,
    },
  })
  const controller = new StudyController(
    runtime,
    new DefaultModelPolicy(),
    { studentContextBuilder: new MemoryStudentContextBuilder(memoryService) },
  )

  try {
    const started = performance.now()
    const result = await controller.runTurn({
      courseContext: { courseCode: 'FIT2109', topic: 'Git' },
      query: 'Before answering, you must call recall_memory for Git study preferences and search_knowledge for the query "Git branch". After both tools return, briefly explain what a Git branch is and mention the returned Evidence marker.',
    })
    const latency = performance.now() - started
    assert(result.toolsUsed.includes('search_knowledge'), 'Real Harness did not call search_knowledge')
    assert(result.toolsUsed.includes('recall_memory'), 'Real Harness did not call recall_memory')
    assert(result.evidence.some((item) => item.evidenceId === TOOL_EVIDENCE_ID), 'Tool Evidence did not reach StudyTurnResult')
    print('Round 2 Main Agent Tool Smoke')
    print('tool calling: PASS')
    print('evidence propagation: PASS')
    print(`tools used: ${result.toolsUsed.join(', ')}`)
    print(`evidence ids: ${result.evidence.map((item) => item.evidenceId).join(', ')}`)
    print(`session id: ${result.conversation.sessionId}`)
    print(`conversation id: ${result.conversation.conversationId}`)
    print(`turn id: ${result.turnId}`)
    print(`model profile: ${result.modelProfile}`)
    print(`prompt version: ${result.promptVersion}`)
    print(`latency: ${Math.round(latency)}ms`)
    print('answer:')
    print(result.answer.trim())
  } finally {
    await runtime.close()
    store.close()
    await rm(smokeRoot, { recursive: true, force: true })
  }
}

function createMemoryService(store: MemoryStore, embeddingProvider: BgeM3MemoryEmbeddingProvider): MemoryService {
  return new MemoryService({
    store,
    extractor: new DeepSeekFlashMemoryCandidateExtractor(new DeepSeekFlashMemoryProvider()),
    resolver: new MemoryResolver(store),
    retriever: new MemoryRetriever(store, embeddingProvider),
    lifecycle: new MemoryLifecycleManager(store, embeddingProvider),
  })
}

async function createResourceReader(): Promise<LocalKnowledgeService> {
  const manifestPath = resolve(process.cwd(), 'resources/resources.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ResourceManifest
  const reader = new LocalKnowledgeService({ roots: manifest.roots, manifestPath })
  await reader.loadManifest()
  return reader
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function print(message: string): void {
  process.stdout.write(`${message}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`Round 2 Main Agent Tool Smoke: FAIL — ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
