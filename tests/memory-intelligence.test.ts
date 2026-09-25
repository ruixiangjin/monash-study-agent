import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  BgeM3MemoryEmbeddingProvider,
  DeepSeekFlashMemoryCandidateExtractor,
  DeepSeekFlashMemoryProvider,
  MemoryLifecycleManager,
  MemoryResolver,
  MemoryRetriever,
  MemoryService,
  MemoryStore,
  type MemoryCandidate,
  type MemoryCompletionProvider,
  type MemoryEmbeddingProvider,
} from '@monash-study/memory-service'
import { loadRuntimeConfig } from '@monash-study/knowledge-service'

test('wires real model adapters without executing real model calls', async () => {
  let requestBody: Record<string, any> | undefined
  const provider = new DeepSeekFlashMemoryProvider({
    apiKey: 'test-key',
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, any>
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"candidates":[]}' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  assert.equal(await provider.complete('system', 'turn'), '{"candidates":[]}')
  assert.equal(requestBody?.model, 'deepseek-flash')
  assert.deepEqual(requestBody?.thinking, { type: 'disabled' })

  const runtimeConfig = loadRuntimeConfig()
  const embedding = new BgeM3MemoryEmbeddingProvider({
    pythonPath: runtimeConfig.pythonExecutable,
    workerPath: runtimeConfig.workers.memoryEmbedding,
  })
  assert.equal(embedding.model, 'BAAI/bge-m3')
})

test('extracts and validates structured DeepSeek Flash candidates without a real model call', async () => {
  const completion: MemoryCompletionProvider = {
    async complete() {
      return JSON.stringify({
        candidates: [{
          operation: 'UPDATE',
          kind: 'preference',
          scope: 'global',
          memoryKey: ' Preference : Explanation Language ',
          content: 'Prefers Chinese-only explanations.',
          importance: 0.9,
          confidence: 1,
          sourceType: 'user_explicit',
        }],
      })
    },
  }
  const extractor = new DeepSeekFlashMemoryCandidateExtractor(completion)
  const candidates = await extractor.extract({
    userMessage: '以后只用中文。',
    assistantResponse: '好的。',
    sourceSessionId: 'session-b',
  })
  assert.deepEqual(candidates, [{
    operation: 'UPDATE',
    kind: 'preference',
    scope: 'global',
    memoryKey: 'preference:explanation-language',
    content: 'Prefers Chinese-only explanations.',
    importance: 0.9,
    confidence: 1,
    sourceType: 'user_explicit',
    sourceSessionId: 'session-b',
  }])
})

test('accepts the model summary alias and fills only safe extraction defaults', async () => {
  const extractor = new DeepSeekFlashMemoryCandidateExtractor({
    async complete() {
      return JSON.stringify({ candidates: [{
        operation: 'ADD',
        kind: 'preference',
        scope: 'global',
        memoryKey: 'preference:bilingual_explanation',
        summary: 'Prefers bilingual explanations.',
        sourceType: 'user_explicit',
        confidence: 0.95,
      }] })
    },
  })
  const [candidate] = await extractor.extract({
    userMessage: '我喜欢中英双语解释。',
    assistantResponse: '好的。',
    sourceSessionId: 'session-summary-alias',
  })
  assert.equal(candidate?.memoryKey, 'preference:explanation-language')
  assert.equal(candidate?.content, 'Prefers bilingual explanations.')
  assert.equal(candidate?.importance, 0.7)
})

test('normalizes model-added topic details away from course scope', async () => {
  const extractor = new DeepSeekFlashMemoryCandidateExtractor({
    async complete() {
      return JSON.stringify({ candidates: [{
        operation: 'ADD', kind: 'weakness', scope: 'course', course: 'FIT2014', topic: 'pumping-lemma',
        memoryKey: 'weakness:FIT2014:pumping-lemma', summary: 'Weak proof structure.',
        importance: 0.8, confidence: 0.9, sourceType: 'user_explicit',
      }] })
    },
  })
  const [candidate] = await extractor.extract({
    userMessage: 'Pumping Lemma 不好。', assistantResponse: '好的。', sourceSessionId: 'session-scope', course: 'FIT2014',
  })
  assert.equal(candidate?.scope, 'course')
  assert.equal(candidate?.course, 'FIT2014')
  assert.equal(candidate?.topic, null)
})

test('derives a stable course key when the model omits memoryKey', async () => {
  const extractor = new DeepSeekFlashMemoryCandidateExtractor({
    async complete() {
      return JSON.stringify({ candidates: [{
        operation: 'ADD', kind: 'weakness', scope: 'course',
        content: 'Struggles with the proof structure of the Pumping Lemma.',
        sourceType: 'user_explicit', confidence: 0.9,
      }] })
    },
  })
  const [candidate] = await extractor.extract({
    userMessage: 'Pumping Lemma 不好。', assistantResponse: '好的。', sourceSessionId: 'session-key-fallback', course: 'FIT2014',
  })
  assert.equal(candidate?.memoryKey, 'weakness:FIT2014:pumping-lemma')
})

test('resolver protects higher-priority state and updates canonical memory in place', async (context) => {
  const runtime = await setup(context)
  const first = await runtime.lifecycle.apply(runtime.resolver.resolve(preferenceCandidate('bilingual')))
  const memoryId = requiredMemoryId(first.memory?.memoryId)

  const inferred = runtime.resolver.resolve({
    ...preferenceCandidate('brief English'),
    sourceType: 'agent_inferred',
  })
  assert.deepEqual(inferred, { operation: 'NOOP', memoryId })

  const explicit = runtime.resolver.resolve(preferenceCandidate('Chinese only'))
  assert.equal(explicit.operation, 'UPDATE')
  const updated = await runtime.lifecycle.apply(explicit)
  assert.equal(updated.memory?.memoryId, memoryId)
  assert.equal(updated.memory?.content, 'Chinese only')
  assert.equal(runtime.store.listActive().length, 1)
  assert.equal(runtime.store.searchFts([memoryId], 'Chinese').size, 1)
  assert.equal(runtime.store.searchFts([memoryId], 'bilingual').size, 0)
})

test('hybrid recall direct-loads global memory and filters course/topic candidates', async (context) => {
  const runtime = await setup(context)
  const global = await write(runtime, preferenceCandidate('Prefers Chinese explanations'))
  const pumping = await write(runtime, canonicalCandidate({
    kind: 'weakness',
    memoryKey: 'weakness:FIT2014:pumping-lemma',
    scope: 'course',
    course: 'FIT2014',
    content: 'Pumping Lemma proof structure is weak',
  }))
  await write(runtime, canonicalCandidate({
    kind: 'weakness',
    memoryKey: 'weakness:FIT2109:git-merge',
    scope: 'course',
    course: 'FIT2109',
    content: 'Git merge graph is weak',
  }))
  const strategy = await write(runtime, canonicalCandidate({
    kind: 'study_strategy',
    memoryKey: 'strategy:git:visual-first',
    scope: 'topic',
    topic: 'git',
    content: 'Explain Git with a visual commit graph first',
  }))

  const fit2014 = await runtime.retriever.recall({
    query: 'Pumping Lemma revision',
    course: 'FIT2014',
  })
  assert.deepEqual(fit2014.map((item) => item.memory.memoryId), [global, pumping])
  assert.equal(fit2014[0]?.direct, true)
  assert.equal(fit2014[1]?.direct, false)
  assert.ok((fit2014[1]?.score.keyword ?? 0) > 0)

  const git = await runtime.retriever.recall({
    query: 'Explain Git rebase with a graph',
    course: 'FIT2109',
    topic: 'git',
  })
  assert.ok(git.some((item) => item.memory.memoryId === strategy))
  assert.ok(!git.some((item) => item.memory.memoryId === pumping))
  assert.equal(runtime.store.get(strategy)?.accessCount, 1)

  await runtime.lifecycle.apply(runtime.resolver.resolve({
    operation: 'RESOLVE',
    memoryKey: 'weakness:FIT2014:pumping-lemma',
    sourceType: 'user_explicit',
  }))
  const afterResolve = await runtime.retriever.recall({ query: 'Pumping Lemma', course: 'FIT2014' })
  assert.ok(!afterResolve.some((item) => item.memory.memoryId === pumping))
  assert.equal(runtime.store.getEmbedding(pumping), undefined)
  assert.equal(runtime.store.searchFts([pumping], 'Pumping').size, 0)
})

test('episode lifecycle archives the lowest-value consolidated episode over the course limit', async (context) => {
  const runtime = await setup(context, 2)
  const higher = await write(runtime, canonicalCandidate({
    kind: 'weakness',
    memoryKey: 'weakness:FIT2109:git-graph',
    scope: 'course',
    course: 'FIT2109',
    content: 'Git graph understanding needs work',
  }))
  const first = await write(runtime, episodeCandidate('First Git learning episode', 0.9))
  const second = await write(runtime, episodeCandidate('Second Git learning episode', 0.1))
  runtime.store.linkEpisodeConsolidation(first, higher)
  const third = await write(runtime, episodeCandidate('Third Git learning episode', 0.8))

  assert.equal(runtime.store.get(first)?.status, 'archived')
  assert.equal(runtime.store.getEmbedding(first), undefined)
  assert.equal(runtime.store.get(second)?.status, 'active')
  assert.equal(runtime.store.get(third)?.status, 'active')
  assert.equal(runtime.store.listActiveEpisodes('FIT2109').length, 2)
})

test('MemoryService observes candidates, recalls them, and supports explicit forget', async (context) => {
  const runtime = await setup(context)
  const extractor = new DeepSeekFlashMemoryCandidateExtractor({
    async complete() {
      return JSON.stringify({ candidates: [canonicalCandidate({
        kind: 'study_strategy',
        memoryKey: 'strategy:git:visual-first',
        scope: 'topic',
        topic: 'git',
        content: 'Use commit graphs before Git commands',
      })] })
    },
  })
  const service = new MemoryService({ ...runtime, extractor })
  const [writeResult] = await service.observe({
    userMessage: 'Git 先画图。',
    assistantResponse: '好的。',
    sourceSessionId: 'session-a',
    topic: 'git',
  })
  const memoryId = requiredMemoryId(writeResult?.memory?.memoryId)
  const recalled = await service.recall({ query: 'Git rebase', topic: 'git' })
  assert.ok(recalled.some((item) => item.memory.memoryId === memoryId))
  service.forget(memoryId)
  assert.equal(runtime.store.get(memoryId), undefined)
  assert.deepEqual(runtime.store.listEvents(memoryId).map((event) => event.operation), ['ADD', 'DELETE'])
})

test('MemoryService.manage canonicalizes an explicit unprefixed preference key', async (context) => {
  const runtime = await setup(context)
  const service = new MemoryService({
    ...runtime,
    extractor: { async extract() { return [] } },
  })

  const result = await service.manage({
    operation: 'ADD',
    kind: 'preference',
    scope: 'global',
    sourceType: 'user_explicit',
    memoryKey: 'explanation_style',
    content: 'Student prefers concise explanations when studying.',
    importance: 0.8,
    confidence: 0.95,
    sourceSessionId: 'session-explicit',
    sourceTurnId: 'turn-explicit',
  })

  const memoryId = requiredMemoryId(result.memory?.memoryId)
  assert.equal(result.operation, 'ADD')
  assert.equal(runtime.store.get(memoryId)?.memoryKey, 'preference:explanation-language')
  assert.ok(runtime.store.getEmbedding(memoryId))
  assert.deepEqual(runtime.store.listEvents(memoryId).map((event) => event.operation), ['ADD'])
  assert.ok((await runtime.retriever.recall({ query: 'concise explanations', globalLimit: 10 }))
    .some((item) => item.memory.memoryId === memoryId))
})

test('resolver executes Hard Delete only with explicit user forget intent', async (context) => {
  const runtime = await setup(context)
  const memoryId = await write(runtime, preferenceCandidate('Prefers Chinese explanations'))

  assert.deepEqual(runtime.resolver.resolve({
    operation: 'DELETE',
    targetMemoryId: memoryId,
    sourceType: 'user_explicit',
  }), { operation: 'NOOP', memoryId })
  assert.deepEqual(runtime.resolver.resolve({
    operation: 'DELETE',
    targetMemoryId: memoryId,
    sourceType: 'agent_inferred',
    deleteIntent: 'explicit_user_forget',
  }), { operation: 'NOOP', memoryId })

  const decision = runtime.resolver.resolve({
    operation: 'DELETE',
    targetMemoryId: memoryId,
    sourceType: 'user_explicit',
    deleteIntent: 'explicit_user_forget',
  })
  assert.equal(decision.operation, 'DELETE')
  await runtime.lifecycle.apply(decision)
  assert.equal(runtime.store.get(memoryId), undefined)
})

test('hybrid formation keeps canonical state unique and deduplicates exact same-turn episodes', async (context) => {
  const runtime = await setup(context)
  const canonical = preferenceCandidate('Prefers Chinese explanations')
  const { sourceSessionId: _sourceSessionId, ...episodeWithoutSession } = episodeCandidate(
    'Confused reset and revert during this turn',
    0.8,
  )
  const episode = {
    ...episodeWithoutSession,
    sourceTurnId: 'run-hybrid',
  } satisfies MemoryCandidate
  const service = new MemoryService({
    ...runtime,
    extractor: {
      async extract(observation) {
        return [{
          ...canonical,
          sourceSessionId: observation.sourceSessionId,
          ...(observation.sourceTurnId === undefined ? {} : { sourceTurnId: observation.sourceTurnId }),
        }, { ...episode, sourceSessionId: observation.sourceSessionId }]
      },
    },
  })

  await service.manage({
    ...canonical,
    sourceSessionId: 'session-hybrid',
    sourceTurnId: 'run-hybrid',
  })
  await service.manage(episode)
  const observed = await service.observe({
    userMessage: 'Remember this turn.',
    assistantResponse: 'Done.',
    sourceSessionId: 'session-hybrid',
    sourceTurnId: 'run-hybrid',
  })

  assert.equal(runtime.store.listActive().filter((memory) => memory.kind === 'preference').length, 1)
  assert.equal(runtime.store.listActiveEpisodes('FIT2109').length, 1)
  assert.deepEqual(observed.map((result) => result.operation), ['NOOP', 'NOOP'])

  await service.manage({ ...episode, sourceTurnId: 'run-later' })
  assert.equal(runtime.store.listActiveEpisodes('FIT2109').length, 2)
})

class FakeEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly model = 'deterministic-round-2'

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map((text) => vectorFor(text))
  }
}

function vectorFor(text: string): readonly number[] {
  const normalized = text.toLowerCase()
  if (normalized.includes('pumping')) return [1, 0, 0]
  if (normalized.includes('git') || normalized.includes('graph')) return [0, 1, 0]
  return [0, 0, 1]
}

async function setup(context: TestContext, episodeLimit = 50) {
  const root = await mkdtemp(join(tmpdir(), 'monash-memory-intelligence-'))
  context.after(async () => rm(root, { recursive: true, force: true }))
  let id = 1
  const store = new MemoryStore({
    databasePath: join(root, 'runtime.sqlite'),
    initializeDatabase: true,
    now: () => new Date('2026-09-22T10:00:00.000Z'),
    createId: () => `id-${id++}`,
  })
  context.after(() => store.close())
  const embeddingProvider = new FakeEmbeddingProvider()
  const resolver = new MemoryResolver(store)
  const lifecycle = new MemoryLifecycleManager(store, embeddingProvider, {
    activeEpisodeLimitPerCourse: episodeLimit,
  })
  const retriever = new MemoryRetriever(store, embeddingProvider, {
    now: () => new Date('2026-09-22T10:00:00.000Z'),
  })
  return { store, resolver, lifecycle, retriever, embeddingProvider }
}

async function write(
  runtime: Awaited<ReturnType<typeof setup>>,
  candidate: MemoryCandidate,
): Promise<string> {
  const result = await runtime.lifecycle.apply(runtime.resolver.resolve(candidate))
  return requiredMemoryId(result.memory?.memoryId)
}

function preferenceCandidate(content: string): MemoryCandidate {
  return canonicalCandidate({
    kind: 'preference',
    memoryKey: 'preference:explanation-language',
    scope: 'global',
    content,
  })
}

function canonicalCandidate(input: {
  readonly kind: 'preference' | 'study_progress' | 'weakness' | 'study_strategy'
  readonly memoryKey: string
  readonly scope: 'global' | 'course' | 'topic'
  readonly course?: string
  readonly topic?: string
  readonly content: string
}): MemoryCandidate {
  return {
    operation: 'ADD',
    kind: input.kind,
    memoryKey: input.memoryKey,
    scope: input.scope,
    ...(input.course === undefined ? {} : { course: input.course }),
    ...(input.topic === undefined ? {} : { topic: input.topic }),
    content: input.content,
    importance: 0.8,
    confidence: 0.9,
    sourceType: 'user_explicit',
    sourceSessionId: 'session-a',
  }
}

function episodeCandidate(content: string, importance: number): MemoryCandidate {
  return {
    operation: 'ADD',
    kind: 'learning_episode',
    scope: 'course',
    course: 'FIT2109',
    content,
    importance,
    confidence: 0.9,
    sourceType: 'derived',
    sourceSessionId: 'session-a',
  }
}

function requiredMemoryId(value: string | undefined): string {
  if (value === undefined) throw new Error('Expected memoryId')
  return value
}
