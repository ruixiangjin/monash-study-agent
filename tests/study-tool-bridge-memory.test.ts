import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { StudyToolBridge } from '@monash-study/dsh-integration'
import {
  MemoryLifecycleManager,
  MemoryResolver,
  MemoryRetriever,
  MemoryService,
  MemoryStore,
  type MemoryEmbeddingProvider,
} from '@monash-study/memory-service'

class TestEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly model = 'test-memory-embedding'

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map(() => [1, 0, 0])
  }
}

test('StudyToolBridge dispatches explicit preference memory through MemoryService', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monash-bridge-memory-'))
  const store = new MemoryStore({
    databasePath: join(root, 'runtime.sqlite'),
    initializeDatabase: true,
    createId: () => 'bridge-memory-1',
  })
  const embeddingProvider = new TestEmbeddingProvider()
  const memoryManager = new MemoryService({
    store,
    extractor: { async extract() { return [] } },
    resolver: new MemoryResolver(store),
    retriever: new MemoryRetriever(store, embeddingProvider),
    lifecycle: new MemoryLifecycleManager(store, embeddingProvider),
  })
  const bridge = new StudyToolBridge({ services: { memoryManager } })
  const endpoint = await bridge.start()
  bridge.begin('turn-memory-bridge', {
    query: 'Remember my explanation preference.',
    conversation: { sessionId: 'session-memory-bridge', conversationId: 'session-memory-bridge' },
  })

  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'manage_memory',
        arguments: {
          operation: 'ADD',
          kind: 'preference',
          scope: 'global',
          sourceType: 'user_explicit',
          memoryKey: 'explanation_style',
          content: 'Student prefers concise explanations when studying.',
          importance: 0.8,
          confidence: 0.95,
        },
      }),
    })
    const result = await response.json() as { ok: boolean; value?: Record<string, unknown> }
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, {
      operation: 'ADD',
      memoryId: 'bridge-memory-1',
      memoryKey: 'preference:explanation-language',
      status: 'active',
      kind: 'preference',
      scope: 'global',
    })

    const memory = store.get('bridge-memory-1')
    assert.equal(memory?.memoryKey, 'preference:explanation-language')
    assert.equal(memory?.sourceSessionId, 'session-memory-bridge')
    assert.ok(store.getEmbedding('bridge-memory-1'))
    assert.equal(store.searchFts(['bridge-memory-1'], 'concise explanations').has('bridge-memory-1'), true)
  } finally {
    bridge.end('turn-memory-bridge')
    await bridge.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
