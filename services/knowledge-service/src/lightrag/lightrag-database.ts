import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'

export const LIGHTRAG_DATABASE_SCHEMA_VERSION = 2

interface Migration {
  readonly version: number
  readonly name: string
  readonly apply: (database: DatabaseSync) => void
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'create-lightrag-index-state',
    apply(database) {
      database.exec(`
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
    },
  },
  {
    version: 2,
    name: 'create-knowledge-sync-journal',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_sync_runs (
          run_id TEXT PRIMARY KEY,
          course TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('running', 'incomplete', 'failed', 'completed', 'recovered')),
          started_at TEXT NOT NULL,
          finished_at TEXT,
          error TEXT
        );
        CREATE TABLE IF NOT EXISTS knowledge_sync_operations (
          operation_id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES knowledge_sync_runs(run_id),
          document_id TEXT NOT NULL,
          operation TEXT NOT NULL CHECK (operation IN ('index', 'update', 'remove')),
          status TEXT NOT NULL CHECK (status IN ('planned', 'succeeded', 'failed', 'incomplete')),
          error TEXT,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_sync_runs_course_status
        ON knowledge_sync_runs(course, status);
        CREATE INDEX IF NOT EXISTS idx_knowledge_sync_operations_run
        ON knowledge_sync_operations(run_id);
      `)
    },
  },
]

/** Open the runtime database and apply all migrations in one SQLite transaction. */
export function openLightRAGDatabase(databasePath: string): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true })
  const database = new DatabaseSync(databasePath)
  database.exec('PRAGMA foreign_keys = ON')
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)

  try {
    const applied = new Set(
      database
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((row) => row.version)
        .filter((version): version is number => typeof version === 'number'),
    )
    const pending = MIGRATIONS.filter((migration) => !applied.has(migration.version))
    if (pending.length === 0) return database

    database.exec('BEGIN IMMEDIATE')
    for (const migration of pending) {
      migration.apply(database)
      database
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString())
    }
    database.exec('COMMIT')
    return database
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the original migration error.
    }
    database.close()
    throw error
  }
}
