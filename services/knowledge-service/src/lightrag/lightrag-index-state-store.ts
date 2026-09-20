import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, resolve } from 'node:path'

import type { LightRAGIndexState } from './lightrag-index-state.js'
import { loadRuntimeConfig } from '../runtime/runtime-config.js'

export interface LightRAGIndexStateStoreOptions {
  readonly databasePath?: string
  readonly configPath?: string
}

/** Persists successful LightRAG document indexes in the local runtime database. */
export class LightRAGIndexStateStore {
  readonly #database: DatabaseSync

  constructor(options: LightRAGIndexStateStoreOptions = {}) {
    const runtimeConfig = loadRuntimeConfig(options.configPath)
    const databasePath = resolve(
      options.databasePath ?? runtimeConfig.lightrag.sqlitePath,
    )
    mkdirSync(dirname(databasePath), { recursive: true })
    this.#database = new DatabaseSync(databasePath)
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS lightrag_index_state (
          document_id TEXT PRIMARY KEY,
          resource_id TEXT NOT NULL,
          course TEXT,
          source_hash TEXT NOT NULL,
          normalized_hash TEXT NOT NULL,
          normalization_version TEXT NOT NULL,
          source_path TEXT NOT NULL,
          indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lightrag_index_course
      ON lightrag_index_state(course);
    `)
  }

  get(documentId: string): LightRAGIndexState | undefined {
    const row = this.#database
      .prepare(`
        SELECT document_id, resource_id, course, source_hash, normalized_hash,
               normalization_version, source_path, indexed_at
        FROM lightrag_index_state
        WHERE document_id = ?
      `)
      .get(documentId)
    return row === undefined ? undefined : stateFromRow(row)
  }

  listByCourse(course: string | null): readonly LightRAGIndexState[] {
    const rows = this.#database
      .prepare(`
        SELECT document_id, resource_id, course, source_hash, normalized_hash,
               normalization_version, source_path, indexed_at
        FROM lightrag_index_state
        WHERE course IS ?
        ORDER BY document_id
      `)
      .all(course)
    return rows.map(stateFromRow)
  }

  upsert(state: LightRAGIndexState): void {
    this.#database
      .prepare(`
        INSERT INTO lightrag_index_state (
          document_id,
          resource_id,
          course,
          source_hash,
          normalized_hash,
          normalization_version,
          source_path,
          indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          resource_id = excluded.resource_id,
          course = excluded.course,
          source_hash = excluded.source_hash,
          normalized_hash = excluded.normalized_hash,
          normalization_version = excluded.normalization_version,
          source_path = excluded.source_path,
          indexed_at = excluded.indexed_at
      `)
      .run(
        state.documentId,
        state.resourceId,
        state.course,
        state.sourceHash,
        state.normalizedHash,
        state.normalizationVersion,
        state.sourcePath,
        state.indexedAt,
      )
  }

  delete(documentId: string): void {
    this.#database
      .prepare('DELETE FROM lightrag_index_state WHERE document_id = ?')
      .run(documentId)
  }

  close(): void {
    if (this.#database.isOpen) this.#database.close()
  }
}

function stateFromRow(row: Record<string, unknown>): LightRAGIndexState {
  if (!isString(row.document_id)
    || !isString(row.resource_id)
    || !isNullableString(row.course)
    || !isString(row.source_hash)
    || !isString(row.normalized_hash)
    || !isString(row.normalization_version)
    || !isString(row.source_path)
    || !isString(row.indexed_at)) {
    throw new Error('Invalid row in lightrag_index_state')
  }
  return {
    documentId: row.document_id,
    resourceId: row.resource_id,
    course: row.course,
    sourceHash: row.source_hash,
    normalizedHash: row.normalized_hash,
    normalizationVersion: row.normalization_version,
    sourcePath: row.source_path,
    indexedAt: row.indexed_at,
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}
