import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countRecords,
  getRecord,
  isStale,
  listRecords,
  listSessions,
  openIndex,
  rebuildIndex,
  rebuildIndexAt,
  removeRecord,
  search,
  searchAlternatives,
  toMatchExpression,
  upsertRecord,
  upsertRecords,
  writeRecords,
  writeSchemaVersion,
  type IndexDatabase,
} from '../src/index.js';
import { makeDecision, makeDiscovery } from './helpers/records.js';

let db: IndexDatabase;
let storeDir: string;

beforeEach(async () => {
  db = openIndex(':memory:');
  storeDir = await mkdtemp(join(tmpdir(), 'trackway-index-'));
});

afterEach(async () => {
  db.close();
  await rm(storeDir, { recursive: true, force: true });
});

const cachingDecision = makeDecision({
  question: 'Which cache should we use?',
  choice: 'Redis',
  reason: 'Redis is already deployed and supports the TTL behaviour we need.',
  alternatives: [
    {
      choice: 'PostgreSQL unlogged tables',
      status: 'rejected',
      reason: 'Higher latency for this workload than Redis.',
      condition: 'Redis is already deployed here',
    },
    {
      choice: 'In-process memory cache',
      status: 'rejected',
      reason: 'Does not survive a deploy and cannot be shared across workers.',
      condition: null,
    },
  ],
});

const webhookDiscovery = makeDiscovery({
  text: 'Webhook delivery is not idempotent and can fire more than once.',
});

describe('full-text search', () => {
  beforeEach(() => upsertRecords(db, [cachingDecision, webhookDiscovery]));

  it('matches text across every record type', () => {
    expect(search(db, 'Redis').map((h) => h.record.id)).toContain(cachingDecision.id);
    expect(search(db, 'webhook').map((h) => h.record.id)).toContain(webhookDiscovery.id);
  });

  it('carries the session and timestamp on every hit', () => {
    const [hit] = search(db, 'Redis');

    expect(hit?.record.sessionId).toBe(cachingDecision.sessionId);
    expect(hit?.record.createdAt).toBe(cachingDecision.createdAt);
  });

  it('treats multiple words as an AND rather than a phrase', () => {
    expect(search(db, 'Redis deployed')).toHaveLength(1);
    expect(search(db, 'Redis unicorn')).toHaveLength(0);
  });

  it('filters by record type', () => {
    const hits = search(db, 'Redis', { types: ['discovery'] });
    expect(hits).toHaveLength(0);
  });

  it('returns nothing for an empty query rather than raising', () => {
    expect(search(db, '   ')).toEqual([]);
  });

  it('survives input that would be FTS5 syntax', () => {
    for (const query of ['NEAR(', 'a OR', '"unclosed', 'x AND AND y', '*', '^foo']) {
      expect(() => search(db, query)).not.toThrow();
    }
  });

  it('builds a null match expression only when there are no usable terms', () => {
    expect(toMatchExpression('')).toBeNull();
    expect(toMatchExpression('"')).toBeNull();
    expect(toMatchExpression('redis cache')).toBe('"redis" AND "cache"');
  });
});

describe('searching rejected alternatives directly', () => {
  beforeEach(() => upsertRecords(db, [cachingDecision, webhookDiscovery]));

  it('finds an option by text that appears only inside a rejected alternative', () => {
    const hits = searchAlternatives(db, 'PostgreSQL');

    expect(hits).toHaveLength(1);
    expect(hits[0]?.choice).toBe('PostgreSQL unlogged tables');
    expect(hits[0]?.reason).toContain('Higher latency');
  });

  it('reports which decision displaced the rejected option', () => {
    const [hit] = searchAlternatives(db, 'PostgreSQL');

    expect(hit?.decisionId).toBe(cachingDecision.id);
    expect(hit?.decisionChoice).toBe('Redis');
  });

  it('carries the condition that made the rejection valid at the time', () => {
    const [hit] = searchAlternatives(db, 'PostgreSQL');
    expect(hit?.condition).toBe('Redis is already deployed here');
  });

  it('returns every matching alternative on one decision', () => {
    expect(searchAlternatives(db, 'cache')).not.toHaveLength(0);
  });

  it('finds an alternative whose text never appears in the chosen option', () => {
    // "unlogged" exists only in the rejected branch.
    expect(searchAlternatives(db, 'unlogged')).toHaveLength(1);
  });
});

describe('filtering', () => {
  const agentProposed = makeDecision({
    question: 'Should retries be idempotent?',
    choice: 'Make retries idempotent',
    attribution: {
      proposedBy: { type: 'agent', id: 'agent:claude-code' },
      acceptedBy: { type: 'human', id: 'human:7a91' },
    },
  });

  const implicitlyAccepted = makeDecision({
    question: 'Which log level for the sweep?',
    choice: 'Warn',
    attribution: { proposedBy: { type: 'agent', id: 'agent:claude-code' }, acceptedBy: 'implicit' },
  });

  const humanProposed = makeDecision({
    question: 'Do we expose this endpoint publicly?',
    choice: 'Keep it internal',
    attribution: {
      proposedBy: { type: 'human', id: 'human:7a91' },
      acceptedBy: { type: 'human', id: 'human:7a91' },
    },
  });

  beforeEach(() => upsertRecords(db, [agentProposed, implicitlyAccepted, humanProposed]));

  it('partitions decisions by who proposed them', () => {
    expect(listRecords(db, { actor: 'human' }).map((r) => r.id)).toEqual([humanProposed.id]);
    expect(listRecords(db, { actor: 'agent' }).map((r) => r.id).sort()).toEqual(
      [agentProposed.id, implicitlyAccepted.id].sort(),
    );
  });

  it('isolates decisions the agent made with no explicit approval', () => {
    const hits = listRecords(db, { implicitOnly: true });

    expect(hits.map((r) => r.id)).toEqual([implicitlyAccepted.id]);
  });

  it('does not report an implicitly accepted decision as human accepted', () => {
    const ids = listRecords(db, { implicitOnly: true }).map((r) => r.id);
    expect(ids).not.toContain(agentProposed.id);
  });
});

describe('upsert', () => {
  it('leaves one row when the same record is indexed twice', () => {
    upsertRecord(db, cachingDecision);
    upsertRecord(db, cachingDecision);

    expect(countRecords(db)).toBe(1);
    expect(search(db, 'Redis')).toHaveLength(1);
  });

  it('does not duplicate alternatives when a record is re-indexed', () => {
    upsertRecord(db, cachingDecision);
    upsertRecord(db, cachingDecision);

    expect(searchAlternatives(db, 'PostgreSQL')).toHaveLength(1);
  });

  it('replaces prior content when a record is updated in place', () => {
    upsertRecord(db, cachingDecision);
    upsertRecord(db, makeDecision({ ...cachingDecision, reason: 'Rewritten rationale entirely.' }));

    const found = getRecord(db, cachingDecision.id);
    expect(found?.type === 'decision' && found.reason).toBe('Rewritten rationale entirely.');
  });

  it('removes a record and its alternatives together', () => {
    upsertRecord(db, cachingDecision);
    removeRecord(db, cachingDecision.id);

    expect(countRecords(db)).toBe(0);
    expect(searchAlternatives(db, 'PostgreSQL')).toHaveLength(0);
    expect(getRecord(db, cachingDecision.id)).toBeNull();
  });
});

describe('rebuild', () => {
  // Covers AE8.
  it('reproduces identical query results after the index is deleted', async () => {
    await writeRecords(storeDir, [cachingDecision, webhookDiscovery]);
    const indexPath = join(storeDir, 'index.sqlite');

    await rebuildIndexAt(indexPath, storeDir);
    const first = openIndex(indexPath);
    const before = search(first, 'Redis').map((h) => h.record.id);
    const beforeAlternatives = searchAlternatives(first, 'PostgreSQL').map((a) => a.choice);
    first.close();

    await rm(indexPath, { force: true });
    await rebuildIndexAt(indexPath, storeDir);
    const second = openIndex(indexPath);
    const after = search(second, 'Redis').map((h) => h.record.id);
    const afterAlternatives = searchAlternatives(second, 'PostgreSQL').map((a) => a.choice);
    second.close();

    expect(after).toEqual(before);
    expect(afterAlternatives).toEqual(beforeAlternatives);
    expect(after).not.toHaveLength(0);
  });

  it('rebuilds from record files alone with no other input', async () => {
    await writeRecords(storeDir, [cachingDecision, webhookDiscovery]);

    const result = await rebuildIndex(db, storeDir);

    expect(result.indexed).toBe(2);
    expect(result.failures).toEqual([]);
    expect(countRecords(db)).toBe(2);
  });

  it('drops records that are no longer on disk', async () => {
    upsertRecords(db, [cachingDecision, webhookDiscovery]);
    await writeRecords(storeDir, [webhookDiscovery]);

    await rebuildIndex(db, storeDir);

    expect(getRecord(db, cachingDecision.id)).toBeNull();
    expect(getRecord(db, webhookDiscovery.id)).not.toBeNull();
  });

  it('reports unreadable files without aborting the rebuild', async () => {
    await writeRecords(storeDir, [cachingDecision]);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(storeDir, 'dec-20260825-broken.md'), 'garbage', 'utf8');

    const result = await rebuildIndex(db, storeDir);

    expect(result.indexed).toBe(1);
    expect(result.failures).toHaveLength(1);
  });
});

describe('schema versioning', () => {
  it('marks an index built by another schema version as stale', () => {
    expect(isStale(db)).toBe(false);
    writeSchemaVersion(db, 999);
    expect(isStale(db)).toBe(true);
  });
});

describe('sessions', () => {
  it('summarises records grouped by session', () => {
    upsertRecords(db, [
      cachingDecision,
      webhookDiscovery,
      makeDiscovery({ sessionId: 'ses-2', text: 'A separate finding from another session.' }),
    ]);

    const sessions = listSessions(db);

    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.sessionId === 'ses-1')?.recordCount).toBe(2);
  });
});

describe('concurrency', () => {
  it('serves readers while a writer commits, under WAL', async () => {
    const indexPath = join(storeDir, 'index.sqlite');
    const writer = openIndex(indexPath);
    const readerA = openIndex(indexPath);
    const readerB = openIndex(indexPath);

    try {
      upsertRecord(writer, cachingDecision);

      expect(() => search(readerA, 'Redis')).not.toThrow();
      expect(() => search(readerB, 'Redis')).not.toThrow();
      expect(search(readerA, 'Redis')).toHaveLength(1);

      upsertRecord(writer, webhookDiscovery);
      expect(countRecords(readerB)).toBe(2);
    } finally {
      writer.close();
      readerA.close();
      readerB.close();
    }
  });
});
