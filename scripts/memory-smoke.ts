import { mkdtemp, rm } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  type MemoryContext,
} from '@monash-study/memory-service'

const repositorySmokeDirectoryPrefix = 'monash-study-agent-memory-smoke-'

interface Runtime {
  readonly service: MemoryService
  readonly store: MemoryStore
}

const openedStores: MemoryStore[] = []

async function main(): Promise<void> {
  const smokeDirectory = await mkdtemp(join(tmpdir(), repositorySmokeDirectoryPrefix))
  const databasePath = join(smokeDirectory, 'memory-smoke.sqlite')
  let runtime: Runtime | undefined

  try {
    print('Memory Round 3 Real Smoke')
    print(`database = ${databasePath}`)

    const embeddingProvider = new BgeM3MemoryEmbeddingProvider()
    print('')
    print('[1] BGE-M3 health')
    const embeddingTimings: number[] = []
    let firstDimension = 0
    for (const call of [1, 2, 3]) {
      const started = performance.now()
      const vectors = await embeddingProvider.embed([
        'Pumping Lemma weakness',
        'Git visual explanation strategy',
      ])
      embeddingTimings.push(performance.now() - started)
      assert(vectors.length === 2, 'BGE-M3 did not return two vectors')
      const dimension = vectors[0]?.length ?? 0
      if (call === 1) firstDimension = dimension
      assert(dimension > 0 && vectors.every((vector) => vector.length === dimension), 'BGE-M3 dimensions mismatch')
      assert(vectors.flat().every(Number.isFinite), 'BGE-M3 returned non-finite values')
    }
    print(`PASS model=${embeddingProvider.model} dimension=${firstDimension}`)
    print(`timing call1=${milliseconds(embeddingTimings[0])} call2=${milliseconds(embeddingTimings[1])} call3=${milliseconds(embeddingTimings[2])}`)

    runtime = createRuntime(databasePath, embeddingProvider, 3)
    print('')
    print('[2] DeepSeek Flash extractor health')
    const extractionStarted = performance.now()
    const extraction = await runtime.service.observe({
      userMessage: '我喜欢中英双语解释。',
      assistantResponse: '好的，我会记住这个学习偏好。',
      sourceSessionId: 'round-3-session-a',
    })
    const extractionLatency = performance.now() - extractionStarted
    const preference = findActive(runtime.store, 'preference', undefined, undefined)
    assert(extraction.length > 0 && preference !== undefined, 'DeepSeek did not produce a global preference')
    assert(preference.scope === 'global' && preference.memoryKey !== null, 'Preference scope/key is invalid')
    assert(preference.sourceType === 'user_explicit' && preference.content.length > 0, 'Preference candidate fields are invalid')
    print(`PASS model=deepseek-flash latency=${milliseconds(extractionLatency)} memoryKey=${preference.memoryKey}`)

    print('')
    print('[3] Case 1 Global Preference ADD / UPDATE')
    const originalMemoryId = preference.memoryId
    const originalKey = preference.memoryKey
    const originalEmbedding = runtime.store.getEmbedding(originalMemoryId)
    assert(originalEmbedding !== undefined, 'Preference embedding was not stored')
    assert(runtime.store.searchFts([originalMemoryId], preference.content).size > 0, 'Preference FTS entry was not stored')

    const updateStarted = performance.now()
    await runtime.service.observe({
      userMessage: '以后学习解释只用中文。',
      assistantResponse: '好的，以后默认使用中文解释。',
      sourceSessionId: 'round-3-session-b',
    })
    const updateLatency = performance.now() - updateStarted
    const updatedPreference = findActive(runtime.store, 'preference', undefined, undefined)
    assert(updatedPreference !== undefined, 'Updated preference disappeared')
    assert(updatedPreference.memoryId === originalMemoryId, 'Preference UPDATE changed memoryId')
    assert(updatedPreference.memoryKey === originalKey, 'Preference UPDATE changed memoryKey')
    assert(updatedPreference.content.includes('中文') || updatedPreference.content.toLowerCase().includes('chinese'), 'Preference did not become Chinese-only')
    assert(runtime.store.listActive().filter((memory) => memory.kind === 'preference').length === 1, 'Duplicate active preference exists')
    const updatedEmbedding = runtime.store.getEmbedding(originalMemoryId)
    assert(updatedEmbedding !== undefined && updatedEmbedding.contentHash !== originalEmbedding.contentHash, 'Preference embedding was not replaced')
    assert(runtime.store.searchFts([originalMemoryId], updatedPreference.content).size > 0, 'Updated preference FTS entry is missing')
    print(`PASS ADD/UPDATE sameMemoryId=${originalMemoryId} latency=${milliseconds(updateLatency)}`)

    runtime.store.close()
    runtime = createRuntime(databasePath, embeddingProvider, 3)
    const crossInstancePreference = findActive(runtime.store, 'preference', undefined, undefined)
    assert(crossInstancePreference?.memoryId === originalMemoryId, 'Cross-instance preference persistence failed')
    assert(crossInstancePreference.content === updatedPreference.content, 'Cross-instance state is stale')
    const globalRecall = await timedRecall(runtime.service, { query: 'future learning explanation' })
    assert(globalRecall.result.some((context) => context.memory.memoryId === originalMemoryId), 'Cross-instance global recall failed')
    print(`PASS cross-instance recall latency=${milliseconds(globalRecall.elapsed)}`)

    print('')
    print('[4] Case 2 Weakness Recall / RESOLVE')
    const weaknessObservation = await runtime.service.observe({
      userMessage: '我对 FIT2014 的 Pumping Lemma 反证结构掌握得不好。',
      assistantResponse: '我会把这个薄弱点加入 FIT2014 复习重点。',
      sourceSessionId: 'round-3-session-c',
      course: 'FIT2014',
    })
    const weakness = findActive(runtime.store, 'weakness', 'FIT2014', undefined)
    assert(weaknessObservation.length > 0 && weakness !== undefined, 'Weakness was not persisted')
    const weaknessRecall = await timedRecall(runtime.service, {
      query: '帮我安排 FIT2014 复习，重点看 Pumping Lemma。',
      course: 'FIT2014',
    })
    assert(weaknessRecall.result.some((context) => context.memory.memoryId === weakness.memoryId), 'Weakness recall failed')
    const weaknessContext = weaknessRecall.result.find((context) => context.memory.memoryId === weakness.memoryId)
    assert(weaknessContext !== undefined && weaknessContext.score.semantic > 0 && weaknessContext.score.total > 0, 'Hybrid score components are inactive')
    printScore('PASS weakness recall', weaknessContext)
    await runtime.service.manage({ operation: 'RESOLVE', targetMemoryId: weakness.memoryId, sourceType: 'user_explicit' })
    assert(runtime.store.get(weakness.memoryId)?.status === 'resolved', 'Weakness did not resolve')
    assert(runtime.store.getEmbedding(weakness.memoryId) === undefined, 'Resolved weakness still has embedding')
    assert(runtime.store.searchFts([weakness.memoryId], 'Pumping').size === 0, 'Resolved weakness still has active FTS')
    const resolvedRecall = await runtime.service.recall({ query: 'Pumping Lemma', course: 'FIT2014' })
    assert(!resolvedRecall.some((context) => context.memory.memoryId === weakness.memoryId), 'Resolved weakness returned from recall')
    print('PASS resolve row/event/embedding/FTS lifecycle')

    print('')
    print('[5] Case 3 Topic Study Strategy')
    await runtime.service.observe({
      userMessage: '请把 Git 的学习策略记为：先给我画 commit graph，再讲命令。',
      assistantResponse: '好的，学习 Git 时我会先使用 commit graph。',
      sourceSessionId: 'round-3-session-d',
      topic: 'git',
    })
    const strategy = findActive(runtime.store, 'study_strategy', undefined, 'git')
    assert(strategy !== undefined, 'Git strategy was not persisted')
    const relevantStrategy = await runtime.service.recall({ query: 'Explain Git rebase.', topic: 'git' })
    assert(relevantStrategy.some((context) => context.memory.memoryId === strategy.memoryId), 'Relevant Git strategy was not recalled')
    const unrelatedStrategy = await runtime.service.recall({ query: 'Explain DFA minimization.', topic: 'dfa' })
    assert(!unrelatedStrategy.some((context) => context.memory.memoryId === strategy.memoryId), 'Git strategy crossed topic scope')
    print('PASS relevant topic recall and unrelated-topic filtering')

    print('')
    print('[6] Case 4 Learning Episode lifecycle')
    const episodes: string[] = []
    for (const [index, importance] of [0.1, 0.8, 0.85, 0.9].entries()) {
      const result = await runtime.service.manage({
        operation: 'ADD',
        kind: 'learning_episode',
        scope: 'course',
        course: 'FIT2014',
        content: `Round 3 real learning episode ${index + 1} about Pumping Lemma.`,
        importance,
        confidence: 0.9,
        sourceType: 'derived',
        sourceSessionId: 'round-3-episode-session',
      })
      assert(result.memory !== null, 'Episode ADD returned no memory')
      episodes.push(result.memory.memoryId)
    }
    const activeEpisodes = runtime.store.listActiveEpisodes('FIT2014')
    assert(activeEpisodes.length === 3, `Expected 3 active episodes, got ${activeEpisodes.length}`)
    const firstEpisodeId = episodes[0]
    assert(firstEpisodeId !== undefined, 'Episode fixture did not produce an id')
    const archivedEpisode = runtime.store.get(firstEpisodeId)
    assert(archivedEpisode?.status === 'archived', 'Lowest-value episode was not archived')
    assert(runtime.store.getEmbedding(firstEpisodeId) === undefined, 'Archived episode still has embedding')
    assert(runtime.store.searchFts([firstEpisodeId], 'episode').size === 0, 'Archived episode still has active FTS')
    const episodeRecall = await runtime.service.recall({ query: 'Pumping Lemma episode', course: 'FIT2014' })
    assert(!episodeRecall.some((context) => context.memory.memoryId === firstEpisodeId), 'Archived episode returned from recall')
    print('PASS active=3 archive=1 archived embedding/FTS removed')

    print('')
    print('[7] Case 5 Explicit Forget')
    const forgetResult = await runtime.service.manage({
      operation: 'ADD',
      kind: 'preference',
      memoryKey: 'preference:smoke-forget-test',
      scope: 'global',
      content: 'Temporary preference used for explicit forget smoke.',
      importance: 0.4,
      confidence: 1,
      sourceType: 'user_explicit',
      sourceSessionId: 'round-3-forget-session',
    })
    assert(forgetResult.memory !== null, 'Forget fixture was not created')
    const forgetId = forgetResult.memory.memoryId
    assert(runtime.store.getEmbedding(forgetId) !== undefined, 'Forget fixture embedding missing')
    assert(runtime.store.searchFts([forgetId], 'Temporary').size > 0, 'Forget fixture FTS missing')
    runtime.service.forget(forgetId)
    assert(runtime.store.get(forgetId) === undefined, 'Hard delete left memory row')
    assert(runtime.store.getEmbedding(forgetId) === undefined, 'Hard delete left embedding')
    assert(runtime.store.searchFts([forgetId], 'Temporary').size === 0, 'Hard delete left FTS')
    const deleteEvents = runtime.store.listEvents(forgetId)
    assert(deleteEvents.some((event) => event.operation === 'DELETE'), 'Hard delete event missing')
    print('PASS hard delete and minimal DELETE event')

    print('')
    print('[8] Case 6 Source priority and hybrid ranking')
    const priorityKey = 'preference:smoke-priority-test'
    await runtime.service.manage({
      operation: 'ADD', kind: 'preference', memoryKey: priorityKey, scope: 'global',
      content: 'Inferred preference state.', importance: 0.5, confidence: 0.4,
      sourceType: 'agent_inferred', sourceSessionId: 'round-3-priority-inferred',
    })
    const explicitPriority = await runtime.service.manage({
      operation: 'UPDATE', kind: 'preference', memoryKey: priorityKey, scope: 'global',
      content: 'Explicit preference state.', importance: 0.8, confidence: 1,
      sourceType: 'user_explicit', sourceSessionId: 'round-3-priority-explicit',
    })
    assert(explicitPriority.operation === 'UPDATE', 'Explicit source did not update inferred state')
    const blockedPriority = await runtime.service.manage({
      operation: 'UPDATE', kind: 'preference', memoryKey: priorityKey, scope: 'global',
      content: 'Conflicting inferred preference state.', importance: 0.9, confidence: 0.9,
      sourceType: 'agent_inferred', sourceSessionId: 'round-3-priority-conflict',
    })
    assert(blockedPriority.operation === 'NOOP', 'Inferred source overwrote explicit state')

    await runtime.service.manage({
      operation: 'ADD', kind: 'weakness', memoryKey: 'weakness:FIT2109:rebase', scope: 'course', course: 'FIT2109',
      content: 'Git rebase commit graph reasoning is difficult.', importance: 0.8, confidence: 0.9,
      sourceType: 'user_explicit', sourceSessionId: 'round-3-ranking-related',
    })
    await runtime.service.manage({
      operation: 'ADD', kind: 'study_progress', memoryKey: 'progress:FIT2109:unrelated', scope: 'course', course: 'FIT2109',
      content: 'Cooking recipes are unrelated to study.', importance: 0.1, confidence: 0.2,
      sourceType: 'derived', sourceSessionId: 'round-3-ranking-noise',
    })
    const ranking = await timedRecall(runtime.service, { query: 'Explain Git rebase commit graph.', course: 'FIT2109' })
    const related = ranking.result.find((context) => context.memory.memoryKey === 'weakness:FIT2109:rebase')
    const noise = ranking.result.find((context) => context.memory.memoryKey === 'progress:FIT2109:unrelated')
    assert(related !== undefined && noise !== undefined && related.score.total > noise.score.total, 'Hybrid ranking did not separate related memory')
    printScore('PASS hybrid ranking related', related)
    printScore('ranking noise', noise)

    runtime.store.close()
    runtime = undefined
    print('')
    print('Overall: PASS')
    print(`observe latency measured: extraction=${milliseconds(extractionLatency)} update=${milliseconds(updateLatency)}`)
    print(`recall latency measured: global=${milliseconds(globalRecall.elapsed)} weakness=${milliseconds(weaknessRecall.elapsed)} ranking=${milliseconds(ranking.elapsed)}`)
    print('worker decision: C — repeated one-shot BGE loads are recorded; persistent worker deferred because smoke completed without changing the interface')
  } finally {
    for (const store of openedStores) store.close()
    await rm(smokeDirectory, { recursive: true, force: true })
  }
}

function createRuntime(
  databasePath: string,
  embeddingProvider: BgeM3MemoryEmbeddingProvider,
  episodeLimitPerCourse: number,
): Runtime {
  const store = new MemoryStore({ databasePath })
  openedStores.push(store)
  const extractor = new DeepSeekFlashMemoryCandidateExtractor(new DeepSeekFlashMemoryProvider())
  const resolver = new MemoryResolver(store)
  const lifecycle = new MemoryLifecycleManager(store, embeddingProvider, {
    activeEpisodeLimitPerCourse: episodeLimitPerCourse,
  })
  const retriever = new MemoryRetriever(store, embeddingProvider)
  return { service: new MemoryService({ store, extractor, resolver, retriever, lifecycle }), store }
}

function findActive(
  store: MemoryStore,
  kind: string,
  course: string | undefined,
  topic: string | undefined,
) {
  return store.listActive().find((memory) => memory.kind === kind
    && (course === undefined || memory.course === course)
    && (topic === undefined || memory.topic === topic))
}

async function timedRecall(
  service: MemoryService,
  query: Parameters<MemoryService['recall']>[0],
): Promise<{ readonly result: readonly MemoryContext[]; readonly elapsed: number }> {
  const started = performance.now()
  const result = await service.recall(query)
  return { result, elapsed: performance.now() - started }
}

function printScore(label: string, context: MemoryContext): void {
  const score = context.score
  print(`${label} memoryId=${context.memory.memoryId} key=${context.memory.memoryKey ?? 'episode'} total=${score.total.toFixed(3)} semantic=${score.semantic.toFixed(3)} keyword=${score.keyword.toFixed(3)} importance=${score.importance.toFixed(3)} confidence=${score.confidence.toFixed(3)} recency=${score.recency.toFixed(3)}`)
}

function milliseconds(value: number | undefined): string {
  return `${(value ?? 0).toFixed(0)}ms`
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function print(message: string): void {
  process.stdout.write(`${message}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`Memory Round 3 Real Smoke: FAIL — ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
