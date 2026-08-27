import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MalformedRecordError,
  deriveRecordId,
  deserializeRecord,
  forgetRecord,
  forgetSession,
  readAllRecords,
  recordTypeFromId,
  serializeRecord,
  withDerivedId,
  writeRecord,
  writeRecords,
} from '../src/index.js';
import { makeDecision, makeDiscovery } from './helpers/records.js';

let storeDir: string;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'trackway-store-'));
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe('record identity', () => {
  it('produces the same ID for the same content across separate derivations', () => {
    const a = makeDecision();
    const b = makeDecision();

    expect(a.id).toBe(b.id);
  });

  it('produces the same ID regardless of key order', () => {
    const record = makeDecision();
    const reordered = Object.fromEntries(
      Object.entries(record).reverse(),
    ) as unknown as typeof record;

    expect(deriveRecordId(reordered)).toBe(deriveRecordId(record));
  });

  it('produces a different ID when any content field differs', () => {
    const original = makeDecision();
    const changed = makeDecision({ choice: 'Synchronous processing' });

    expect(changed.id).not.toBe(original.id);
  });

  it('keeps identity stable when a reason or alternative is reworded', () => {
    const original = makeDecision();
    const reworded = makeDecision({
      reason: 'Provider callbacks are slow enough to block a request.',
      alternatives: [
        { choice: 'Cron polling', status: 'rejected', reason: 'Adds latency.', condition: null },
      ],
    });

    // Same decision, corrected wording. Updating in place beats minting a duplicate.
    expect(reworded.id).toBe(original.id);
  });

  it('gives two decisions from the same region distinct IDs when the choice differs', () => {
    const redis = makeDecision({ choice: 'Redis' });
    const postgres = makeDecision({ choice: 'PostgreSQL' });

    expect(redis.id).not.toBe(postgres.id);
  });

  it('gives identical content from a different session region a distinct ID', () => {
    const first = makeDecision();
    const second = makeDecision({
      source: { ...first.source, sessionId: 'ses-2', fromOffset: 40, toOffset: 60 },
    });

    expect(second.id).not.toBe(first.id);
  });

  it('keeps identity stable when a record is later grouped into an episode', () => {
    const ungrouped = makeDecision();
    const grouped = makeDecision({ episodeId: 'ep-1' });

    expect(grouped.id).toBe(ungrouped.id);
  });

  it('keeps identity stable when a record is later superseded', () => {
    const original = makeDecision();
    const superseded = makeDecision({ status: 'superseded', supersededBy: 'dec-x' });

    expect(superseded.id).toBe(original.id);
  });

  it('carries a type prefix that maps back to the record type', () => {
    expect(recordTypeFromId(makeDecision().id)).toBe('decision');
    expect(recordTypeFromId(makeDiscovery().id)).toBe('discovery');
    expect(recordTypeFromId('not-ours')).toBeNull();
  });

  // Covers AE10.
  it('gives records created independently on two branches distinct IDs', async () => {
    const branchA = makeDecision({ choice: 'Redis', reason: 'Already deployed here.' });
    const branchB = makeDecision({ choice: 'PostgreSQL', reason: 'One less service to run.' });

    await writeRecord(storeDir, branchA);
    await writeRecord(storeDir, branchB);

    expect(branchA.id).not.toBe(branchB.id);
    expect((await readdir(storeDir)).filter((f) => f.endsWith('.md'))).toHaveLength(2);
  });
});

describe('serialization', () => {
  it('round-trips a decision through frontmatter unchanged', () => {
    const record = makeDecision();
    expect(deserializeRecord(serializeRecord(record))).toEqual(record);
  });

  it('renders rejected alternatives into the readable body', () => {
    const text = serializeRecord(makeDecision());

    expect(text).toContain('## Not taken');
    expect(text).toContain('Synchronous processing');
    expect(text).toContain('Would block the request');
  });

  it('states plainly when no human approved a decision', () => {
    const text = serializeRecord(
      makeDecision({
        attribution: {
          proposedBy: { type: 'agent', id: 'agent:claude-code' },
          acceptedBy: 'implicit',
        },
      }),
    );

    expect(text).toContain('no explicit approval recorded');
  });

  it('rejects a file with no frontmatter', () => {
    expect(() => deserializeRecord('# just markdown')).toThrow(MalformedRecordError);
  });

  it('rejects a file whose frontmatter is not a valid record', () => {
    expect(() => deserializeRecord('---\ntype: decision\n---\n\nbody')).toThrow(
      MalformedRecordError,
    );
  });

  it('rejects unterminated frontmatter', () => {
    expect(() => deserializeRecord('---\ntype: decision\n')).toThrow(MalformedRecordError);
  });
});

describe('writing', () => {
  it('writes a record and reads it back', async () => {
    const record = makeDecision();
    const result = await writeRecord(storeDir, record);

    expect(result.written).toBe(true);
    const { records, failures } = await readAllRecords(storeDir);
    expect(failures).toEqual([]);
    expect(records).toEqual([record]);
  });

  it('does not rewrite a record whose content is already on disk', async () => {
    const record = makeDecision();
    const first = await writeRecord(storeDir, record);
    const before = await readFile(first.path, 'utf8');

    const second = await writeRecord(storeDir, record);

    expect(second.written).toBe(false);
    expect(await readFile(second.path, 'utf8')).toBe(before);
  });

  it('leaves no temporary files behind after a successful write', async () => {
    await writeRecords(storeDir, [makeDecision(), makeDiscovery()]);

    const stray = (await readdir(storeDir)).filter((name) => name.endsWith('.tmp'));
    expect(stray).toEqual([]);
  });

  it('ignores debris from an interrupted write and still reads the intact record', async () => {
    const record = makeDecision();
    const { path } = await writeRecord(storeDir, record);
    await writeFile(`${path}.abc123.tmp`, 'half-written garbage', 'utf8');

    const { records, failures } = await readAllRecords(storeDir);

    expect(failures).toEqual([]);
    expect(records).toEqual([record]);
  });

  it('returns records ordered by creation time', async () => {
    const later = makeDecision({ createdAt: '2026-08-25T11:00:00Z' });
    const earlier = makeDiscovery({ createdAt: '2026-08-25T08:00:00Z' });
    await writeRecords(storeDir, [later, earlier]);

    const { records } = await readAllRecords(storeDir);

    expect(records.map((r) => r.id)).toEqual([earlier.id, later.id]);
  });
});

describe('reading a damaged store', () => {
  it('reports a malformed record and keeps every other record readable', async () => {
    const good = makeDecision();
    await writeRecord(storeDir, good);
    await writeFile(join(storeDir, 'dec-20260825-broken.md'), 'not a record at all', 'utf8');

    const { records, failures } = await readAllRecords(storeDir);

    expect(records).toEqual([good]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.path).toContain('dec-20260825-broken.md');
  });

  it('returns nothing for a store directory that does not exist yet', async () => {
    const result = await readAllRecords(join(storeDir, 'missing'));
    expect(result).toEqual({ records: [], failures: [] });
  });
});

describe('forget', () => {
  it('removes a single record', async () => {
    const record = makeDecision();
    await writeRecord(storeDir, record);

    expect(await forgetRecord(storeDir, record.id)).toBe(true);
    expect((await readAllRecords(storeDir)).records).toEqual([]);
  });

  it('reports not-found for an unknown ID rather than failing silently', async () => {
    expect(await forgetRecord(storeDir, 'dec-20260825-nothere')).toBe(false);
  });

  it('removes every record from one session and leaves other sessions alone', async () => {
    const mine = makeDecision({ sessionId: 'ses-1' });
    const alsoMine = makeDiscovery({ sessionId: 'ses-1' });
    const other = makeDiscovery({ sessionId: 'ses-2', text: 'Unrelated finding.' });
    await writeRecords(storeDir, [mine, alsoMine, other]);

    const removed = await forgetSession(storeDir, 'ses-1');

    expect(removed.sort()).toEqual([mine.id, alsoMine.id].sort());
    expect((await readAllRecords(storeDir)).records).toEqual([other]);
  });

  it('returns an empty list when the session has no records', async () => {
    expect(await forgetSession(storeDir, 'ses-none')).toEqual([]);
  });
});

describe('withDerivedId', () => {
  it('replaces any id already present', () => {
    const record = makeDecision();
    const relabelled = withDerivedId({ ...record, id: 'dec-wrong' });

    expect(relabelled.id).toBe(record.id);
  });
});
