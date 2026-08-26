import { AdapterRegistry, type AdapterCapabilities, type SessionAdapter } from '@backstory/adapters';
import type { MemoryEvent, MemoryRecord, SessionDescriptor } from '@backstory/core';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assessEligibility,
  emptyState,
  isQuiet,
  loadState,
  purgeCache,
  runSweep,
  saveState,
  stateKey,
  type Distiller,
} from '../src/index.js';

const NOW = new Date('2026-08-25T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'backstory-sweep-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

function descriptor(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    sessionId: 'ses-1',
    adapter: 'fake',
    sessionFile: '/tmp/ses-1.jsonl',
    cwd: '/repo',
    branch: 'main',
    lastModified: minutesAgo(60),
    formatVersion: 'fake-v1',
    ...overrides,
  };
}

function eventAt(offset: number, sessionId = 'ses-1'): MemoryEvent {
  return {
    id: `fake:${sessionId}:${offset}`,
    sessionId,
    timestamp: minutesAgo(60),
    type: 'user_prompt',
    actor: { type: 'human', id: 'human:local' },
    payload: { text: `event ${offset}` },
    source: { adapter: 'fake', sessionFile: `/tmp/${sessionId}.jsonl`, offset },
  };
}

function recordFor(sessionId: string, id: string): MemoryRecord {
  return {
    id,
    type: 'discovery',
    sessionId,
    episodeId: null,
    significance: 'technical',
    createdAt: NOW.toISOString(),
    source: {
      adapter: 'fake',
      sessionId,
      sessionFile: `/tmp/${sessionId}.jsonl`,
      fromOffset: 0,
      toOffset: 5,
    },
    text: 'Something worth remembering.',
  };
}

class FakeAdapter implements SessionAdapter {
  readonly capabilities: AdapterCapabilities;
  readSessionCalls: Array<{ sessionId: string; fromOffset: number | undefined }> = [];

  constructor(
    readonly id: string,
    private descriptors: SessionDescriptor[],
    private readonly events: Map<string, MemoryEvent[]>,
    capabilities: Partial<AdapterCapabilities> = {},
    private readonly failOn?: string,
  ) {
    this.capabilities = {
      canDistill: true,
      suppliesRedaction: false,
      supportsHook: true,
      ...capabilities,
    };
  }

  async isAvailable() {
    return { available: true };
  }

  async listSessions(): Promise<SessionDescriptor[]> {
    return this.descriptors;
  }

  async readSession(d: SessionDescriptor, options?: { fromOffset?: number }) {
    this.readSessionCalls.push({ sessionId: d.sessionId, fromOffset: options?.fromOffset });

    if (this.failOn === d.sessionId) throw new Error('session file vanished');

    const all = this.events.get(d.sessionId) ?? [];
    const from = options?.fromOffset ?? -1;
    return all.filter((e) => e.source.offset > from);
  }

  setDescriptors(next: SessionDescriptor[]): void {
    this.descriptors = next;
  }
}

function countingDistiller(): Distiller & { calls: number } {
  const fn = (async ({ descriptor: d, events }) => {
    fn.calls += 1;
    return events.map((e) => recordFor(d.sessionId, `disc-${d.sessionId}-${e.source.offset}`));
  }) as Distiller & { calls: number };
  fn.calls = 0;
  return fn;
}

describe('quiet detection', () => {
  // Covers AE5.
  it('skips a session still being written and takes one that has gone quiet', () => {
    const active = assessEligibility(descriptor({ lastModified: minutesAgo(3) }), emptyState(), {
      quietWindowMinutes: 15,
      now: NOW,
    });
    const quiet = assessEligibility(descriptor({ lastModified: minutesAgo(30) }), emptyState(), {
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(active.eligible).toBe(false);
    expect(active.reason).toBe('still-active');
    expect(quiet.eligible).toBe(true);
  });

  it('treats a session exactly at the quiet window as eligible', () => {
    expect(isQuiet(minutesAgo(15), { quietWindowMinutes: 15, now: NOW })).toBe(true);
    expect(isQuiet(minutesAgo(14), { quietWindowMinutes: 15, now: NOW })).toBe(false);
  });

  it('treats an unparseable timestamp as still active rather than distilling it', () => {
    expect(isQuiet('not a date', { quietWindowMinutes: 15, now: NOW })).toBe(false);
  });

  it('skips a session already distilled with no new content', () => {
    const d = descriptor();
    const state = emptyState();
    state.sessions[stateKey(d.adapter, d.sessionId)] = {
      sessionId: d.sessionId,
      adapter: d.adapter,
      watermark: 10,
      lastSeenModified: d.lastModified,
      lastSweptAt: NOW.toISOString(),
      lastError: null,
      failureCount: 0,
    };

    const assessment = assessEligibility(d, state, { quietWindowMinutes: 15, now: NOW });

    expect(assessment.eligible).toBe(false);
    expect(assessment.reason).toBe('already-distilled');
  });

  it('takes a session again once it has grown since the last sweep', () => {
    const d = descriptor({ lastModified: minutesAgo(20) });
    const state = emptyState();
    state.sessions[stateKey(d.adapter, d.sessionId)] = {
      sessionId: d.sessionId,
      adapter: d.adapter,
      watermark: 10,
      lastSeenModified: minutesAgo(90),
      lastSweptAt: minutesAgo(80),
      lastError: null,
      failureCount: 0,
    };

    expect(assessEligibility(d, state, { quietWindowMinutes: 15, now: NOW }).eligible).toBe(true);
  });

  it('excludes sessions from another repository', () => {
    const assessment = assessEligibility(descriptor({ cwd: '/elsewhere' }), emptyState(), {
      quietWindowMinutes: 15,
      now: NOW,
      repoRoot: '/repo',
    });

    expect(assessment.eligible).toBe(false);
    expect(assessment.reason).toBe('other-repository');
  });

  it('excludes a session with no recorded working directory when filtering by repo', () => {
    const assessment = assessEligibility(descriptor({ cwd: null }), emptyState(), {
      quietWindowMinutes: 15,
      now: NOW,
      repoRoot: '/repo',
    });

    expect(assessment.reason).toBe('no-working-directory');
  });

  it('includes a session in a subdirectory of the repository', () => {
    const assessment = assessEligibility(descriptor({ cwd: '/repo/packages/core' }), emptyState(), {
      quietWindowMinutes: 15,
      now: NOW,
      repoRoot: '/repo',
    });

    expect(assessment.eligible).toBe(true);
  });

  it('stops retrying a session that keeps failing', () => {
    const d = descriptor();
    const state = emptyState();
    state.sessions[stateKey(d.adapter, d.sessionId)] = {
      sessionId: d.sessionId,
      adapter: d.adapter,
      watermark: -1,
      lastSeenModified: minutesAgo(200),
      lastSweptAt: minutesAgo(100),
      lastError: 'model returned invalid JSON',
      failureCount: 3,
    };

    const assessment = assessEligibility(d, state, { quietWindowMinutes: 15, now: NOW });

    expect(assessment.eligible).toBe(false);
    expect(assessment.reason).toBe('repeatedly-failed');
  });
});

describe('running a sweep', () => {
  function setup(options: { capabilities?: Partial<AdapterCapabilities>; failOn?: string } = {}) {
    const events = new Map([['ses-1', [eventAt(0), eventAt(1), eventAt(2)]]]);
    const adapter = new FakeAdapter(
      'fake',
      [descriptor()],
      events,
      options.capabilities,
      options.failOn,
    );
    return { adapter, registry: new AdapterRegistry([adapter]) };
  }

  it('distils a quiet session and returns its records', async () => {
    const { registry } = setup();
    const distill = countingDistiller();

    const result = await runSweep(registry, distill, {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0]?.records).toHaveLength(3);
    expect(result.failures).toEqual([]);
  });

  // Covers AE2, AE6.
  it('produces no new work on a second sweep with nothing changed', async () => {
    const { registry } = setup();
    const distill = countingDistiller();
    const options = { cacheDir, quietWindowMinutes: 15, now: NOW };

    const first = await runSweep(registry, distill, options);
    const second = await runSweep(registry, distill, options);

    expect(first.swept).toHaveLength(1);
    expect(second.swept).toHaveLength(0);
    expect(second.skipped[0]?.reason).toBe('already-distilled');
    expect(distill.calls).toBe(1);
  });

  // Covers AE6.
  it('distils only content past the watermark when a session continues', async () => {
    const events = new Map([['ses-1', [eventAt(0), eventAt(1)]]]);
    const adapter = new FakeAdapter('fake', [descriptor()], events);
    const registry = new AdapterRegistry([adapter]);
    const distill = countingDistiller();

    await runSweep(registry, distill, { cacheDir, quietWindowMinutes: 15, now: NOW });

    // The session grew and went quiet again.
    events.set('ses-1', [eventAt(0), eventAt(1), eventAt(2), eventAt(3)]);
    adapter.setDescriptors([descriptor({ lastModified: minutesAgo(20) })]);

    const second = await runSweep(registry, distill, {
      cacheDir,
      quietWindowMinutes: 15,
      now: new Date(NOW.getTime() + 60_000),
    });

    expect(second.swept[0]?.eventCount).toBe(2);
    expect(second.swept[0]?.records.map((r) => r.id)).toEqual([
      'disc-ses-1-2',
      'disc-ses-1-3',
    ]);
    expect(adapter.readSessionCalls.at(-1)?.fromOffset).toBe(1);
  });

  // Covers AE7.
  it('reads and marks undistilled for an adapter that cannot distil', async () => {
    const { registry } = setup({ capabilities: { canDistill: false } });
    const distill = countingDistiller();

    const result = await runSweep(registry, distill, {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(result.swept[0]?.undistilled).toBe(true);
    expect(result.swept[0]?.eventCount).toBe(3);
    expect(result.swept[0]?.records).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(distill.calls).toBe(0);
  });

  it('does not re-read an undistillable session on every sweep', async () => {
    const { adapter, registry } = setup({ capabilities: { canDistill: false } });
    const distill = countingDistiller();
    const options = { cacheDir, quietWindowMinutes: 15, now: NOW };

    await runSweep(registry, distill, options);
    await runSweep(registry, distill, options);

    expect(adapter.readSessionCalls).toHaveLength(1);
  });

  // Covers AE9.
  it('reports a failing session and leaves other sessions unaffected', async () => {
    const events = new Map([
      ['ses-bad', [eventAt(0, 'ses-bad')]],
      ['ses-good', [eventAt(0, 'ses-good')]],
    ]);
    const adapter = new FakeAdapter(
      'fake',
      [
        descriptor({ sessionId: 'ses-bad' }),
        descriptor({ sessionId: 'ses-good', lastModified: minutesAgo(45) }),
      ],
      events,
      {},
      'ses-bad',
    );
    const registry = new AdapterRegistry([adapter]);

    const result = await runSweep(registry, countingDistiller(), {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.sessionId).toBe('ses-bad');
    expect(result.swept.map((s) => s.sessionId)).toEqual(['ses-good']);
  });

  it('never throws when the distiller itself fails', async () => {
    const { registry } = setup();
    const exploding: Distiller = async () => {
      throw new Error('model returned invalid JSON');
    };

    const result = await runSweep(registry, exploding, {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(result.failures[0]?.reason).toContain('invalid JSON');
    expect(result.swept).toEqual([]);
  });

  it('retries a failed session rather than advancing past it', async () => {
    const { registry } = setup();
    const exploding: Distiller = async () => {
      throw new Error('transient');
    };
    const options = { cacheDir, quietWindowMinutes: 15, now: NOW };

    await runSweep(registry, exploding, options);
    const state = await loadState(cacheDir);

    expect(state.sessions['fake:ses-1']?.watermark).toBe(-1);
    expect(state.sessions['fake:ses-1']?.failureCount).toBe(1);
    expect(state.sessions['fake:ses-1']?.lastError).toContain('transient');
  });

  it('treats a distiller returning null as undistilled rather than failed', async () => {
    const { registry } = setup();
    const declines: Distiller = async () => null;

    const result = await runSweep(registry, declines, {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(result.swept[0]?.undistilled).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('caps work per invocation and reports what was deferred', async () => {
    const events = new Map<string, MemoryEvent[]>(
      ['a', 'b', 'c'].map((id) => [`ses-${id}`, [eventAt(0, `ses-${id}`)]]),
    );
    const adapter = new FakeAdapter(
      'fake',
      ['a', 'b', 'c'].map((id) => descriptor({ sessionId: `ses-${id}` })),
      events,
    );

    const result = await runSweep(new AdapterRegistry([adapter]), countingDistiller(), {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
      maxSessions: 2,
    });

    expect(result.swept).toHaveLength(2);
    expect(result.deferred).toBe(1);
  });

  it('skips every session when none has gone quiet', async () => {
    const events = new Map([['ses-1', [eventAt(0)]]]);
    const adapter = new FakeAdapter('fake', [descriptor({ lastModified: minutesAgo(2) })], events);

    const result = await runSweep(new AdapterRegistry([adapter]), countingDistiller(), {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(result.swept).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('still-active');
  });
});

describe('sweep state', () => {
  it('round-trips through disk', async () => {
    const state = emptyState();
    state.sessions['fake:ses-1'] = {
      sessionId: 'ses-1',
      adapter: 'fake',
      watermark: 7,
      lastSeenModified: minutesAgo(30),
      lastSweptAt: NOW.toISOString(),
      lastError: null,
      failureCount: 0,
    };

    await saveState(cacheDir, state);

    expect(await loadState(cacheDir)).toEqual(state);
  });

  it('falls back to empty state when the file is corrupt', async () => {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, 'sweep-state.json'), '{ not json', 'utf8');

    expect(await loadState(cacheDir)).toEqual(emptyState());
  });

  it('falls back to empty state when the file has an unexpected shape', async () => {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, 'sweep-state.json'), '{"version":99}', 'utf8');

    expect(await loadState(cacheDir)).toEqual(emptyState());
  });

  it('returns empty state when nothing has been written yet', async () => {
    expect(await loadState(join(cacheDir, 'fresh'))).toEqual(emptyState());
  });

  it('namespaces session ids by adapter so two agents cannot collide', () => {
    expect(stateKey('claude-code', 'abc')).not.toBe(stateKey('codex', 'abc'));
  });
});

describe('cache retention', () => {
  it('purges cached events past the retention window and keeps newer ones', async () => {
    const eventsDir = join(cacheDir, 'events');
    await mkdir(eventsDir, { recursive: true });

    const old = join(eventsDir, 'old.json');
    const recent = join(eventsDir, 'recent.json');
    await writeFile(old, '[]', 'utf8');
    await writeFile(recent, '[]', 'utf8');

    const longAgo = new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000);
    await utimes(old, longAgo, longAgo);

    const result = await purgeCache(cacheDir, 30, NOW);

    expect(result.purged).toBe(1);
    expect(result.kept).toBe(1);
  });

  it('does nothing when there is no cache yet', async () => {
    expect(await purgeCache(join(cacheDir, 'absent'), 30, NOW)).toEqual({ purged: 0, kept: 0 });
  });
});
