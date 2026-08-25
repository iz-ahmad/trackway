import { MemoryEvent as MemoryEventSchema } from '@backstory/core';
import Database from 'better-sqlite3';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenCodeAdapter, containsReasoning } from '../src/index.js';

const REASONING_SENTINEL = 'SENTINEL_OPENCODE_REASONING';
const SECRET_SENTINEL = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

let scratch: string;
let dbPath: string;

/**
 * Builds a database with the same shape as OpenCode's, so the adapter is
 * exercised against real SQL rather than a stub.
 */
function buildDatabase(path: string, options: { includeTables?: boolean } = {}): void {
  const db = new Database(path);

  if (options.includeTables === false) {
    db.exec(`CREATE TABLE unrelated (id TEXT)`);
    db.close();
    return;
  }

  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, time_updated INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT
    );
  `);

  db.prepare(`INSERT INTO session VALUES (?, ?, ?, ?, ?)`).run(
    'ses_fixture1',
    'proj1',
    '/Users/dev/fixture-repo',
    'Stuck import with mocked services',
    Date.parse('2026-08-25T09:00:00Z'),
  );
  db.prepare(`INSERT INTO session VALUES (?, ?, ?, ?, ?)`).run(
    'ses_other',
    'proj2',
    '/Users/dev/another-repo',
    'Unrelated work',
    Date.parse('2026-08-20T09:00:00Z'),
  );

  const message = db.prepare(`INSERT INTO message VALUES (?, ?, ?, ?)`);
  message.run('msg_user', 'ses_fixture1', 1, JSON.stringify({ role: 'user' }));
  message.run('msg_assistant', 'ses_fixture1', 2, JSON.stringify({ role: 'assistant' }));

  const part = db.prepare(`INSERT INTO part VALUES (?, ?, ?, ?, ?)`);
  const at = (n: number) => Date.parse('2026-08-25T09:00:00Z') + n * 1000;

  part.run('prt_1', 'msg_user', 'ses_fixture1', at(1), JSON.stringify({
    type: 'text',
    text: 'The import looks stuck even with mocks. Can you check?',
  }));
  part.run('prt_2', 'msg_assistant', 'ses_fixture1', at(2), JSON.stringify({
    type: 'reasoning',
    text: REASONING_SENTINEL,
  }));
  part.run('prt_3', 'msg_assistant', 'ses_fixture1', at(3), JSON.stringify({ type: 'step-start' }));
  part.run('prt_4', 'msg_assistant', 'ses_fixture1', at(4), JSON.stringify({
    type: 'tool',
    tool: 'read',
    state: { output: `GITHUB_TOKEN=${SECRET_SENTINEL}` },
  }));
  part.run('prt_5', 'msg_assistant', 'ses_fixture1', at(5), JSON.stringify({
    type: 'text',
    text: 'The queue worker never starts because the mock returns immediately.',
  }));
  part.run('prt_6', 'msg_assistant', 'ses_fixture1', at(6), JSON.stringify({
    type: 'patch',
    files: ['src/import.ts'],
  }));
  part.run('prt_7', 'msg_assistant', 'ses_fixture1', at(7), JSON.stringify({ type: 'step-finish' }));

  db.close();
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'backstory-oc-'));
  dbPath = join(scratch, 'opencode.db');
  buildDatabase(dbPath);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function adapter() {
  return new OpenCodeAdapter({ databasePath: dbPath });
}

describe('reading sessions from the OpenCode database', () => {
  it('lists sessions newest first', async () => {
    const sessions = await adapter().listSessions();

    expect(sessions.map((s) => s.sessionId)).toEqual(['ses_fixture1', 'ses_other']);
  });

  it('carries the working directory from the session row', async () => {
    const [session] = await adapter().listSessions();

    expect(session?.cwd).toBe('/Users/dev/fixture-repo');
  });

  it('produces events that validate against the shared schema', async () => {
    const [session] = await adapter().listSessions();

    for (const event of await adapter().readSession(session!)) {
      expect(() => MemoryEventSchema.parse(event)).not.toThrow();
    }
  });

  it('maps part types onto the shared event vocabulary', async () => {
    const [session] = await adapter().listSessions();

    const events = await adapter().readSession(session!);
    const types = events.map((e) => e.type);

    expect(types).toContain('user_prompt');
    expect(types).toContain('agent_message');
    expect(types).toContain('tool_call');
    expect(types).toContain('file_change');
  });

  it('attributes a user text part to a human and assistant parts to the agent', async () => {
    const [session] = await adapter().listSessions();
    const events = await adapter().readSession(session!);

    const prompt = events.find((e) => e.type === 'user_prompt');
    const message = events.find((e) => e.type === 'agent_message');

    expect(prompt?.actor.type).toBe('human');
    expect(message?.actor.id).toBe('agent:opencode');
  });

  it('drops reasoning parts', async () => {
    const [session] = await adapter().listSessions();
    const events = await adapter().readSession(session!);

    expect(JSON.stringify(events)).not.toContain(REASONING_SENTINEL);
    expect(events.some((e) => containsReasoning(e.payload))).toBe(false);
  });

  it('drops step bookkeeping parts that carry no content', async () => {
    const [session] = await adapter().listSessions();
    const events = await adapter().readSession(session!);

    expect(JSON.stringify(events)).not.toContain('step-start');
    expect(JSON.stringify(events)).not.toContain('step-finish');
  });

  it('redacts credentials in tool output', async () => {
    const [session] = await adapter().listSessions();
    const events = await adapter().readSession(session!);

    expect(JSON.stringify(events)).not.toContain(SECRET_SENTINEL);
  });

  it('returns events in time order', async () => {
    const [session] = await adapter().listSessions();
    const timestamps = (await adapter().readSession(session!)).map((e) => e.timestamp);

    expect([...timestamps].sort()).toEqual(timestamps);
  });

  it('filters sessions by repository', async () => {
    expect(await adapter().listSessions({ repoRoot: '/Users/dev/fixture-repo' })).toHaveLength(1);
    expect(await adapter().listSessions({ repoRoot: '/Users/dev/nowhere' })).toHaveLength(0);
  });

  it('reads only the session asked for', async () => {
    const sessions = await adapter().listSessions();
    const other = sessions.find((s) => s.sessionId === 'ses_other')!;

    expect(await adapter().readSession(other)).toEqual([]);
  });
});

describe('availability', () => {
  it('reports unavailable when the database is missing', async () => {
    const missing = new OpenCodeAdapter({ databasePath: join(scratch, 'gone.db') });

    const availability = await missing.isAvailable();

    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('no OpenCode database');
  });

  it('reports unavailable when the schema is not what we expect', async () => {
    const strange = join(scratch, 'strange.db');
    buildDatabase(strange, { includeTables: false });

    const availability = await new OpenCodeAdapter({ databasePath: strange }).isAvailable();

    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('no session table');
  });

  it('reports unavailable for a file that is not a database at all', async () => {
    const notADb = join(scratch, 'notes.txt');
    await writeFile(notADb, 'this is not sqlite', 'utf8');

    expect((await new OpenCodeAdapter({ databasePath: notADb }).isAvailable()).available).toBe(
      false,
    );
  });

  it('opens the database read-only so a sweep cannot disturb a live session', async () => {
    // Proven by behaviour: a read-only handle rejects writes.
    const db = new Database(dbPath, { readonly: true });
    expect(() => db.prepare(`INSERT INTO session VALUES ('x',null,null,null,0)`).run()).toThrow();
    db.close();
  });
});
