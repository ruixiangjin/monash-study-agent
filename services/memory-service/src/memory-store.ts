import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { initializeRuntimeDatabase, openRuntimeDatabase } from '@monash-study/runtime-database'
import type {
  CanonicalMemoryKind,
  MemoryEmbedding,
  MemoryEmbeddingInput,
  MemoryEvent,
  MemoryKind,
  MemoryScope,
  MemorySourceType,
  MemoryWriteResult,
  PersistedMemoryOperation,
  StudentMemory,
} from '@monash-study/shared-types'

import { canonicalizeMemoryKey, kindForMemoryKey } from './memory-key.js'

export interface MemoryStoreOptions {
  readonly databasePath?: string
  /** Only initialization/test fixtures may opt into creating the database. */
  readonly initializeDatabase?: boolean
  readonly now?: () => Date
  readonly createId?: () => string
}

interface MemoryBaseInput {
  readonly scope: MemoryScope
  readonly course?: string | null
  readonly topic?: string | null
  readonly content: string
  readonly importance: number
  readonly confidence: number
  readonly sourceType: MemorySourceType
  readonly sourceSessionId?: string | null
  readonly lastConfirmedAt?: string | null
  readonly embedding: MemoryEmbeddingInput
}

export interface AddCanonicalMemoryInput extends MemoryBaseInput {
  readonly memoryId?: string
  readonly memoryKey: string
  readonly kind: CanonicalMemoryKind
}

export interface AddLearningEpisodeInput extends MemoryBaseInput {
  readonly memoryId?: string
  readonly kind: 'learning_episode'
}

export type AddMemoryInput = AddCanonicalMemoryInput | AddLearningEpisodeInput

export interface UpdateMemoryInput {
  readonly content: string
  readonly importance: number
  readonly confidence: number
  readonly sourceType: MemorySourceType
  readonly sourceSessionId?: string | null
  readonly lastConfirmedAt?: string | null
  readonly embedding: MemoryEmbeddingInput
}

export interface MemoryScopeFilter {
  readonly course?: string
  readonly topic?: string
}

/** Deterministic persistence and lifecycle operations for long-term student memory. */
export class MemoryStore {
  readonly #database: DatabaseSync
  readonly #now: () => Date
  readonly #createId: () => string

  constructor(options: MemoryStoreOptions = {}) {
    if (options.databasePath === undefined) {
      throw new Error('MemoryStore requires an explicit databasePath')
    }
    this.#database = options.initializeDatabase === true
      ? initializeRuntimeDatabase(options.databasePath)
      : openRuntimeDatabase(options.databasePath)
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
  }

  add(input: AddMemoryInput): MemoryWriteResult {
    validateMemoryInput(input)
    const memoryId = input.memoryId ?? this.#createId()
    const timestamp = this.#timestamp()
    const memoryKey = input.kind === 'learning_episode'
      ? null
      : canonicalizeAndValidateKey(input.kind, input.memoryKey)

    this.#transaction(() => {
      this.#database.prepare(`
        INSERT INTO memories (
          memory_id, memory_key, kind, scope, course, topic, content, status,
          importance, confidence, source_type, source_session_id, created_at,
          updated_at, last_confirmed_at, last_accessed_at, access_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, NULL, 0)
      `).run(
        memoryId,
        memoryKey,
        input.kind,
        input.scope,
        normalizedNullable(input.course),
        normalizedNullable(input.topic),
        input.content.trim(),
        input.importance,
        input.confidence,
        input.sourceType,
        normalizedNullable(input.sourceSessionId),
        timestamp,
        timestamp,
        input.lastConfirmedAt ?? null,
      )
      this.#writeEmbedding(memoryId, input.content.trim(), input.embedding, timestamp)
      this.#upsertFts(memoryId, input.content.trim())
      this.#writeEvent(memoryId, 'ADD', timestamp)
    })
    return { operation: 'ADD', memory: requireMemory(this.get(memoryId), memoryId) }
  }

  update(memoryId: string, input: UpdateMemoryInput): MemoryWriteResult {
    const existing = requireMemory(this.get(memoryId), memoryId)
    if (existing.kind === 'learning_episode') {
      throw new Error('Learning episodes are append-oriented and cannot be updated')
    }
    validateUpdateInput(input)
    const timestamp = this.#timestamp()
    this.#transaction(() => {
      this.#database.prepare(`
        UPDATE memories
        SET content = ?, status = 'active', importance = ?, confidence = ?, source_type = ?,
            source_session_id = ?, updated_at = ?, last_confirmed_at = ?
        WHERE memory_id = ?
      `).run(
        input.content.trim(),
        input.importance,
        input.confidence,
        input.sourceType,
        normalizedNullable(input.sourceSessionId),
        timestamp,
        input.lastConfirmedAt ?? null,
        memoryId,
      )
      this.#writeEmbedding(memoryId, input.content.trim(), input.embedding, timestamp)
      this.#upsertFts(memoryId, input.content.trim())
      this.#writeEvent(memoryId, 'UPDATE', timestamp)
    })
    return { operation: 'UPDATE', memory: requireMemory(this.get(memoryId), memoryId) }
  }

  resolve(memoryId: string): MemoryWriteResult {
    const memory = requireMemory(this.get(memoryId), memoryId)
    if (memory.kind !== 'weakness' && memory.kind !== 'study_progress') {
      throw new Error('Only weakness and study progress memories can be resolved')
    }
    if (memory.status === 'resolved') return { operation: 'NOOP', memory }
    return this.#deactivate(memoryId, 'resolved', 'RESOLVE')
  }

  archive(memoryId: string): MemoryWriteResult {
    const memory = requireMemory(this.get(memoryId), memoryId)
    if (memory.kind !== 'learning_episode') {
      throw new Error('Only learning episodes can be archived')
    }
    if (memory.status === 'archived') return { operation: 'NOOP', memory }
    return this.#deactivate(memoryId, 'archived', 'ARCHIVE')
  }

  delete(memoryId: string): MemoryWriteResult {
    requireMemory(this.get(memoryId), memoryId)
    const timestamp = this.#timestamp()
    this.#transaction(() => {
      this.#database.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(memoryId)
      this.#deleteFts(memoryId)
      this.#database.prepare('DELETE FROM memories WHERE memory_id = ?').run(memoryId)
      this.#writeEvent(memoryId, 'DELETE', timestamp)
    })
    return { operation: 'DELETE', memory: null }
  }

  noop(memoryId?: string): MemoryWriteResult {
    return { operation: 'NOOP', memory: memoryId === undefined ? null : requireMemory(this.get(memoryId), memoryId) }
  }

  get(memoryId: string): StudentMemory | undefined {
    const row = this.#database.prepare(`${memorySelect()} WHERE memory_id = ?`).get(memoryId)
    return row === undefined ? undefined : memoryFromRow(row)
  }

  getByKey(memoryKey: string): StudentMemory | undefined {
    const row = this.#database
      .prepare(`${memorySelect()} WHERE memory_key = ?`)
      .get(canonicalizeMemoryKey(memoryKey))
    return row === undefined ? undefined : memoryFromRow(row)
  }

  listActive(): readonly StudentMemory[] {
    return this.#database
      .prepare(`${memorySelect()} WHERE status = 'active' ORDER BY created_at, memory_id`)
      .all()
      .map(memoryFromRow)
  }

  listActiveGlobal(limit = 20): readonly StudentMemory[] {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Global memory limit must be positive')
    return this.#database.prepare(`
      ${memorySelect()}
      WHERE status = 'active'
        AND scope = 'global'
        AND kind IN ('preference', 'study_strategy')
      ORDER BY CASE kind WHEN 'preference' THEN 0 ELSE 1 END,
               importance DESC, updated_at DESC, memory_id
      LIMIT ?
    `).all(limit).map(memoryFromRow)
  }

  listActiveForScope(filter: MemoryScopeFilter): readonly StudentMemory[] {
    const course = normalizedNullable(filter.course)
    const topic = normalizedNullable(filter.topic)
    if (course === null && topic === null) return []
    const clauses: string[] = []
    const parameters: string[] = []
    if (course !== null) {
      clauses.push("(scope = 'course' AND course = ?)")
      parameters.push(course)
    }
    if (topic !== null) {
      clauses.push("(scope = 'topic' AND topic = ? AND (course IS NULL OR course = ?))")
      parameters.push(topic, course ?? '')
    }
    return this.#database.prepare(`
      ${memorySelect()}
      WHERE status = 'active' AND (${clauses.join(' OR ')})
      ORDER BY updated_at DESC, memory_id
    `).all(...parameters).map(memoryFromRow)
  }

  searchFts(memoryIds: readonly string[], query: string): ReadonlyMap<string, number> {
    if (memoryIds.length === 0) return new Map()
    const ftsQuery = toFtsQuery(query)
    if (ftsQuery === '') return new Map()
    const placeholders = memoryIds.map(() => '?').join(', ')
    const rows = this.#database.prepare(`
      SELECT memory_id, bm25(memory_fts) AS rank
      FROM memory_fts
      WHERE memory_fts MATCH ? AND memory_id IN (${placeholders})
      ORDER BY rank, rowid
    `).all(ftsQuery, ...memoryIds)
    return new Map(rows.map((row, index) => [
      requiredString(row.memory_id, 'memory_id'),
      1 / (index + 1),
    ]))
  }

  recordAccess(memoryIds: readonly string[], accessedAt: string = this.#timestamp()): void {
    if (memoryIds.length === 0) return
    this.#transaction(() => {
      const update = this.#database.prepare(`
        UPDATE memories
        SET last_accessed_at = ?, access_count = access_count + 1
        WHERE memory_id = ? AND status = 'active'
      `)
      for (const memoryId of new Set(memoryIds)) update.run(accessedAt, memoryId)
    })
  }

  listActiveEpisodes(course: string): readonly StudentMemory[] {
    return this.#database.prepare(`
      ${memorySelect()}
      WHERE status = 'active' AND kind = 'learning_episode' AND course = ?
      ORDER BY created_at, memory_id
    `).all(course).map(memoryFromRow)
  }

  linkEpisodeConsolidation(episodeId: string, memoryId: string): void {
    const episode = requireMemory(this.get(episodeId), episodeId)
    const higherMemory = requireMemory(this.get(memoryId), memoryId)
    if (episode.kind !== 'learning_episode') throw new Error('Consolidation source must be a learning episode')
    if (higherMemory.kind === 'learning_episode') throw new Error('Consolidation target must be a higher-level memory')
    this.#database.prepare(`
      INSERT OR IGNORE INTO memory_episode_consolidations (episode_id, memory_id, created_at)
      VALUES (?, ?, ?)
    `).run(episodeId, memoryId, this.#timestamp())
  }

  isEpisodeConsolidated(episodeId: string): boolean {
    return this.#database.prepare(`
      SELECT 1 FROM memory_episode_consolidations WHERE episode_id = ? LIMIT 1
    `).get(episodeId) !== undefined
  }

  getEmbedding(memoryId: string): MemoryEmbedding | undefined {
    const row = this.#database.prepare(`
      SELECT memory_id, model, dimensions, embedding, content_hash, created_at
      FROM memory_embeddings WHERE memory_id = ?
    `).get(memoryId)
    return row === undefined ? undefined : embeddingFromRow(row)
  }

  listEvents(memoryId: string): readonly MemoryEvent[] {
    return this.#database.prepare(`
      SELECT event_id, memory_id, operation, timestamp
      FROM memory_events WHERE memory_id = ? ORDER BY timestamp, rowid
    `).all(memoryId).map(eventFromRow)
  }

  close(): void {
    if (this.#database.isOpen) this.#database.close()
  }

  #deactivate(
    memoryId: string,
    status: 'resolved' | 'archived',
    operation: 'RESOLVE' | 'ARCHIVE',
  ): MemoryWriteResult {
    const timestamp = this.#timestamp()
    this.#transaction(() => {
      this.#database.prepare(`
        UPDATE memories SET status = ?, updated_at = ? WHERE memory_id = ?
      `).run(status, timestamp, memoryId)
      this.#database.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(memoryId)
      this.#deleteFts(memoryId)
      this.#writeEvent(memoryId, operation, timestamp)
    })
    return { operation, memory: requireMemory(this.get(memoryId), memoryId) }
  }

  #writeEmbedding(
    memoryId: string,
    content: string,
    embedding: MemoryEmbeddingInput,
    timestamp: string,
  ): void {
    validateEmbedding(embedding)
    const bytes = vectorToBytes(embedding.vector)
    this.#database.prepare(`
      INSERT INTO memory_embeddings (
        memory_id, model, dimensions, embedding, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        model = excluded.model,
        dimensions = excluded.dimensions,
        embedding = excluded.embedding,
        content_hash = excluded.content_hash,
        created_at = excluded.created_at
    `).run(
      memoryId,
      embedding.model.trim(),
      embedding.vector.length,
      bytes,
      contentHash(content),
      timestamp,
    )
  }

  #writeEvent(memoryId: string, operation: PersistedMemoryOperation, timestamp: string): void {
    this.#database.prepare(`
      INSERT INTO memory_events (event_id, memory_id, operation, timestamp)
      VALUES (?, ?, ?, ?)
    `).run(this.#createId(), memoryId, operation, timestamp)
  }

  #upsertFts(memoryId: string, content: string): void {
    this.#deleteFts(memoryId)
    this.#database.prepare(`
      INSERT INTO memory_fts (memory_id, content) VALUES (?, ?)
    `).run(memoryId, content)
  }

  #deleteFts(memoryId: string): void {
    this.#database.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memoryId)
  }

  #transaction<T>(callback: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK')
      } catch {
        // Preserve the operation error.
      }
      throw error
    }
  }

  #timestamp(): string {
    return this.#now().toISOString()
  }
}

function memorySelect(): string {
  return `SELECT memory_id, memory_key, kind, scope, course, topic, content, status,
                 importance, confidence, source_type, source_session_id, created_at,
                 updated_at, last_confirmed_at, last_accessed_at, access_count
          FROM memories`
}

function validateMemoryInput(input: AddMemoryInput): void {
  validateContentAndScores(input.content, input.importance, input.confidence)
  validateScope(input.scope, input.course, input.topic)
  validateEmbedding(input.embedding)
}

function validateUpdateInput(input: UpdateMemoryInput): void {
  validateContentAndScores(input.content, input.importance, input.confidence)
  validateEmbedding(input.embedding)
}

function validateContentAndScores(content: string, importance: number, confidence: number): void {
  if (content.trim().length === 0) throw new Error('Memory content cannot be empty')
  for (const [name, value] of [['importance', importance], ['confidence', confidence]] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${name} must be a finite number between 0 and 1`)
    }
  }
}

function validateScope(scope: MemoryScope, course?: string | null, topic?: string | null): void {
  const normalizedCourse = normalizedNullable(course)
  const normalizedTopic = normalizedNullable(topic)
  if (scope === 'global' && (normalizedCourse !== null || normalizedTopic !== null)) {
    throw new Error('Global memories cannot specify course or topic')
  }
  if (scope === 'course' && (normalizedCourse === null || normalizedTopic !== null)) {
    throw new Error('Course memories require course and cannot specify topic')
  }
  if (scope === 'topic' && normalizedTopic === null) {
    throw new Error('Topic memories require topic')
  }
}

function validateEmbedding(embedding: MemoryEmbeddingInput): void {
  if (embedding.model.trim().length === 0) throw new Error('Embedding model cannot be empty')
  if (embedding.vector.length === 0 || embedding.vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Embedding vector must contain finite values')
  }
}

function canonicalizeAndValidateKey(kind: CanonicalMemoryKind, memoryKey: string): string {
  const canonical = canonicalizeMemoryKey(memoryKey)
  if (kindForMemoryKey(canonical) !== kind) {
    throw new Error(`Memory key ${canonical} does not match kind ${kind}`)
  }
  return canonical
}

function normalizedNullable(value?: string | null): string | null {
  if (value === undefined || value === null) return null
  const normalized = value.trim()
  return normalized.length === 0 ? null : normalized
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function vectorToBytes(vector: readonly number[]): Uint8Array {
  const values = Float32Array.from(vector)
  return new Uint8Array(values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength))
}

function bytesToVector(bytes: Uint8Array): readonly number[] {
  const copy = Uint8Array.from(bytes)
  return Array.from(new Float32Array(copy.buffer))
}

function memoryFromRow(row: Record<string, unknown>): StudentMemory {
  return {
    memoryId: requiredString(row.memory_id, 'memory_id'),
    memoryKey: nullableString(row.memory_key, 'memory_key'),
    kind: requiredString(row.kind, 'kind') as MemoryKind,
    scope: requiredString(row.scope, 'scope') as MemoryScope,
    course: nullableString(row.course, 'course'),
    topic: nullableString(row.topic, 'topic'),
    content: requiredString(row.content, 'content'),
    status: requiredString(row.status, 'status') as StudentMemory['status'],
    importance: requiredNumber(row.importance, 'importance'),
    confidence: requiredNumber(row.confidence, 'confidence'),
    sourceType: requiredString(row.source_type, 'source_type') as MemorySourceType,
    sourceSessionId: nullableString(row.source_session_id, 'source_session_id'),
    createdAt: requiredString(row.created_at, 'created_at'),
    updatedAt: requiredString(row.updated_at, 'updated_at'),
    lastConfirmedAt: nullableString(row.last_confirmed_at, 'last_confirmed_at'),
    lastAccessedAt: nullableString(row.last_accessed_at, 'last_accessed_at'),
    accessCount: requiredNumber(row.access_count, 'access_count'),
  }
}

function embeddingFromRow(row: Record<string, unknown>): MemoryEmbedding {
  if (!(row.embedding instanceof Uint8Array)) throw new Error('Invalid memory embedding row')
  const vector = bytesToVector(row.embedding)
  const dimensions = requiredNumber(row.dimensions, 'dimensions')
  if (vector.length !== dimensions) throw new Error('Memory embedding dimensions do not match its blob')
  return {
    memoryId: requiredString(row.memory_id, 'memory_id'),
    model: requiredString(row.model, 'model'),
    vector,
    contentHash: requiredString(row.content_hash, 'content_hash'),
    createdAt: requiredString(row.created_at, 'created_at'),
  }
}

function eventFromRow(row: Record<string, unknown>): MemoryEvent {
  return {
    eventId: requiredString(row.event_id, 'event_id'),
    memoryId: requiredString(row.memory_id, 'memory_id'),
    operation: requiredString(row.operation, 'operation') as PersistedMemoryOperation,
    timestamp: requiredString(row.timestamp, 'timestamp'),
  }
}

function requireMemory(memory: StudentMemory | undefined, memoryId: string): StudentMemory {
  if (memory === undefined) throw new Error(`Memory not found: ${memoryId}`)
  return memory
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${field} in memory database`)
  return value
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null
  return requiredString(value, field)
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') throw new Error(`Invalid ${field} in memory database`)
  return value
}

function toFtsQuery(query: string): string {
  return query
    .normalize('NFKC')
    .match(/[\p{Letter}\p{Number}]+/gu)
    ?.map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(' OR ') ?? ''
}
