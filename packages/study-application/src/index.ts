import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  DeepSeekFlashMemoryCandidateExtractor,
  DeepSeekFlashMemoryProvider,
  BgeM3MemoryEmbeddingProvider,
  MemoryLifecycleManager,
  MemoryResolver,
  MemoryRetriever,
  MemoryService,
  MemoryStore,
  type MemoryCompletionProvider,
  type MemoryEmbeddingProvider,
} from '@monash-study/memory-service'
import {
  LightRAGKnowledgeService,
  LocalKnowledgeService,
  loadRuntimeConfig,
  type LoadedRuntimeConfig,
} from '@monash-study/knowledge-service'
import {
  DeepSeekHarnessRuntime,
  type DeepSeekHarnessDriver,
  type DeepSeekHarnessRuntimeOptions,
} from '@monash-study/dsh-integration'
import {
  DefaultModelPolicy,
  MemoryStudentContextBuilder,
  StudyRuntimeError,
  type AgentEventSink,
  type KnowledgeService,
  type ModelPolicy,
  type StudyAgentRuntime,
  type StudyAgentToolServices,
  type StudyMemoryManager,
  type StudyMemoryReader,
  type StudyPostTurnObserver,
  type StudyResourceReader,
  type StudyTurnInput,
  type StudyTurnOptions,
  type StudyTurnResult,
  type StudentContextBuilder,
} from '@monash-study/study-core'
import { StudyController, type StudyControllerOptions } from '@monash-study/study-controller'
import type { ResourceManifest } from '@monash-study/shared-types'

export interface StudyApplicationOptions {
  readonly configPath?: string
  readonly runtimeConfig?: LoadedRuntimeConfig
  readonly knowledgeService?: KnowledgeService | null
  readonly resourceReader?: StudyResourceReader | null
  readonly resourceManifestPath?: string
  readonly memoryService?: MemoryService | null
  readonly memoryStore?: MemoryStore
  readonly memoryDatabasePath?: string
  readonly memoryEmbeddingProvider?: MemoryEmbeddingProvider
  readonly memoryCompletionProvider?: MemoryCompletionProvider
  readonly memoryReader?: StudyMemoryReader | null
  readonly memoryManager?: StudyMemoryManager | null
  readonly toolServices?: StudyAgentToolServices
  readonly runtime?: StudyAgentRuntime
  readonly harness?: DeepSeekHarnessDriver
  readonly createHarness?: DeepSeekHarnessRuntimeOptions['createHarness']
  readonly harnessOptions?: DeepSeekHarnessRuntimeOptions['harnessOptions']
  readonly promptPatchPath?: string
  readonly modelPolicy?: ModelPolicy
  readonly eventSink?: AgentEventSink
  readonly runIdFactory?: () => string
  readonly studentContextBuilder?: StudentContextBuilder | null
  readonly postTurnObserver?: StudyPostTurnObserver | null
}

export interface StudyApplication {
  runTurn(input: StudyTurnInput, options?: StudyTurnOptions): Promise<StudyTurnResult>
  close(): Promise<void>
}

/**
 * The single product composition root used by the future UI and by integration tests.
 * Provider construction stays here; callers receive only the stable Study contract.
 */
export async function createStudyApplication(
  options: StudyApplicationOptions = {},
): Promise<StudyApplication> {
  const runtimeConfig = options.runtimeConfig ?? loadRuntimeConfig(options.configPath)
  const knowledgeService = options.knowledgeService === undefined
    ? new LightRAGKnowledgeService({ configPath: runtimeConfig.configPath })
    : options.knowledgeService
  const resourceReader = options.resourceReader === undefined
    ? await createResourceReader(options.resourceManifestPath ?? resolve(runtimeConfig.repositoryRoot, 'resources/resources.json'))
    : options.resourceReader

  const memoryStore = options.memoryService === null
    ? undefined
    : options.memoryStore ?? new MemoryStore({
      databasePath: options.memoryDatabasePath ?? runtimeConfig.lightrag.sqlitePath,
    })
  const memoryService = options.memoryService === undefined
    ? createMemoryService(
      memoryStore,
      options.memoryEmbeddingProvider,
      options.memoryCompletionProvider,
    )
    : options.memoryService
  const memoryReader = options.memoryReader === undefined ? memoryService : options.memoryReader
  const memoryManager = options.memoryManager === undefined ? memoryService : options.memoryManager
  const toolServices = options.toolServices ?? {
    ...(knowledgeService === null ? {} : { knowledgeService }),
    ...(resourceReader === null ? {} : { resourceReader }),
    ...(memoryReader === null || memoryReader === undefined ? {} : { memoryReader }),
    ...(memoryManager === null || memoryManager === undefined ? {} : { memoryManager }),
  }
  const runtime = options.runtime ?? new DeepSeekHarnessRuntime({
    ...(options.harness === undefined ? {} : { harness: options.harness }),
    ...(options.createHarness === undefined ? {} : { createHarness: options.createHarness }),
    ...(options.harnessOptions === undefined ? {} : { harnessOptions: options.harnessOptions }),
    ...(options.promptPatchPath === undefined ? {} : { promptPatchPath: options.promptPatchPath }),
    toolServices,
  })
  const studentContextBuilder = options.studentContextBuilder === undefined
    ? memoryReader === undefined || memoryReader === null ? undefined : new MemoryStudentContextBuilder(memoryReader)
    : options.studentContextBuilder
  const postTurnObserver = options.postTurnObserver === null
    ? undefined
    : options.postTurnObserver ?? memoryService ?? undefined
  const controllerOptions = {
    ...(options.eventSink === undefined ? {} : { eventSink: options.eventSink }),
    ...(options.runIdFactory === undefined ? {} : { runIdFactory: options.runIdFactory }),
    ...(studentContextBuilder === null || studentContextBuilder === undefined ? {} : { studentContextBuilder }),
    ...(postTurnObserver === undefined ? {} : { postTurnObserver }),
  } satisfies StudyControllerOptions
  const controller = new StudyController(
    runtime,
    options.modelPolicy ?? new DefaultModelPolicy(),
    controllerOptions,
  )
  let closed = false
  let active = false

  return {
    runTurn(input, runOptions = {}) {
      if (closed) {
        return Promise.reject(new StudyRuntimeError(
          'HARNESS_ERROR',
          'DeepSeek Harness could not complete the Study Agent turn.',
        ))
      }
      if (active) {
        return Promise.reject(new StudyRuntimeError('CONCURRENT_RUN', 'Another Study Agent turn is already running.'))
      }
      active = true
      return controller.runTurn(input, runOptions).finally(() => {
        active = false
      })
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      try {
        await closeRuntime(runtime)
      } finally {
        try {
          memoryStore?.close()
        } finally {
          closeKnowledgeService(knowledgeService)
        }
      }
    },
  }
}

function createMemoryService(
  store: MemoryStore | undefined,
  embeddingProvider: MemoryEmbeddingProvider | undefined,
  completionProvider: MemoryCompletionProvider | undefined,
): MemoryService | undefined {
  if (store === undefined) return undefined
  const embedding = embeddingProvider ?? new BgeM3MemoryEmbeddingProvider()
  return new MemoryService({
    store,
    extractor: new DeepSeekFlashMemoryCandidateExtractor(
      completionProvider ?? new DeepSeekFlashMemoryProvider(),
    ),
    resolver: new MemoryResolver(store),
    retriever: new MemoryRetriever(store, embedding),
    lifecycle: new MemoryLifecycleManager(store, embedding),
  })
}

async function createResourceReader(manifestPath: string): Promise<LocalKnowledgeService> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ResourceManifest
  const reader = new LocalKnowledgeService({ roots: manifest.roots, manifestPath })
  await reader.loadManifest()
  return reader
}

async function closeRuntime(runtime: StudyAgentRuntime): Promise<void> {
  const close = (runtime as StudyAgentRuntime & { close?: () => Promise<void> }).close
  if (close !== undefined) await close.call(runtime)
}

function closeKnowledgeService(service: KnowledgeService | null): void {
  const close = (service as KnowledgeService & { close?: () => void } | null)?.close
  close?.call(service)
}
