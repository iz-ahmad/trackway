import type { MemoryEvent, SessionDescriptor } from '@backstory/core';
import { MemoryEvent as MemoryEventSchema } from '@backstory/core';
import { describe, expect, it } from 'vitest';
import {
  AdapterRegistry,
  UnknownFormatError,
  type AdapterAvailability,
  type AdapterCapabilities,
  type SessionAdapter,
} from '../src/index.js';

function descriptor(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    sessionId: 'ses-1',
    adapter: 'fake',
    sessionFile: '/tmp/ses-1.jsonl',
    cwd: '/repo',
    branch: 'main',
    lastModified: '2026-08-25T09:00:00Z',
    formatVersion: 'fake-v1',
    ...overrides,
  };
}

function event(sessionId: string, adapter: string): MemoryEvent {
  return {
    id: `${adapter}-evt-1`,
    sessionId,
    timestamp: '2026-08-25T09:00:00Z',
    type: 'user_prompt',
    actor: { type: 'human', id: 'human:7a91' },
    payload: { text: 'hello' },
    source: { adapter, sessionFile: '/tmp/x.jsonl', offset: 0 },
  };
}

/** Stands in for Claude Code and Codex: reads files off disk. */
class FileBackedAdapter implements SessionAdapter {
  readonly capabilities: AdapterCapabilities;

  constructor(
    readonly id: string,
    private readonly available: AdapterAvailability = { available: true },
    capabilities: Partial<AdapterCapabilities> = {},
  ) {
    this.capabilities = {
      canDistill: true,
      suppliesRedaction: false,
      supportsHook: true,
      ...capabilities,
    };
  }

  async isAvailable(): Promise<AdapterAvailability> {
    return this.available;
  }

  async listSessions(): Promise<SessionDescriptor[]> {
    return [descriptor({ adapter: this.id, sessionId: `${this.id}-ses` })];
  }

  async readSession(d: SessionDescriptor): Promise<MemoryEvent[]> {
    return [event(d.sessionId, this.id)];
  }
}

/** Stands in for OpenCode: shells out to the agent's own commands. */
class CliBackedAdapter implements SessionAdapter {
  readonly capabilities: AdapterCapabilities = {
    canDistill: true,
    suppliesRedaction: true,
    supportsHook: false,
  };

  readonly id = 'cli-backed';
  private readonly binaryPresent: boolean;

  constructor(binaryPresent = true) {
    this.binaryPresent = binaryPresent;
  }

  async isAvailable(): Promise<AdapterAvailability> {
    return this.binaryPresent
      ? { available: true }
      : { available: false, reason: 'binary not found on PATH' };
  }

  async listSessions(): Promise<SessionDescriptor[]> {
    return [descriptor({ adapter: this.id, sessionId: 'cli-ses' })];
  }

  async readSession(d: SessionDescriptor): Promise<MemoryEvent[]> {
    return [event(d.sessionId, this.id)];
  }
}

describe('one contract over two backing strategies', () => {
  it('lets a caller written against the contract run over either', async () => {
    const results: string[] = [];

    for (const adapter of [new FileBackedAdapter('file-backed'), new CliBackedAdapter()]) {
      for (const d of await adapter.listSessions()) {
        const events = await adapter.readSession(d);
        results.push(...events.map((e) => e.sessionId));
      }
    }

    expect(results).toEqual(['file-backed-ses', 'cli-ses']);
  });

  it('produces events that validate against the shared schema from both', async () => {
    for (const adapter of [new FileBackedAdapter('file-backed'), new CliBackedAdapter()]) {
      const [d] = await adapter.listSessions();
      const events = await adapter.readSession(d!);

      for (const e of events) {
        expect(() => MemoryEventSchema.parse(e)).not.toThrow();
      }
    }
  });
});

describe('registry', () => {
  it('skips an adapter reporting unavailable without raising', async () => {
    const registry = new AdapterRegistry([
      new FileBackedAdapter('present'),
      new CliBackedAdapter(false),
    ]);

    const available = await registry.available();

    expect(available.map((a) => a.id)).toEqual(['present']);
  });

  it('reports why an adapter is unavailable', async () => {
    const registry = new AdapterRegistry([new CliBackedAdapter(false)]);

    const [status] = await registry.status();

    expect(status?.available).toBe(false);
    expect(status?.reason).toContain('binary not found');
  });

  it('reports whether each adapter can distill', async () => {
    const registry = new AdapterRegistry([
      new FileBackedAdapter('can-distill'),
      new FileBackedAdapter('cannot-distill', { available: true }, { canDistill: false }),
    ]);

    const status = await registry.status();

    expect(status.find((s) => s.id === 'can-distill')?.canDistill).toBe(true);
    expect(status.find((s) => s.id === 'cannot-distill')?.canDistill).toBe(false);
  });

  it('returns adapters in a deterministic order regardless of registration order', async () => {
    const forward = new AdapterRegistry([
      new FileBackedAdapter('zulu'),
      new FileBackedAdapter('alpha'),
    ]);
    const reverse = new AdapterRegistry([
      new FileBackedAdapter('alpha'),
      new FileBackedAdapter('zulu'),
    ]);

    expect(forward.all().map((a) => a.id)).toEqual(reverse.all().map((a) => a.id));
    expect(forward.all().map((a) => a.id)).toEqual(['alpha', 'zulu']);
  });

  it('keeps listing when one adapter throws while listing', async () => {
    class BrokenAdapter extends FileBackedAdapter {
      override async listSessions(): Promise<SessionDescriptor[]> {
        throw new Error('corrupt install');
      }
    }

    const registry = new AdapterRegistry([new BrokenAdapter('broken'), new FileBackedAdapter('ok')]);

    const sessions = await registry.listAllSessions();

    expect(sessions.map((s) => s.descriptor.adapter)).toEqual(['ok']);
  });

  it('treats an availability check that throws as unavailable', async () => {
    class ExplodingAdapter extends FileBackedAdapter {
      override async isAvailable(): Promise<AdapterAvailability> {
        throw new Error('permission denied reading home directory');
      }
    }

    const registry = new AdapterRegistry([new ExplodingAdapter('exploding')]);

    const [status] = await registry.status();
    expect(status?.available).toBe(false);
    expect(status?.reason).toContain('permission denied');
  });

  it('orders discovered sessions with the most recent first', async () => {
    class DatedAdapter extends FileBackedAdapter {
      constructor(
        id: string,
        private readonly at: string,
      ) {
        super(id);
      }

      override async listSessions(): Promise<SessionDescriptor[]> {
        return [descriptor({ adapter: this.id, sessionId: this.id, lastModified: this.at })];
      }
    }

    const registry = new AdapterRegistry([
      new DatedAdapter('older', '2026-08-20T09:00:00Z'),
      new DatedAdapter('newer', '2026-08-25T09:00:00Z'),
    ]);

    const sessions = await registry.listAllSessions();

    expect(sessions.map((s) => s.descriptor.sessionId)).toEqual(['newer', 'older']);
  });

  it('finds an adapter by id', () => {
    const registry = new AdapterRegistry([new FileBackedAdapter('claude-code')]);

    expect(registry.get('claude-code')?.id).toBe('claude-code');
    expect(registry.get('missing')).toBeUndefined();
  });
});

describe('UnknownFormatError', () => {
  it('names the adapter, the file, and what was wrong', () => {
    const error = new UnknownFormatError('claude-code', '/tmp/a.jsonl', 'missing sessionId field');

    expect(error.message).toContain('claude-code');
    expect(error.message).toContain('/tmp/a.jsonl');
    expect(error.message).toContain('missing sessionId');
  });
});
