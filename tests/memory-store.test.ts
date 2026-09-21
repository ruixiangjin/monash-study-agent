import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  MemoryStore,
  type AddCanonicalMemoryInput,
  type AddLearningEpisodeInput,
} from '@monash-study/memory-service'

const EMBEDDING = { model: 'deterministic-test', vector: [0.25, 0.5, 0.75] }

test('creates the Memory schema without coupling deletion events to memory rows', async (context) => {
  const { databasePath, store } = await setup(context)
  store.close()

  const database = new DatabaseSync(databasePath, { readOnly: true })
  assert.deepEqual(database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('memories', 'memory_embeddings', 'memory_events')
    ORDER BY name
  `).all().map((row) => row.name), ['memories', 'memory_embeddings', 'memory_events'])
  const migration = database.prepare(`
    SELECT version, name FROM schema_migrations WHERE version = 3
  `).get()
  assert.deepEqual(
    migration === undefined ? undefined : { version: migration.version, name: migration.name },
    { version: 3, name: 'create-memory-foundation' },
  )
  assert.deepEqual(database.prepare('PRAGMA foreign_key_list(memory_events)').all(), [])
  database.close()
})

test('keeps one canonical record and preserves memoryId on update', async (context) => {
  const { databasePath, store } = await setup(context)
  const added = store.add(preference())
  assert.equal(added.memory?.memoryId, 'memory-1')
  assert.equal(added.memory?.memoryKey, 'preference:explanation-language')

  assert.throws(
    () => store.add({ ...preference(), memoryId: 'another', memoryKey: 'Preference:Explanation Language' }),
    /UNIQUE constraint failed/,
  )

  const updated = store.update('memory-1', {
    content: 'Prefers Chinese-only explanations.',
    importance: 0.95,
    confidence: 1,
    sourceType: 'user_explicit',
    sourceSessionId: 'session-b',
    lastConfirmedAt: '2026-09-22T10:00:00.000Z',
    embedding: { model: 'deterministic-test', vector: [1, 0, 0] },
  })

  assert.equal(updated.memory?.memoryId, 'memory-1')
  assert.equal(store.getByKey('preference:explanation-language')?.content, 'Prefers Chinese-only explanations.')
  assert.deepEqual(store.getEmbedding('memory-1'), {
    memoryId: 'memory-1',
    model: 'deterministic-test',
    vector: [1, 0, 0],
    contentHash: hash('Prefers Chinese-only explanations.'),
    createdAt: '2026-09-22T09:00:00.000Z',
  })
  assert.deepEqual(store.listEvents('memory-1').map((event) => event.operation), ['ADD', 'UPDATE'])

  store.close()
  const reopened = new MemoryStore({ databasePath })
  context.after(() => reopened.close())
  assert.equal(reopened.getByKey('preference:explanation-language')?.memoryId, 'memory-1')
  assert.equal(reopened.getByKey('preference:explanation-language')?.content, 'Prefers Chinese-only explanations.')
})

test('allows independent learning episodes and archives only the selected episode', async (context) => {
  const { store } = await setup(context)
  const first = store.add(episode('episode-1', 'First episode'))
  const second = store.add(episode('episode-2', 'Second episode'))

  assert.equal(first.memory?.memoryKey, null)
  assert.equal(second.memory?.memoryKey, null)
  assert.equal(store.listActive().length, 2)

  const archived = store.archive('episode-1')
  assert.equal(archived.memory?.status, 'archived')
  assert.equal(store.getEmbedding('episode-1'), undefined)
  assert.notEqual(store.getEmbedding('episode-2'), undefined)
  assert.deepEqual(store.listEvents('episode-1').map((event) => event.operation), ['ADD', 'ARCHIVE'])
  assert.equal(store.archive('episode-1').operation, 'NOOP')
})

test('resolves current-state memory but preserves its row and history', async (context) => {
  const { store } = await setup(context)
  store.add({
    ...canonicalBase(),
    memoryId: 'weakness-1',
    memoryKey: 'weakness:FIT2014:pumping-lemma',
    kind: 'weakness',
    scope: 'course',
    course: 'FIT2014',
    content: 'Pumping Lemma proof structure is weak.',
  })

  const result = store.resolve('weakness-1')
  assert.equal(result.memory?.status, 'resolved')
  assert.equal(store.get('weakness-1')?.status, 'resolved')
  assert.equal(store.getEmbedding('weakness-1'), undefined)
  assert.deepEqual(store.listEvents('weakness-1').map((event) => event.operation), ['ADD', 'RESOLVE'])
  assert.equal(store.resolve('weakness-1').operation, 'NOOP')
})

test('hard delete removes content and embedding but retains a minimal event', async (context) => {
  const { databasePath, store } = await setup(context)
  store.add(preference())
  assert.deepEqual(store.delete('memory-1'), { operation: 'DELETE', memory: null })
  assert.equal(store.get('memory-1'), undefined)
  assert.equal(store.getEmbedding('memory-1'), undefined)
  assert.deepEqual(store.listEvents('memory-1').map((event) => event.operation), ['ADD', 'DELETE'])
  store.close()

  const database = new DatabaseSync(databasePath, { readOnly: true })
  const deleteEvent = database.prepare(`
    SELECT memory_id, operation FROM memory_events
    WHERE memory_id = ? AND operation = 'DELETE'
  `).get('memory-1')
  assert.deepEqual(
    deleteEvent === undefined
      ? undefined
      : { memory_id: deleteEvent.memory_id, operation: deleteEvent.operation },
    { memory_id: 'memory-1', operation: 'DELETE' },
  )
  assert.deepEqual(
    database.prepare('PRAGMA table_info(memory_events)').all().map((row) => row.name),
    ['event_id', 'memory_id', 'operation', 'timestamp'],
  )
  database.close()
})

test('validates global, course, and topic scope invariants before writing', async (context) => {
  const { store } = await setup(context)
  assert.throws(() => store.add({ ...preference(), course: 'FIT2014' }), /Global memories/)
  assert.throws(() => store.add({
    ...canonicalBase(),
    memoryKey: 'progress:FIT2014:pumping-lemma',
    kind: 'study_progress',
    scope: 'course',
  }), /Course memories require course/)
  assert.throws(() => store.add({
    ...canonicalBase(),
    memoryKey: 'strategy:git:visual-first',
    kind: 'study_strategy',
    scope: 'topic',
  }), /Topic memories require topic/)
  assert.deepEqual(store.listActive(), [])
})

test('rolls back memory and embedding mutations when event insertion fails', async (context) => {
  await testAddRollback(context)
  await testUpdateRollback(context)
  await testResolveRollback(context)
  await testArchiveRollback(context)
  await testDeleteRollback(context)
})

async function testAddRollback(context: TestContext): Promise<void> {
  const { databasePath, store } = await setup(context, 'add')
  installFailingEventTrigger(databasePath, 'ADD')
  assert.throws(() => store.add(preference()), /forced event failure/)
  assert.equal(store.get('memory-1'), undefined)
  assert.equal(store.getEmbedding('memory-1'), undefined)
}

async function testUpdateRollback(context: TestContext): Promise<void> {
  const { databasePath, store } = await setup(context, 'update')
  store.add(preference())
  const before = store.getEmbedding('memory-1')
  installFailingEventTrigger(databasePath, 'UPDATE')
  assert.throws(() => store.update('memory-1', {
    content: 'Changed content',
    importance: 1,
    confidence: 1,
    sourceType: 'user_explicit',
    embedding: { model: 'deterministic-test', vector: [1, 0, 0] },
  }), /forced event failure/)
  assert.equal(store.get('memory-1')?.content, 'Prefers bilingual explanations.')
  assert.deepEqual(store.getEmbedding('memory-1'), before)
}

async function testResolveRollback(context: TestContext): Promise<void> {
  const { databasePath, store } = await setup(context, 'resolve')
  store.add({
    ...canonicalBase(),
    memoryId: 'weakness-1',
    memoryKey: 'weakness:FIT2014:pumping-lemma',
    kind: 'weakness',
    scope: 'course',
    course: 'FIT2014',
  })
  installFailingEventTrigger(databasePath, 'RESOLVE')
  assert.throws(() => store.resolve('weakness-1'), /forced event failure/)
  assert.equal(store.get('weakness-1')?.status, 'active')
  assert.notEqual(store.getEmbedding('weakness-1'), undefined)
}

async function testArchiveRollback(context: TestContext): Promise<void> {
  const { databasePath, store } = await setup(context, 'archive')
  store.add(episode('episode-1', 'Episode'))
  installFailingEventTrigger(databasePath, 'ARCHIVE')
  assert.throws(() => store.archive('episode-1'), /forced event failure/)
  assert.equal(store.get('episode-1')?.status, 'active')
  assert.notEqual(store.getEmbedding('episode-1'), undefined)
}

async function testDeleteRollback(context: TestContext): Promise<void> {
  const { databasePath, store } = await setup(context, 'delete')
  store.add(preference())
  installFailingEventTrigger(databasePath, 'DELETE')
  assert.throws(() => store.delete('memory-1'), /forced event failure/)
  assert.notEqual(store.get('memory-1'), undefined)
  assert.notEqual(store.getEmbedding('memory-1'), undefined)
}

function installFailingEventTrigger(databasePath: string, operation: string): void {
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TRIGGER fail_${operation.toLowerCase()}_event
    BEFORE INSERT ON memory_events
    WHEN NEW.operation = '${operation}'
    BEGIN
      SELECT RAISE(ABORT, 'forced event failure');
    END;
  `)
  database.close()
}

async function setup(
  context: TestContext,
  suffix = 'default',
): Promise<{ databasePath: string; store: MemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), `monash-memory-${suffix}-`))
  context.after(async () => rm(root, { recursive: true, force: true }))
  const databasePath = join(root, 'runtime.sqlite')
  let nextId = 1
  const store = new MemoryStore({
    databasePath,
    now: () => new Date('2026-09-22T09:00:00.000Z'),
    createId: () => `memory-${nextId++}`,
  })
  context.after(() => store.close())
  return { databasePath, store }
}

function canonicalBase(): Omit<AddCanonicalMemoryInput, 'memoryKey' | 'kind'> {
  return {
    scope: 'global',
    content: 'Current memory content.',
    importance: 0.8,
    confidence: 0.9,
    sourceType: 'user_explicit',
    sourceSessionId: 'session-a',
    embedding: EMBEDDING,
  }
}

function preference(): AddCanonicalMemoryInput {
  return {
    ...canonicalBase(),
    memoryId: 'memory-1',
    memoryKey: 'preference:explanation-language',
    kind: 'preference',
    content: 'Prefers bilingual explanations.',
  }
}

function episode(memoryId: string, content: string): AddLearningEpisodeInput {
  return {
    ...canonicalBase(),
    memoryId,
    kind: 'learning_episode',
    scope: 'course',
    course: 'FIT2109',
    content,
  }
}

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}
