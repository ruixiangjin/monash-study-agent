import { existsSync, mkdirSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'

export const RUNTIME_DATABASE_SCHEMA_VERSION = 4

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
  {
    version: 3,
    name: 'create-memory-foundation',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          memory_id TEXT PRIMARY KEY,
          memory_key TEXT,
          kind TEXT NOT NULL CHECK (kind IN (
            'preference', 'study_progress', 'weakness', 'learning_episode', 'study_strategy'
          )),
          scope TEXT NOT NULL CHECK (scope IN ('global', 'course', 'topic')),
          course TEXT,
          topic TEXT,
          content TEXT NOT NULL CHECK (length(trim(content)) > 0),
          status TEXT NOT NULL CHECK (status IN ('active', 'resolved', 'archived')),
          importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
          confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
          source_type TEXT NOT NULL CHECK (source_type IN (
            'user_explicit', 'system_observed', 'derived', 'agent_inferred'
          )),
          source_session_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_confirmed_at TEXT,
          last_accessed_at TEXT,
          access_count INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
          CHECK (
            (scope = 'global' AND course IS NULL AND topic IS NULL)
            OR (scope = 'course' AND course IS NOT NULL AND topic IS NULL)
            OR (scope = 'topic' AND topic IS NOT NULL)
          ),
          CHECK (
            (kind = 'learning_episode' AND memory_key IS NULL AND status IN ('active', 'archived'))
            OR (kind IN ('weakness', 'study_progress') AND memory_key IS NOT NULL AND status IN ('active', 'resolved'))
            OR (kind IN ('preference', 'study_strategy') AND memory_key IS NOT NULL AND status = 'active')
          )
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_canonical_key
        ON memories(memory_key) WHERE memory_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_memories_active_scope
        ON memories(status, scope, course, topic);

        CREATE TABLE IF NOT EXISTS memory_embeddings (
          memory_id TEXT PRIMARY KEY REFERENCES memories(memory_id) ON DELETE CASCADE,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL CHECK (dimensions > 0),
          embedding BLOB NOT NULL,
          content_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          CHECK (length(embedding) = dimensions * 4)
        );

        CREATE TABLE IF NOT EXISTS memory_events (
          event_id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL,
          operation TEXT NOT NULL CHECK (operation IN ('ADD', 'UPDATE', 'RESOLVE', 'ARCHIVE', 'DELETE')),
          timestamp TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_events_memory_time
        ON memory_events(memory_id, timestamp);
      `)
    },
  },
  {
    version: 4,
    name: 'create-memory-recall-indexes',
    apply(database) {
      database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          memory_id UNINDEXED,
          content,
          tokenize = 'unicode61'
        );
        INSERT INTO memory_fts (memory_id, content)
        SELECT memory_id, content
        FROM memories
        WHERE status = 'active';

        CREATE TABLE IF NOT EXISTS memory_episode_consolidations (
          episode_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
          memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY (episode_id, memory_id),
          CHECK (episode_id <> memory_id)
        );
      `)
    },
  },
]

/** Explicitly creates a runtime database and applies all pending migrations. */
export function initializeRuntimeDatabase(databasePath: string): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true })
  return openDatabase(databasePath, true)
}

/** Opens an already initialized runtime database without creating a new one. */
export function openRuntimeDatabase(databasePath: string): DatabaseSync {
  return openDatabase(databasePath, false)
}

function openDatabase(databasePath: string, allowCreate: boolean): DatabaseSync {
  if (!allowCreate) assertExistingDatabase(databasePath)
  const database = new DatabaseSync(databasePath)
  database.exec('PRAGMA foreign_keys = ON')
  if (allowCreate) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `)
  } else if (!hasMigrationTable(database)) {
    database.close()
    throw new Error(`Runtime database is not initialized: ${databasePath}`)
  }

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

function assertExistingDatabase(databasePath: string): void {
  if (!existsSync(databasePath)) {
    throw new Error(`Runtime database does not exist: ${databasePath}; initialize it explicitly before opening it`)
  }
  try {
    if (!statSync(databasePath).isFile()) throw new Error('not a file')
  } catch (error) {
    throw new Error(`Runtime database is not a readable file: ${databasePath} (${errorMessage(error)})`)
  }
}

function hasMigrationTable(database: DatabaseSync): boolean {
  return database.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get() !== undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
