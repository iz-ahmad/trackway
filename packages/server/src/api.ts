import {
  getRecord,
  listRecords,
  listSessions,
  search,
  searchAlternatives,
  type IndexDatabase,
  type MemoryRecord,
} from '@backstory/core';
import { Hono } from 'hono';

export interface ApiOptions {
  db: IndexDatabase;
}

export interface TimelineEntry {
  record: MemoryRecord;
  time: string;
}

export interface SessionTimeline {
  sessionId: string;
  entries: TimelineEntry[];
}

/**
 * The data API behind the explorer.
 *
 * Serves distilled records only. There is deliberately no endpoint that returns
 * raw events, so the explorer cannot render them as nodes even by accident, and
 * a session's full text never leaves the local process.
 */
export function createApi(options: ApiOptions): Hono {
  const app = new Hono();
  const { db } = options;

  app.get('/api/sessions', (c) => c.json({ sessions: listSessions(db) }));

  app.get('/api/sessions/:id', (c) => {
    const sessionId = c.req.param('id');
    const records = listRecords(db, { sessionId, limit: 1000 });

    if (records.length === 0) {
      return c.json({ error: `No records for session ${sessionId}` }, 404);
    }

    const entries = [...records]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((record) => ({ record, time: record.createdAt.slice(11, 16) }));

    return c.json({ sessionId, entries } satisfies SessionTimeline);
  });

  app.get('/api/records/:id', (c) => {
    const record = getRecord(db, c.req.param('id'));
    return record ? c.json({ record }) : c.json({ error: 'not found' }, 404);
  });

  app.get('/api/search', (c) => {
    const query = c.req.query('q') ?? '';
    const hits = search(db, query, { limit: 100 });
    return c.json({ query, records: hits.map((hit) => hit.record) });
  });

  app.get('/api/rejected', (c) => {
    const query = c.req.query('q');
    if (query) return c.json({ alternatives: searchAlternatives(db, query, { limit: 100 }) });

    const alternatives = listRecords(db, { types: ['decision'], limit: 500 }).flatMap((record) =>
      record.type === 'decision'
        ? record.alternatives.map((alternative) => ({
            ...alternative,
            decisionId: record.id,
            decisionChoice: record.choice,
            createdAt: record.createdAt,
            sessionId: record.sessionId,
          }))
        : [],
    );

    return c.json({ alternatives });
  });

  app.get('/api/decisions', (c) => {
    const actor = c.req.query('actor');
    return c.json({
      records: listRecords(db, {
        types: ['decision'],
        ...(actor === 'human' || actor === 'agent' ? { actor } : {}),
        limit: 500,
      }),
    });
  });

  /** Everything the project-history view needs, in one request. */
  app.get('/api/overview', (c) => {
    const sessions = listSessions(db);
    const decisions = listRecords(db, { types: ['decision'], limit: 1000 });

    const rejectedCount = decisions.reduce(
      (total, record) => total + (record.type === 'decision' ? record.alternatives.length : 0),
      0,
    );

    return c.json({
      sessions,
      counts: {
        sessions: sessions.length,
        records: sessions.reduce((total, session) => total + session.recordCount, 0),
        decisions: decisions.length,
        rejected: rejectedCount,
      },
    });
  });

  return app;
}
