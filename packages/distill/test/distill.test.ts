import { withDerivedId, type MemoryEvent, type SessionDescriptor } from '@backstory/core';
import { describe, expect, it } from 'vitest';
import {
  ClaudeDistillRunner,
  EXTRACTION_INSTRUCTIONS,
  InvalidDistillationError,
  RunnerError,
  buildPrompt,
  chunkEvents,
  collapseNearDuplicates,
  createDistiller,
  extractJsonObject,
  renderTranscript,
  toRecords,
  type DistillRunner,
} from '../src/index.js';

const provenance = {
  sessionId: 'ses-1',
  adapter: 'claude-code',
  sessionFile: '/tmp/ses-1.jsonl',
  fromOffset: 0,
  toOffset: 12,
  createdAt: '2026-08-25T09:18:00Z',
};

const wellFormed = {
  questions: [
    {
      question: 'Should cancellation be asynchronous?',
      answer: 'Yes, callbacks are slow.',
      status: 'resolved',
      actor: { type: 'human', id: 'human:local' },
    },
  ],
  discoveries: [{ text: 'Webhook delivery is not idempotent.' }],
  decisions: [
    {
      question: 'Which cache?',
      choice: 'Redis',
      reason: 'Already deployed here.',
      alternatives: [
        {
          choice: 'PostgreSQL',
          status: 'rejected',
          reason: 'Another service to run.',
          condition: 'PostgreSQL is not deployed in this project',
        },
      ],
      attribution: {
        proposedBy: { type: 'agent', id: 'agent:claude-code' },
        acceptedBy: { type: 'human', id: 'human:local' },
      },
    },
  ],
  actions: [{ description: 'Added the queue job.', status: 'completed', files: ['src/job.ts'] }],
  outcomes: [{ text: 'Tests passed.', result: 'passed' }],
};

function stubRunner(output: string | (() => Promise<string>)): DistillRunner {
  return {
    id: 'stub',
    async isAvailable() {
      return { available: true };
    },
    async run() {
      return typeof output === 'string' ? output : output();
    },
  };
}

function eventAt(offset: number, text: string): MemoryEvent {
  return {
    id: `e-${offset}`,
    sessionId: 'ses-1',
    timestamp: '2026-08-25T09:18:00Z',
    type: offset % 2 === 0 ? 'user_prompt' : 'agent_message',
    actor: offset % 2 === 0 ? { type: 'human', id: 'human:local' } : { type: 'agent', id: 'agent:claude-code' },
    payload: { content: [{ type: 'text', text }] },
    source: { adapter: 'claude-code', sessionFile: '/tmp/ses-1.jsonl', offset },
  };
}

const descriptor: SessionDescriptor = {
  sessionId: 'ses-1',
  adapter: 'claude-code',
  sessionFile: '/tmp/ses-1.jsonl',
  cwd: '/repo',
  branch: 'main',
  lastModified: '2026-08-25T09:00:00Z',
  formatVersion: 'claude-code/jsonl-v1',
};

describe('validating model output', () => {
  it('turns well-formed output into records of every type', () => {
    const records = toRecords(JSON.stringify(wellFormed), provenance);

    expect(records.map((r) => r.type).sort()).toEqual([
      'action',
      'decision',
      'discovery',
      'outcome',
      'question',
    ]);
  });

  it('fills in provenance the model was never asked for', () => {
    const [record] = toRecords(JSON.stringify(wellFormed), provenance);

    expect(record?.source).toEqual({
      adapter: 'claude-code',
      sessionId: 'ses-1',
      sessionFile: '/tmp/ses-1.jsonl',
      fromOffset: 0,
      toOffset: 12,
    });
    expect(record?.id).toMatch(/^q-\d{8}-[0-9a-f]{8}$/);
  });

  it('preserves rejected alternatives and their conditions', () => {
    const decision = toRecords(JSON.stringify(wellFormed), provenance).find(
      (r) => r.type === 'decision',
    );

    expect(decision?.type === 'decision' && decision.alternatives[0]).toMatchObject({
      choice: 'PostgreSQL',
      status: 'rejected',
      condition: 'PostgreSQL is not deployed in this project',
    });
  });

  it('records an implicit acceptance without inventing a human approval', () => {
    const output = {
      ...wellFormed,
      decisions: [
        {
          ...wellFormed.decisions[0],
          attribution: {
            proposedBy: { type: 'agent', id: 'agent:claude-code' },
            acceptedBy: 'implicit',
          },
        },
      ],
    };

    const decision = toRecords(JSON.stringify(output), provenance).find(
      (r) => r.type === 'decision',
    );

    expect(decision?.type === 'decision' && decision.attribution.acceptedBy).toBe('implicit');
  });

  it('accepts a response where every array is empty', () => {
    const records = toRecords(
      JSON.stringify({ questions: [], discoveries: [], decisions: [], actions: [], outcomes: [] }),
      provenance,
    );

    expect(records).toEqual([]);
  });

  it('accepts a response that omits arrays entirely', () => {
    expect(toRecords(JSON.stringify({ discoveries: [{ text: 'A finding.' }] }), provenance)).toHaveLength(1);
  });

  it('recovers JSON wrapped in a markdown fence', () => {
    const wrapped = '```json\n' + JSON.stringify(wellFormed) + '\n```';

    expect(toRecords(wrapped, provenance).length).toBeGreaterThan(0);
  });

  it('recovers JSON preceded by prose', () => {
    const chatty = `Here is the extracted memory:\n\n${JSON.stringify(wellFormed)}`;

    expect(toRecords(chatty, provenance).length).toBeGreaterThan(0);
  });

  it('rejects output that is not JSON at all', () => {
    expect(() => toRecords('I could not find anything useful.', provenance)).toThrow(
      InvalidDistillationError,
    );
  });

  it('rejects the whole batch when one record violates the schema', () => {
    const broken = {
      ...wellFormed,
      discoveries: [{ text: 'fine' }, { text: '' }],
    };

    expect(() => toRecords(JSON.stringify(broken), provenance)).toThrow(InvalidDistillationError);
  });

  it('rejects a record carrying a field the schema does not define', () => {
    const extra = {
      discoveries: [{ text: 'A finding.', confidence: 0.9 }],
    };

    expect(() => toRecords(JSON.stringify(extra), provenance)).toThrow(InvalidDistillationError);
  });

  it('rejects an invented decision status rather than coercing it', () => {
    const invented = {
      decisions: [
        {
          ...wellFormed.decisions[0],
          alternatives: [
            { choice: 'X', status: 'maybe-later', reason: 'unclear', condition: null },
          ],
        },
      ],
    };

    expect(() => toRecords(JSON.stringify(invented), provenance)).toThrow(InvalidDistillationError);
  });

  it('names what was wrong so a failure can be diagnosed', () => {
    try {
      toRecords(JSON.stringify({ discoveries: [{}] }), provenance);
      expect.unreachable('should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidDistillationError);
      expect((error as InvalidDistillationError).detail).toContain('text');
    }
  });

  it('extracts an object from surrounding noise', () => {
    expect(extractJsonObject('prefix {"a":1} suffix')).toEqual({ a: 1 });
  });

  it('reports when no object can be found', () => {
    expect(() => extractJsonObject('no braces here')).toThrow(InvalidDistillationError);
  });
});

describe('the extraction prompt', () => {
  it('tells the model that empty output is a valid answer', () => {
    expect(EXTRACTION_INSTRUCTIONS).toContain('empty array is the correct answer');
  });

  it('tells the model never to invent a human approval', () => {
    expect(EXTRACTION_INSTRUCTIONS).toContain('implicit');
    expect(EXTRACTION_INSTRUCTIONS).toContain('Never record a human acceptance that did not');
  });

  it('asks for the condition behind a rejection', () => {
    expect(EXTRACTION_INSTRUCTIONS).toContain('condition');
  });

  it('renders events with speaker labels', () => {
    const transcript = renderTranscript([eventAt(0, 'Should we cache this?'), eventAt(1, 'Yes.')]);

    expect(transcript).toContain('DEVELOPER');
    expect(transcript).toContain('AGENT');
    expect(transcript).toContain('Should we cache this?');
  });

  it('truncates a very long event rather than sending all of it', () => {
    const transcript = renderTranscript([eventAt(0, 'x'.repeat(50_000))]);

    expect(transcript).toContain('(truncated)');
    expect(transcript.length).toBeLessThan(5_000);
  });

  it('describes an event with no text rather than emitting nothing', () => {
    const empty: MemoryEvent = { ...eventAt(0, ''), payload: { content: [] } };

    expect(renderTranscript([empty])).toContain('(no text content)');
  });

  it('includes the transcript and the instructions in the built prompt', () => {
    const prompt = buildPrompt({ events: [eventAt(0, 'hello')], adapterId: 'claude-code' });

    expect(prompt).toContain('SESSION TRANSCRIPT');
    expect(prompt).toContain('hello');
    expect(prompt).toContain('Return the JSON object now.');
  });
});

describe('the distiller', () => {
  it('returns records for a region with events', async () => {
    const distill = createDistiller({ runner: stubRunner(JSON.stringify(wellFormed)) });

    const records = await distill({
      descriptor,
      events: [eventAt(0, 'a'), eventAt(1, 'b')],
      fromOffset: -1,
    });

    expect(records).toHaveLength(5);
  });

  it('declines rather than calling the model for an empty region', async () => {
    let called = false;
    const runner: DistillRunner = {
      id: 'stub',
      async isAvailable() {
        return { available: true };
      },
      async run() {
        called = true;
        return '{}';
      },
    };

    const result = await createDistiller({ runner })({ descriptor, events: [], fromOffset: -1 });

    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it('records the offset range the chunk actually covered', async () => {
    const distill = createDistiller({ runner: stubRunner(JSON.stringify(wellFormed)) });

    const records = await distill({
      descriptor,
      events: [eventAt(4, 'a'), eventAt(9, 'b')],
      fromOffset: 3,
    });

    // Provenance points at the events that produced the record, not at where
    // the sweep happened to resume from.
    expect(records?.[0]?.source).toMatchObject({ fromOffset: 4, toOffset: 9 });
  });

  it('propagates a validation failure so the sweep can mark the session failed', async () => {
    const distill = createDistiller({ runner: stubRunner('not json') });

    await expect(
      distill({ descriptor, events: [eventAt(0, 'a')], fromOffset: -1 }),
    ).rejects.toThrow(InvalidDistillationError);
  });

  it('propagates a runner failure', async () => {
    const failing: DistillRunner = {
      id: 'stub',
      async isAvailable() {
        return { available: true };
      },
      async run() {
        throw new RunnerError('stub', 'timeout', 'timed out after 1ms');
      },
    };

    await expect(
      createDistiller({ runner: failing })({ descriptor, events: [eventAt(0, 'a')], fromOffset: -1 }),
    ).rejects.toThrow(RunnerError);
  });
});

describe('the Claude runner', () => {
  it('reports unavailable when the binary does not exist', async () => {
    const runner = new ClaudeDistillRunner({ binary: 'definitely-not-a-real-binary-xyz' });

    const availability = await runner.isAvailable();

    expect(availability.available).toBe(false);
  });

  it('fails rather than hanging when a command never returns', async () => {
    const runner = new ClaudeDistillRunner({ binary: 'sleep', timeoutMs: 150 });

    await expect(runner.run('30')).rejects.toThrow(RunnerError);
  });

  it('reports a non-zero exit as a runner error', async () => {
    const runner = new ClaudeDistillRunner({ binary: 'false' });

    await expect(runner.run('anything')).rejects.toThrow(RunnerError);
  });

  it('needs no API key to construct', () => {
    const before = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];

    expect(() => new ClaudeDistillRunner()).not.toThrow();

    if (before !== undefined) process.env['ANTHROPIC_API_KEY'] = before;
  });
});

describe('chunking a long session', () => {
  function eventsN(n: number): MemoryEvent[] {
    return Array.from({ length: n }, (_, i) => eventAt(i, `turn ${i}`));
  }

  it('keeps a short session as one chunk', () => {
    const chunks = chunkEvents(eventsN(20), { chunkSize: 120 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.events).toHaveLength(20);
  });

  it('splits a long session rather than dropping its tail', () => {
    // Truncating was the first approach and it silently lost most of a long
    // session, which read as complete output.
    const chunks = chunkEvents(eventsN(500), { chunkSize: 120, overlap: 12 });

    expect(chunks.length).toBeGreaterThan(1);

    const covered = new Set(chunks.flatMap((c) => c.events.map((e) => e.source.offset)));
    expect(covered.size).toBe(500);
  });

  it('overlaps chunks so a question and its answer are not split apart', () => {
    const chunks = chunkEvents(eventsN(300), { chunkSize: 100, overlap: 10 });

    const first = chunks[0]!.events.map((e) => e.source.offset);
    const second = chunks[1]!.events.map((e) => e.source.offset);

    expect(second[0]).toBeLessThan(first[first.length - 1]!);
  });

  it('records the offset range each chunk covers', () => {
    const chunks = chunkEvents(eventsN(300), { chunkSize: 100, overlap: 0 });

    expect(chunks[0]?.fromOffset).toBe(0);
    expect(chunks[0]?.toOffset).toBe(99);
    expect(chunks.at(-1)?.toOffset).toBe(299);
  });

  it('handles an empty session', () => {
    expect(chunkEvents([])).toEqual([]);
  });

  it('distils every chunk of a long session', async () => {
    let calls = 0;
    const runner: DistillRunner = {
      id: 'stub',
      async isAvailable() {
        return { available: true };
      },
      async run() {
        calls += 1;
        // Genuinely different subjects. Texts differing only by a digit would
        // collapse, correctly, since a digit is not a content word.
        const subjects = [
          'the queue worker never starts under mocked services',
          'pagination breaks past the tenth page of results',
          'webhook delivery fires twice for a single event',
          'the migration lock is held across an entire deploy',
          'image uploads bypass the virus scanner entirely',
          'session cookies are issued without a secure flag',
          'the search index rebuild blocks all writes',
          'retry backoff resets on every transient failure',
        ];
        return JSON.stringify({
          discoveries: [{ text: subjects[calls % subjects.length] ?? `finding ${calls}` }],
        });
      },
    };

    const records = await createDistiller({ runner, chunkSize: 50 })({
      descriptor,
      events: eventsN(400),
      fromOffset: -1,
    });

    expect(calls).toBeGreaterThan(1);
    expect(records!.length).toBeGreaterThan(1);
  });

  it('collapses a decision that appears in two overlapping chunks', async () => {
    const runner: DistillRunner = {
      id: 'stub',
      async isAvailable() {
        return { available: true };
      },
      // Every chunk reports the same discovery, as an overlap would produce.
      async run() {
        return JSON.stringify({ discoveries: [{ text: 'the same finding every time' }] });
      },
    };

    const records = await createDistiller({ runner, chunkSize: 50 })({
      descriptor,
      events: eventsN(400),
      fromOffset: -1,
    });

    // Identity is content-derived, so duplicates collapse without comparison.
    const ids = new Set(records!.map((r) => r.id));
    expect(ids.size).toBe(records!.length);
  });

  it('keeps the records from chunks that worked when one chunk fails', async () => {
    let call = 0;
    const runner: DistillRunner = {
      id: 'stub',
      async isAvailable() {
        return { available: true };
      },
      async run() {
        call += 1;
        if (call === 2) throw new Error('rate limited');
        return JSON.stringify({ discoveries: [{ text: `finding ${call}` }] });
      },
    };

    const records = await createDistiller({ runner, chunkSize: 50 })({
      descriptor,
      events: eventsN(300),
      fromOffset: -1,
    });

    expect(records!.length).toBeGreaterThan(0);
  });

  it('fails the session only when every chunk fails', async () => {
    const runner: DistillRunner = {
      id: 'stub',
      async isAvailable() {
        return { available: true };
      },
      async run() {
        throw new RunnerError('stub', 'exit', 'rate limited');
      },
    };

    // The original error type survives, because the sweep distinguishes a
    // runner failure from invalid model output.
    await expect(
      createDistiller({ runner, chunkSize: 50 })({
        descriptor,
        events: eventsN(300),
        fromOffset: -1,
      }),
    ).rejects.toThrow(RunnerError);
  });

  it('widens chunks on a very long session rather than dropping its tail', async () => {
    const seen: number[] = [];
    const runner: DistillRunner = {
      id: 'stub',
      async isAvailable() {
        return { available: true };
      },
      async run(prompt) {
        seen.push((prompt.match(/turn \d+/g) ?? []).length);
        return JSON.stringify({});
      },
    };

    await createDistiller({ runner, chunkSize: 20, maxChunks: 3 })({
      descriptor,
      events: eventsN(400),
      fromOffset: -1,
    });

    // Three calls that between them still see the whole session, rather than
    // three calls covering the first 60 events and silently losing 340.
    expect(seen.length).toBeLessThanOrEqual(4);
    expect(seen.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(400);
  });

  it('reports when it widens rather than doing it silently', async () => {
    const messages: string[] = [];
    const runner: DistillRunner = {
      id: 'stub',
      async isAvailable() {
        return { available: true };
      },
      async run() {
        return JSON.stringify({});
      },
    };

    await createDistiller({
      runner,
      chunkSize: 20,
      maxChunks: 2,
      onProgress: (m) => messages.push(m),
    })({ descriptor, events: eventsN(400), fromOffset: -1 });

    expect(messages.join(' ')).toContain('widening chunks');
  });

  it('covers every event of a long session across its chunks', () => {
    const events = eventsN(2100);
    const chunkSize = Math.max(120, Math.ceil(events.length / 12));
    const chunks = chunkEvents(events, { chunkSize });

    const covered = new Set(chunks.flatMap((c) => c.events.map((e) => e.source.offset)));

    expect(chunks.length).toBeLessThanOrEqual(13);
    expect(covered.size).toBe(2100);
  });

  it('tells the model when it is seeing one part of a larger session', () => {
    const prompt = buildPrompt({
      events: [eventAt(0, 'hello')],
      adapterId: 'claude-code',
      part: { index: 2, total: 5 },
    });

    expect(prompt).toContain('part 2 of 5');
    expect(prompt).toContain('do not speculate');
  });
});

describe('tolerating model attribution slips', () => {
  it('reads acceptedBy given as a bare string', () => {
    const output = {
      decisions: [
        {
          question: 'Which cache?',
          choice: 'Redis',
          reason: 'Already deployed.',
          alternatives: [],
          attribution: { proposedBy: { type: 'agent', id: 'agent:x' }, acceptedBy: 'human:local' },
        },
      ],
    };

    const decision = toRecords(JSON.stringify(output), provenance).find((r) => r.type === 'decision');

    expect(decision?.type === 'decision' && decision.attribution.acceptedBy).toEqual({
      type: 'human',
      id: 'human:local',
    });
  });

  it('falls back to implicit rather than inventing a human approval', () => {
    const output = {
      decisions: [
        {
          question: 'Which cache?',
          choice: 'Redis',
          reason: 'Already deployed.',
          alternatives: [],
          attribution: { proposedBy: { type: 'agent', id: 'agent:x' }, acceptedBy: 'unclear' },
        },
      ],
    };

    const decision = toRecords(JSON.stringify(output), provenance).find((r) => r.type === 'decision');

    // "unclear" is not a person. Recording implicit is the honest reading.
    expect(decision?.type === 'decision' && decision.attribution.acceptedBy).toBe('implicit');
  });
});

describe('collapsing records that say the same thing twice', () => {
  function dec(question: string, choice: string, alternatives: number = 0) {
    return {
      id: `dec-${question.length}-${choice.length}`,
      type: 'decision' as const,
      sessionId: 'ses-1',
      episodeId: null,
      createdAt: '2026-08-25T09:00:00Z',
      source: {
        adapter: 'claude-code',
        sessionId: 'ses-1',
        sessionFile: '/tmp/a.jsonl',
        fromOffset: 0,
        toOffset: 5,
      },
      question,
      choice,
      reason: 'because',
      alternatives: Array.from({ length: alternatives }, (_, i) => ({
        choice: `option ${i}`,
        status: 'rejected' as const,
        reason: 'no',
        condition: null,
      })),
      attribution: {
        proposedBy: { type: 'agent' as const, id: 'agent:x' },
        acceptedBy: 'implicit' as const,
      },
      status: 'accepted' as const,
      supersededBy: null,
      relationships: [],
    };
  }

  it('collapses a near-identical restatement', () => {
    const collapsed = collapseNearDuplicates([
      dec('Scale chunks?', 'Scale chunk size to fit available call budget for complete coverage'),
      dec('Scale chunks?', 'Scale chunk size to fit call budget for complete coverage'),
    ]);

    expect(collapsed).toHaveLength(1);
  });

  it('leaves ambiguous pairs alone rather than merging them wrongly', () => {
    // Measured overlap for these real pairs was 0.33 to 0.50, the same range
    // genuinely different decisions reach. Merging loses information silently;
    // a duplicate is merely visible. Disjoint chunks are what prevents these.
    const collapsed = collapseNearDuplicates([
      dec('Config errors?', 'Report validation error explicitly with field and reason'),
      dec('Config errors?', 'Emit a warning showing the exact validation error instead of silently defaulting'),
    ]);

    expect(collapsed).toHaveLength(2);
  });

  it('never merges two decisions that differ only in their subject', () => {
    const collapsed = collapseNearDuplicates([
      dec('Which cache should we use?', 'Redis'),
      dec('Which queue should we use?', 'Redis'),
    ]);

    expect(collapsed).toHaveLength(2);
  });

  it('keeps genuinely different decisions apart', () => {
    const collapsed = collapseNearDuplicates([
      dec('Which cache?', 'Redis'),
      dec('Which queue?', 'Horizon workers'),
      dec('Should cancellation be async?', 'Asynchronous processing'),
    ]);

    expect(collapsed).toHaveLength(3);
  });

  it('keeps the richer record when collapsing', () => {
    const collapsed = collapseNearDuplicates([
      dec('Invalid config behaviour?', 'Report exact validation error instead of silently defaulting'),
      dec('Invalid config handling?', 'Report the exact validation error rather than silently defaulting', 2),
    ]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.type === 'decision' && collapsed[0].alternatives).toHaveLength(2);
  });

  it('never collapses records of different types', () => {
    const decision = dec('Which cache?', 'Redis');
    const discovery = {
      ...decision,
      id: 'disc-1',
      type: 'discovery' as const,
      text: 'Which cache Redis',
    } as unknown as import('@backstory/core').MemoryRecord;

    expect(collapseNearDuplicates([decision, discovery])).toHaveLength(2);
  });

  it('never collapses across sessions', () => {
    const a = dec('Invalid config behaviour?', 'Report exact validation error');
    const b = { ...dec('Invalid config behaviour?', 'Report exact validation error'), sessionId: 'ses-2' };

    expect(collapseNearDuplicates([a, b])).toHaveLength(2);
  });

  it('handles an empty list', () => {
    expect(collapseNearDuplicates([])).toEqual([]);
  });
});

describe('identity across re-distillation', () => {
  function decisionAt(from: number, to: number) {
    return withDerivedId({
      type: 'decision' as const,
      sessionId: 'ses-1',
      episodeId: null,
      createdAt: '2026-08-25T09:00:00Z',
      source: {
        adapter: 'claude-code',
        sessionId: 'ses-1',
        sessionFile: '/tmp/a.jsonl',
        fromOffset: from,
        toOffset: to,
      },
      question: 'Which cache should we use?',
      choice: 'Redis',
      reason: 'Already deployed.',
      alternatives: [],
      attribution: {
        proposedBy: { type: 'agent' as const, id: 'agent:x' },
        acceptedBy: 'implicit' as const,
      },
      status: 'accepted' as const,
      supersededBy: null,
      relationships: [],
    });
  }

  it('gives the same id when chunk boundaries shift between runs', () => {
    // Dogfooding read one session at 877 events and again at 899. The chunking
    // differed, the regions differed, and a second full set of records appeared.
    expect(decisionAt(0, 120).id).toBe(decisionAt(60, 180).id);
  });

  it('ignores punctuation and casing differences in the subject', () => {
    const plain = decisionAt(0, 10);
    const restyled = withDerivedId({ ...plain, choice: 'redis!' });

    expect(restyled.id).toBe(plain.id);
  });
});

describe('chunk boundaries', () => {
  it('produces disjoint chunks by default so a decision cannot appear twice', () => {
    const events = Array.from({ length: 400 }, (_, i) => eventAt(i, `turn ${i}`));
    const chunks = chunkEvents(events, { chunkSize: 100 });

    const seen = new Set<number>();
    for (const chunk of chunks) {
      for (const event of chunk.events) {
        expect(seen.has(event.source.offset)).toBe(false);
        seen.add(event.source.offset);
      }
    }

    expect(seen.size).toBe(400);
  });
});
