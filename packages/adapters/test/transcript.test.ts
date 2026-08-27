import { describe, expect, it } from 'vitest';
import { InvalidTranscriptError, parseTranscript } from '../src/index.js';

const base = {
  agent: 'cursor',
  sessionId: 'chat-1',
  startedAt: '2026-08-27T10:00:00Z',
};

describe('reading a piped transcript', () => {
  it('turns a conversation into the events every adapter emits', () => {
    const { events } = parseTranscript({
      ...base,
      entries: [
        { role: 'user', text: 'Make the retry exponential.' },
        { role: 'assistant', text: 'Rewrote the backoff.' },
      ],
    });

    expect(events.map((e) => e.type)).toEqual(['user_prompt', 'agent_message']);
  });

  it('splits a tool entry into the call and the result it answers', () => {
    const { events } = parseTranscript({
      ...base,
      entries: [{ role: 'tool', name: 'Edit', input: { path: 'a.ts' }, output: 'done' }],
    });

    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result']);
  });

  it('pairs the result to its own call, so a fork can be read back', () => {
    const { events } = parseTranscript({
      ...base,
      entries: [{ role: 'tool', name: 'Edit', input: {}, output: 'done' }],
    });

    const call = events[0]?.payload as { message: { content: [{ id: string }] } };
    const result = events[1]?.payload as { message: { content: [{ tool_use_id: string }] } };
    expect(result.message.content[0].tool_use_id).toBe(call.message.content[0].id);
  });

  it('emits no result event for a call that returned nothing', () => {
    const { events } = parseTranscript({
      ...base,
      entries: [{ role: 'tool', name: 'Edit', input: {} }],
    });

    expect(events).toHaveLength(1);
  });

  it('redacts credentials, because a pipe is no more trusted than a file', () => {
    const { events } = parseTranscript({
      ...base,
      entries: [{ role: 'user', text: 'use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 for now' }],
    });

    expect(JSON.stringify(events)).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
  });

  it('carries entries with no time of their own on the last one seen', () => {
    const { events } = parseTranscript({
      ...base,
      entries: [
        { role: 'user', text: 'first', at: '2026-08-27T11:00:00Z' },
        { role: 'assistant', text: 'second' },
      ],
    });

    expect(events[1]?.timestamp).toBe('2026-08-27T11:00:00Z');
  });

  it('numbers offsets in order, because watermarks and IDs depend on it', () => {
    const { events } = parseTranscript({
      ...base,
      entries: [
        { role: 'user', text: 'a' },
        { role: 'tool', name: 'Edit', input: {}, output: 'ok' },
        { role: 'assistant', text: 'b' },
      ],
    });

    expect(events.map((e) => e.source.offset)).toEqual([0, 1, 2, 3]);
  });

  it('names the agent that produced it on every agent event', () => {
    const { events } = parseTranscript({
      ...base,
      entries: [{ role: 'assistant', text: 'done' }],
    });

    expect(events[0]?.actor).toEqual({ type: 'agent', id: 'agent:cursor' });
  });

  it('describes the session it came from', () => {
    const { descriptor } = parseTranscript({ ...base, cwd: '/repo', entries: [{ role: 'user', text: 'hi' }] });

    expect(descriptor).toMatchObject({ sessionId: 'chat-1', adapter: 'transcript', cwd: '/repo' });
  });

  it('refuses a malformed transcript with the field that is wrong', () => {
    expect(() => parseTranscript({ ...base, entries: [{ role: 'user' }] })).toThrow(
      InvalidTranscriptError,
    );
  });

  it('refuses an empty transcript rather than recording an empty session', () => {
    expect(() => parseTranscript({ ...base, entries: [] })).toThrow(InvalidTranscriptError);
  });

  it('refuses an unknown role instead of guessing at it', () => {
    expect(() => parseTranscript({ ...base, entries: [{ role: 'system', text: 'x' }] })).toThrow(
      InvalidTranscriptError,
    );
  });
});

describe('a fork recorded in a transcript', () => {
  const fork = {
    ...base,
    entries: [
      {
        role: 'tool' as const,
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which cache should we use?',
              options: [
                { label: 'Redis', description: 'Already deployed here.' },
                { label: 'Postgres unlogged', description: 'Higher latency for this workload.' },
              ],
            },
          ],
        },
        output: 'The user answered: "Which cache should we use?"="Redis"',
      },
    ],
  };

  it('shapes the events so the deterministic harvester can read them', async () => {
    // The point of documenting the tool shape: an adapter that emits an option
    // list this way gets the accurate path, not the model-extracted one.
    const { harvestForks } = await import('@trackway/distill');
    const { events } = parseTranscript(fork);

    const [harvested] = harvestForks(events);

    expect(harvested?.question).toBe('Which cache should we use?');
    expect(harvested?.outcome).toEqual({ kind: 'chosen', label: 'Redis' });
  });

  it('keeps every option and its own reasoning', async () => {
    const { harvestForks } = await import('@trackway/distill');
    const { events } = parseTranscript(fork);

    expect(harvestForks(events)[0]?.options).toEqual([
      { label: 'Redis', reason: 'Already deployed here.' },
      { label: 'Postgres unlogged', reason: 'Higher latency for this workload.' },
    ]);
  });
});
