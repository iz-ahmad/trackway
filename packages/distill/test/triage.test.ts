import type { MemoryRecord } from '@trackway/core';
import { describe, expect, it } from 'vitest';
import { buildTriagePrompt, triageDiscoveries, type DistillRunner } from '../src/index.js';

function discovery(id: string, text: string, significance = 'technical' as const): MemoryRecord {
  return {
    id,
    type: 'discovery',
    sessionId: 'ses-1',
    episodeId: null,
    commits: [],
    significance,
    createdAt: '2026-08-26T09:00:00Z',
    source: {
      adapter: 'claude-code',
      sessionId: 'ses-1',
      sessionFile: '/tmp/a.jsonl',
      fromOffset: 0,
      toOffset: 4,
    },
    text,
  };
}

function stub(output: string): DistillRunner {
  return {
    id: 'stub',
    async isAvailable() {
      return { available: true };
    },
    async run() {
      return output;
    },
  };
}

const outside = discovery('d-1', 'OpenCode moved its storage to SQLite and its CLI needs a terminal.');
const ownCode = discovery('d-2', 'Our identity hash included mutable fields, so superseding changed the id.');

describe('separating facts about the world from notes about our own code', () => {
  it('demotes a fact about this project’s own code', async () => {
    const result = await triageDiscoveries(stub('{"own":[1]}'), [outside, ownCode]);

    expect(result.find((r) => r.id === 'd-2')?.significance).toBe('working');
  });

  it('leaves a fact about something outside alone', async () => {
    const result = await triageDiscoveries(stub('{"own":[1]}'), [outside, ownCode]);

    expect(result.find((r) => r.id === 'd-1')?.significance).toBe('technical');
  });

  it('never touches records that are not discoveries', async () => {
    const action: MemoryRecord = {
      ...discovery('a-1', 'x'),
      id: 'a-1',
      type: 'action',
      description: 'Added the job.',
      status: 'completed',
      files: [],
    } as unknown as MemoryRecord;

    const result = await triageDiscoveries(stub('{"own":[0]}'), [action, ownCode]);

    expect(result.find((r) => r.id === 'a-1')?.significance).toBe('technical');
  });

  it('ignores an index the model invented', async () => {
    // A bad answer may leave records visible; it may never hide ones it did
    // not actually judge.
    const result = await triageDiscoveries(stub('{"own":[0,99]}'), [outside, ownCode]);

    expect(result.find((r) => r.id === 'd-2')?.significance).toBe('technical');
  });

  it('keeps everything when the answer is unusable', async () => {
    const result = await triageDiscoveries(stub('I am not sure.'), [outside, ownCode]);

    expect(result.map((r) => r.significance)).toEqual(['technical', 'technical']);
  });

  it('keeps everything when the answer has the wrong shape', async () => {
    const result = await triageDiscoveries(stub('{"verdicts":["own"]}'), [outside, ownCode]);

    expect(result.map((r) => r.significance)).toEqual(['technical', 'technical']);
  });

  it('does not call the model when there are no discoveries', async () => {
    let called = false;
    const runner: DistillRunner = {
      id: 'stub',
      async isAvailable() {
        return { available: true };
      },
      async run() {
        called = true;
        return '{"own":[]}';
      },
    };

    await triageDiscoveries(runner, []);
    expect(called).toBe(false);
  });

  it('asks one question and nothing else', () => {
    const prompt = buildTriagePrompt([outside, ownCode]);

    // The same rule inside the larger classification prompt was ignored twice.
    expect(prompt).toContain('Your only job');
    expect(prompt).toContain('rebuilt differently');
    expect(prompt).not.toContain('episode');
    expect(prompt).not.toContain('business');
  });
});
