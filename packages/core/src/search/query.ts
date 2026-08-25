import { MemoryRecord, type RecordType } from '../models/record.js';
import type { IndexDatabase } from '../index/schema.js';

export interface SearchOptions {
  types?: readonly RecordType[];
  sessionId?: string;
  /** Filters decisions by who proposed them. */
  actor?: 'human' | 'agent';
  /** Restricts to decisions an agent made with no explicit human approval. */
  implicitOnly?: boolean;
  limit?: number;
}

export interface SearchHit {
  record: MemoryRecord;
  /** Lower is a better match. Comes from FTS5 ranking. */
  rank: number;
}

export interface AlternativeHit {
  decisionId: string;
  decisionChoice: string;
  choice: string;
  status: string;
  reason: string;
  condition: string | null;
  createdAt: string;
  sessionId: string;
  rank: number;
}

const DEFAULT_LIMIT = 50;

/**
 * Turns user input into an FTS5 MATCH expression.
 *
 * FTS5 treats several characters as syntax and raises on malformed input. A
 * search box should never be able to produce a syntax error, so each word is
 * quoted and joined, which also makes multi-word input an AND rather than a
 * phrase.
 */
export function toMatchExpression(query: string): string | null {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/"/g, '').trim())
    .filter((term) => term.length > 0);

  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"`).join(' AND ');
}

/** Full-text search across every record type. */
export function search(db: IndexDatabase, query: string, options: SearchOptions = {}): SearchHit[] {
  const match = toMatchExpression(query);
  if (match === null) return [];

  const clauses: string[] = [];
  const params: unknown[] = [match];

  if (options.types && options.types.length > 0) {
    clauses.push(`r.type IN (${options.types.map(() => '?').join(', ')})`);
    params.push(...options.types);
  }
  if (options.sessionId) {
    clauses.push('r.session_id = ?');
    params.push(options.sessionId);
  }
  if (options.actor) {
    clauses.push('r.actor_type = ?');
    params.push(options.actor);
  }
  if (options.implicitOnly) {
    clauses.push(`r.accepted_by = 'implicit'`);
  }

  const where = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
  params.push(options.limit ?? DEFAULT_LIMIT);

  const rows = db
    .prepare(
      `SELECT r.json AS json, f.rank AS rank
         FROM records_fts f
         JOIN records r ON r.id = f.id
        WHERE records_fts MATCH ? ${where}
        ORDER BY f.rank
        LIMIT ?`,
    )
    .all(...params) as Array<{ json: string; rank: number }>;

  return rows.map((row) => ({ record: MemoryRecord.parse(JSON.parse(row.json)), rank: row.rank }));
}

/**
 * Searches rejected and considered options directly.
 *
 * This is the query the product exists for: finding what was ruled out without
 * knowing which decision ruled it out.
 */
export function searchAlternatives(
  db: IndexDatabase,
  query: string,
  options: { limit?: number; status?: 'rejected' | 'considered' } = {},
): AlternativeHit[] {
  const match = toMatchExpression(query);
  if (match === null) return [];

  const params: unknown[] = [match];
  let where = '';
  if (options.status) {
    where = 'AND a.status = ?';
    params.push(options.status);
  }
  params.push(options.limit ?? DEFAULT_LIMIT);

  const rows = db
    .prepare(
      `SELECT a.choice      AS choice,
              a.status      AS status,
              a.reason      AS reason,
              a.condition   AS condition,
              a.decision_id AS decisionId,
              r.title       AS decisionChoice,
              r.created_at  AS createdAt,
              r.session_id  AS sessionId,
              f.rank        AS rank
         FROM alternatives_fts f
         JOIN alternatives a ON a.rowid_alias = CAST(f.alternative_id AS INTEGER)
         JOIN records r      ON r.id = a.decision_id
        WHERE alternatives_fts MATCH ? ${where}
        ORDER BY f.rank
        LIMIT ?`,
    )
    .all(...params) as AlternativeHit[];

  return rows;
}

export function getRecord(db: IndexDatabase, id: string): MemoryRecord | null {
  const row = db.prepare(`SELECT json FROM records WHERE id = ?`).get(id) as
    | { json: string }
    | undefined;
  return row ? MemoryRecord.parse(JSON.parse(row.json)) : null;
}

/** Lists records without a text query, newest first. */
export function listRecords(db: IndexDatabase, options: SearchOptions = {}): MemoryRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.types && options.types.length > 0) {
    clauses.push(`type IN (${options.types.map(() => '?').join(', ')})`);
    params.push(...options.types);
  }
  if (options.sessionId) {
    clauses.push('session_id = ?');
    params.push(options.sessionId);
  }
  if (options.actor) {
    clauses.push('actor_type = ?');
    params.push(options.actor);
  }
  if (options.implicitOnly) {
    clauses.push(`accepted_by = 'implicit'`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(options.limit ?? DEFAULT_LIMIT);

  const rows = db
    .prepare(`SELECT json FROM records ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as Array<{ json: string }>;

  return rows.map((row) => MemoryRecord.parse(JSON.parse(row.json)));
}

export interface SessionSummary {
  sessionId: string;
  adapter: string;
  recordCount: number;
  firstAt: string;
  lastAt: string;
}

export function listSessions(db: IndexDatabase): SessionSummary[] {
  return db
    .prepare(
      `SELECT session_id AS sessionId,
              adapter,
              COUNT(*)        AS recordCount,
              MIN(created_at) AS firstAt,
              MAX(created_at) AS lastAt
         FROM records
        GROUP BY session_id, adapter
        ORDER BY lastAt DESC`,
    )
    .all() as SessionSummary[];
}
