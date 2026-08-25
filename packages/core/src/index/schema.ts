import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Bumped whenever the schema changes. The index is derived state, so an
 * out-of-date index is dropped and rebuilt rather than migrated.
 */
export const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  episode_id  TEXT,
  created_at  TEXT NOT NULL,
  adapter     TEXT NOT NULL,
  actor_type  TEXT,
  accepted_by TEXT,
  status      TEXT,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  json        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS records_session  ON records (session_id);
CREATE INDEX IF NOT EXISTS records_type     ON records (type);
CREATE INDEX IF NOT EXISTS records_created  ON records (created_at);

-- Rejected options are the payload users come back for, so they get their own
-- searchable rows. Without this, finding one means opening decisions until it
-- turns up.
CREATE TABLE IF NOT EXISTS alternatives (
  rowid_alias INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT NOT NULL,
  position    INTEGER NOT NULL,
  choice      TEXT NOT NULL,
  status      TEXT NOT NULL,
  reason      TEXT NOT NULL,
  condition   TEXT,
  FOREIGN KEY (decision_id) REFERENCES records (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS alternatives_decision ON alternatives (decision_id);

CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
  id UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS alternatives_fts USING fts5(
  alternative_id UNINDEXED,
  decision_id UNINDEXED,
  choice,
  reason,
  tokenize = 'porter unicode61'
);
`;

export type IndexDatabase = Database.Database;

/**
 * Opens the index, creating it if absent.
 *
 * WAL is on because several readers coexist: the CLI, the explorer server, and
 * the MCP server, while a sweep writes. Without it they contend and one gets a
 * locked error.
 */
export function openIndex(path: string): IndexDatabase {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.exec(DDL);

  const current = readSchemaVersion(db);
  if (current === null) {
    writeSchemaVersion(db, SCHEMA_VERSION);
  }

  return db;
}

export function readSchemaVersion(db: IndexDatabase): number | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : null;
}

export function writeSchemaVersion(db: IndexDatabase, version: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(version));
}

/** True when the index was built by a different schema version and must be rebuilt. */
export function isStale(db: IndexDatabase): boolean {
  return readSchemaVersion(db) !== SCHEMA_VERSION;
}

export function clearIndex(db: IndexDatabase): void {
  db.exec(`
    DELETE FROM alternatives_fts;
    DELETE FROM records_fts;
    DELETE FROM alternatives;
    DELETE FROM records;
  `);
}
