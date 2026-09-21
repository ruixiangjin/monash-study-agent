import { DatabaseSync } from 'node:sqlite'
import { openRuntimeDatabase } from '@monash-study/runtime-database'

export const LIGHTRAG_DATABASE_SCHEMA_VERSION = 2

/** Open the runtime database and apply all migrations in one SQLite transaction. */
export function openLightRAGDatabase(databasePath: string): DatabaseSync {
  return openRuntimeDatabase(databasePath)
}
