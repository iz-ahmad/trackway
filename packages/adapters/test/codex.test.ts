import { MemoryEvent as MemoryEventSchema } from '@backstory/core';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterRegistry, CodexAdapter, containsReasoning } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures', 'codex');
const FIXTURE_FILE = join(FIXTURES, '2026', '08', '25', 'rollout-fixture.jsonl');

const REASONING_SENTINEL = 'SENTINEL_CODEX_REASONING';
const SECRET_SENTINEL = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY';

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'backstory-codex-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function adapterOver(sessionsDir: string) {
  return new CodexAdapter({ sessionsDir });
}

describe('parsing a real captured Codex session', () => {
  it('finds rollout files nested under date directories', async () => {
    const descriptors = await adapterOver(FIXTURES).listSessions();

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.sessionId).toBe('codex-fixture-1');
  });

  it('reads the working directory and branch from session metadata', async () => {
    const [descriptor] = await adapterOver(FIXTURES).listSessions();

    expect(descriptor?.cwd).toBe('/Users/dev/fixture-repo');
    expect(descriptor?.branch).toBe('main');
  });

  it('parses into normalized events that validate against the shared schema', async () => {
    const adapter = adapterOver(FIXTURES);
    const [descriptor] = await adapter.listSessions();

    const events = await adapter.readSession(descriptor!);

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(() => MemoryEventSchema.parse(event)).not.toThrow();
    }
  });

  it('maps the Codex entry vocabulary onto the shared event types', async () => {
    const adapter = adapterOver(FIXTURES);
    const [descriptor] = await adapter.listSessions();
    const events = await adapter.readSession(descriptor!);

    const types = new Set(events.map((e) => e.type));

    expect(types).toContain('session_start');
    expect(types).toContain('user_prompt');
    expect(types).toContain('agent_message');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
  });

  it('attributes user messages to a human and everything else to the agent', async () => {
    const adapter = adapterOver(FIXTURES);
    const [descriptor] = await adapter.listSessions();
    const events = await adapter.readSession(descriptor!);

    const prompts = events.filter((e) => e.type === 'user_prompt');

    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.every((e) => e.actor.type === 'human')).toBe(true);
    expect(
      events.filter((e) => e.type !== 'user_prompt').every((e) => e.actor.id === 'agent:codex'),
    ).toBe(true);
  });

  it('drops Codex reasoning entries entirely', async () => {
    const adapter = adapterOver(FIXTURES);
    const [descriptor] = await adapter.listSessions();
    const events = await adapter.readSession(descriptor!);

    expect(await readFile(FIXTURE_FILE, 'utf8')).toContain(REASONING_SENTINEL);

    expect(JSON.stringify(events)).not.toContain(REASONING_SENTINEL);
    expect(events.some((e) => containsReasoning(e.payload))).toBe(false);
  });

  it('redacts credentials found in tool output', async () => {
    const adapter = adapterOver(FIXTURES);
    const [descriptor] = await adapter.listSessions();
    const events = await adapter.readSession(descriptor!);

    expect(await readFile(FIXTURE_FILE, 'utf8')).toContain(SECRET_SENTINEL);

    expect(JSON.stringify(events)).not.toContain(SECRET_SENTINEL);
  });

  it('resumes from an offset', async () => {
    const adapter = adapterOver(FIXTURES);
    const [descriptor] = await adapter.listSessions();

    const all = await adapter.readSession(descriptor!);
    const cut = all[0]!.source.offset;
    const tail = await adapter.readSession(descriptor!, { fromOffset: cut });

    expect(tail.length).toBeLessThan(all.length);
    expect(tail.every((e) => e.source.offset > cut)).toBe(true);
  });
});

// Covers AE7.
describe('an adapter that cannot distill', () => {
  it('declares no distillation capability', () => {
    expect(new CodexAdapter().capabilities.canDistill).toBe(false);
  });

  it('still ingests and lists sessions', async () => {
    const descriptors = await adapterOver(FIXTURES).listSessions();
    expect(descriptors).toHaveLength(1);
  });

  it('surfaces the limitation through status rather than as an error', async () => {
    const registry = new AdapterRegistry([adapterOver(FIXTURES)]);

    const [status] = await registry.status();

    expect(status?.available).toBe(true);
    expect(status?.canDistill).toBe(false);
    expect(status?.reason).toBeUndefined();
  });
});

describe('availability and refusal', () => {
  it('reports unavailable when there is no session directory', async () => {
    const availability = await adapterOver(join(scratch, 'nope')).isAvailable();

    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('no Codex session directory');
  });

  it('skips a rollout file whose shape is not recognized', async () => {
    const dir = join(scratch, 'sessions', '2026');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'good.jsonl'), await readFile(FIXTURE_FILE, 'utf8'));
    await writeFile(join(dir, 'alien.jsonl'), '{"shape":"unknown","v":1}\n');

    const descriptors = await adapterOver(join(scratch, 'sessions')).listSessions();

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.sessionFile).toContain('good.jsonl');
  });

  it('skips a rollout file with no session metadata', async () => {
    const dir = join(scratch, 'sessions');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'partial.jsonl'), '{"type":"event_msg","payload":{"type":"token_count"}}\n');

    expect(await adapterOver(dir).listSessions()).toEqual([]);
  });

  it('filters sessions by repository', async () => {
    const adapter = adapterOver(FIXTURES);

    expect(await adapter.listSessions({ repoRoot: '/Users/dev/fixture-repo' })).toHaveLength(1);
    expect(await adapter.listSessions({ repoRoot: '/Users/dev/elsewhere' })).toHaveLength(0);
  });
});
