import type { MemoryRecord } from '../models/record.js';
import type { IndexDatabase } from './schema.js';

interface Searchable {
  title: string;
  body: string;
  status: string | null;
  actorType: string | null;
  acceptedBy: string | null;
}

/**
 * Flattens a record into the text search runs over, plus the few columns worth
 * filtering on. Everything else stays in the JSON column.
 */
function searchableOf(record: MemoryRecord): Searchable {
  switch (record.type) {
    case 'question':
      return {
        title: record.question,
        body: record.answer ?? '',
        status: record.status,
        actorType: record.actor.type,
        acceptedBy: null,
      };

    case 'discovery':
      return { title: record.text, body: '', status: null, actorType: null, acceptedBy: null };

    case 'decision': {
      const alternativeText = record.alternatives
        .map((alt) => `${alt.choice} ${alt.reason} ${alt.condition ?? ''}`)
        .join(' ');
      return {
        title: record.choice,
        body: `${record.question} ${record.reason} ${alternativeText}`.trim(),
        status: record.status,
        actorType: record.attribution.proposedBy.type,
        acceptedBy:
          record.attribution.acceptedBy === 'implicit'
            ? 'implicit'
            : record.attribution.acceptedBy.type,
      };
    }

    case 'action':
      return {
        title: record.description,
        body: record.files.join(' '),
        status: record.status,
        actorType: null,
        acceptedBy: null,
      };

    case 'outcome':
      return { title: record.text, body: '', status: record.result, actorType: null, acceptedBy: null };
  }
}

/**
 * Inserts or replaces one record and its alternatives.
 *
 * Deleting before inserting keeps the operation idempotent: indexing the same
 * record twice leaves one row, not two.
 */
export function upsertRecord(db: IndexDatabase, record: MemoryRecord): void {
  const searchable = searchableOf(record);

  const run = db.transaction(() => {
    removeRecord(db, record.id);

    db.prepare(
      `INSERT INTO records
         (id, type, session_id, episode_id, created_at, adapter,
          actor_type, accepted_by, status, title, body, json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id,
      record.type,
      record.sessionId,
      record.episodeId,
      record.createdAt,
      record.source.adapter,
      searchable.actorType,
      searchable.acceptedBy,
      searchable.status,
      searchable.title,
      searchable.body,
      JSON.stringify(record),
    );

    db.prepare(`INSERT INTO records_fts (id, title, body) VALUES (?, ?, ?)`).run(
      record.id,
      searchable.title,
      searchable.body,
    );

    if (record.type !== 'decision') return;

    record.alternatives.forEach((alt, position) => {
      const result = db
        .prepare(
          `INSERT INTO alternatives (decision_id, position, choice, status, reason, condition)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(record.id, position, alt.choice, alt.status, alt.reason, alt.condition);

      db.prepare(
        `INSERT INTO alternatives_fts (alternative_id, decision_id, choice, reason)
         VALUES (?, ?, ?, ?)`,
      ).run(String(result.lastInsertRowid), record.id, alt.choice, alt.reason);
    });
  });

  run();
}

export function upsertRecords(db: IndexDatabase, records: readonly MemoryRecord[]): void {
  const run = db.transaction(() => {
    for (const record of records) upsertRecord(db, record);
  });
  run();
}

export function removeRecord(db: IndexDatabase, id: string): void {
  const run = db.transaction(() => {
    const rows = db
      .prepare(`SELECT rowid_alias AS id FROM alternatives WHERE decision_id = ?`)
      .all(id) as Array<{ id: number }>;

    for (const row of rows) {
      db.prepare(`DELETE FROM alternatives_fts WHERE alternative_id = ?`).run(String(row.id));
    }

    db.prepare(`DELETE FROM alternatives WHERE decision_id = ?`).run(id);
    db.prepare(`DELETE FROM records_fts WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM records WHERE id = ?`).run(id);
  });

  run();
}

export function countRecords(db: IndexDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number };
  return row.n;
}
