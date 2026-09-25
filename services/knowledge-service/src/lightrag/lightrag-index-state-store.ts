import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'

import type { LightRAGIndexState } from './lightrag-index-state.js'
import { openLightRAGDatabase } from './lightrag-database.js'
import { loadRuntimeConfig } from '../runtime/runtime-config.js'

export interface LightRAGIndexStateStoreOptions {
  readonly databasePath?: string
  readonly configPath?: string
  readonly applicationRoot?: string
  readonly runtimeConfig?: import('../runtime/runtime-config.js').LoadedRuntimeConfig
  readonly initializeDatabase?: boolean
}

export type LightRAGSyncRunStatus = 'running' | 'incomplete' | 'failed' | 'completed' | 'recovered'
export type LightRAGSyncOperation = 'index' | 'update' | 'remove'
export type LightRAGSyncOperationStatus = 'planned' | 'succeeded' | 'failed' | 'incomplete'

export interface LightRAGSyncRun {
  readonly runId: string
  readonly course: string
  readonly status: LightRAGSyncRunStatus
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly error: string | null
}

export interface LightRAGSyncJournalOperation {
  readonly operationId: number
  readonly runId: string
  readonly documentId: string
  readonly operation: LightRAGSyncOperation
  readonly status: LightRAGSyncOperationStatus
  readonly error: string | null
  readonly finishedAt: string | null
}

export interface LightRAGSyncJournalInput {
  readonly documentId: string
  readonly operation: LightRAGSyncOperation
}

export interface LightRAGSyncJournal {
  readonly run: LightRAGSyncRun
  readonly operations: readonly LightRAGSyncJournalOperation[]
}

/** Persists successful LightRAG document indexes in the local runtime database. */
export class LightRAGIndexStateStore {
  readonly #database: DatabaseSync

  constructor(options: LightRAGIndexStateStoreOptions = {}) {
    const runtimeConfig = options.runtimeConfig ?? loadRuntimeConfig({
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.applicationRoot === undefined ? {} : { applicationRoot: options.applicationRoot }),
    })
    const databasePath = resolve(
      options.databasePath ?? runtimeConfig.lightrag.sqlitePath,
    )
    this.#database = openLightRAGDatabase(databasePath, options.initializeDatabase === true)
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

  transaction<T>(callback: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK')
      } catch {
        // Preserve the original transaction error.
      }
      throw error
    }
  }

  beginCourseRun(course: string, operations: readonly LightRAGSyncJournalInput[]): LightRAGSyncJournal {
    const run: LightRAGSyncRun = {
      runId: randomUUID(),
      course,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    }
    const journalOperations: LightRAGSyncJournalOperation[] = []
    this.transaction(() => {
      this.#database
        .prepare(`
          INSERT INTO knowledge_sync_runs (run_id, course, status, started_at, finished_at, error)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(run.runId, run.course, run.status, run.startedAt, run.finishedAt, run.error)
      const insert = this.#database.prepare(`
        INSERT INTO knowledge_sync_operations
          (run_id, document_id, operation, status, error, finished_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      for (const operation of operations) {
        const result = insert.run(run.runId, operation.documentId, operation.operation, 'planned', null, null)
        journalOperations.push({
          operationId: Number(result.lastInsertRowid),
          runId: run.runId,
          documentId: operation.documentId,
          operation: operation.operation,
          status: 'planned',
          error: null,
          finishedAt: null,
        })
      }
    })
    return { run, operations: journalOperations }
  }

  markOperation(
    operationId: number,
    status: LightRAGSyncOperationStatus,
    error: string | null = null,
  ): void {
    this.#database
      .prepare(`
        UPDATE knowledge_sync_operations
        SET status = ?, error = ?, finished_at = ?
        WHERE operation_id = ?
      `)
      .run(status, error, status === 'planned' ? null : new Date().toISOString(), operationId)
  }

  markRun(runId: string, status: LightRAGSyncRunStatus, error: string | null = null): void {
    this.#database
      .prepare(`
        UPDATE knowledge_sync_runs
        SET status = ?, error = ?, finished_at = ?
        WHERE run_id = ?
      `)
      .run(status, error, status === 'running' ? null : new Date().toISOString(), runId)
  }

  markPriorRunsRecovered(course: string, currentRunId: string): void {
    this.#database
      .prepare(`
        UPDATE knowledge_sync_runs
        SET status = 'recovered', finished_at = COALESCE(finished_at, ?)
        WHERE course = ?
          AND run_id <> ?
          AND status IN ('running', 'incomplete', 'failed')
      `)
      .run(new Date().toISOString(), course, currentRunId)
  }

  listIncompleteRuns(course: string): readonly LightRAGSyncRun[] {
    return this.#database
      .prepare(`
        SELECT run_id, course, status, started_at, finished_at, error
        FROM knowledge_sync_runs
        WHERE course = ? AND status NOT IN ('completed', 'recovered')
        ORDER BY started_at
      `)
      .all(course)
      .map(syncRunFromRow)
  }

  hasIncompleteCourseRun(course: string): boolean {
    return this.listIncompleteRuns(course).length > 0
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

function syncRunFromRow(row: Record<string, unknown>): LightRAGSyncRun {
  if (!isString(row.run_id)
    || !isString(row.course)
    || !isSyncRunStatus(row.status)
    || !isString(row.started_at)
    || !isNullableString(row.finished_at)
    || !isNullableString(row.error)) {
    throw new Error('Invalid row in knowledge_sync_runs')
  }
  return {
    runId: row.run_id,
    course: row.course,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  }
}

function isSyncRunStatus(value: unknown): value is LightRAGSyncRunStatus {
  return value === 'running'
    || value === 'incomplete'
    || value === 'failed'
    || value === 'completed'
    || value === 'recovered'
}
