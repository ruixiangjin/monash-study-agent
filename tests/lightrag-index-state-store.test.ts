import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import type { LightRAGIndexState } from '../services/knowledge-service/src/lightrag/lightrag-index-state.js'
import { LightRAGIndexStateStore } from '../services/knowledge-service/src/lightrag/lightrag-index-state-store.js'

test('creates and persists the LightRAG index state schema', async (context) => {
  const root = await testDirectory(context)
  const databasePath = join(root, 'runtime', 'state.sqlite')
  const store = new LightRAGIndexStateStore({ databasePath })

  assert.equal(store.get('missing'), undefined)
  assert.deepEqual(store.listByCourse('FIT2109'), [])

  const first = state('document-a', 'resource-a', 'FIT2109', 'first')
  store.upsert(first)
  assert.deepEqual(store.get(first.documentId), first)

  const updated = { ...first, normalizedHash: 'second', indexedAt: '2026-09-21T10:00:00.000Z' }
  store.upsert(updated)
  assert.deepEqual(store.get(first.documentId), updated)

  const unclassified = state('document-b', 'resource-b', null, 'unclassified')
  store.upsert(unclassified)
  assert.deepEqual(store.listByCourse('FIT2109'), [updated])
  assert.deepEqual(store.listByCourse(null), [unclassified])

  store.delete(first.documentId)
  assert.equal(store.get(first.documentId), undefined)
  store.close()

  const reopened = new LightRAGIndexStateStore({ databasePath })
  assert.deepEqual(reopened.get(unclassified.documentId), unclassified)
  reopened.close()
})

async function testDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'monash-lightrag-state-'))
  context.after(async () => rm(directory, { recursive: true, force: true }))
  return directory
}

function state(
  documentId: string,
  resourceId: string,
  course: string | null,
  suffix: string,
): LightRAGIndexState {
  return {
    documentId,
    resourceId,
    course,
    sourceHash: `${suffix}-source`,
    normalizedHash: `${suffix}-normalized`,
    normalizationVersion: '1:text:1',
    sourcePath: `/tmp/${suffix}.md`,
    indexedAt: '2026-09-21T09:00:00.000Z',
  }
}
