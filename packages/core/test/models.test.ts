import { describe, expect, it } from 'vitest';
import {
  ActionRecord,
  Attribution,
  BackstoryConfig,
  DecisionRecord,
  DistillationResult,
  EventType,
  MemoryEvent,
  MemoryRecord,
  QuestionRecord,
  SessionDescriptor,
  defaultConfig,
  flattenResult,
  isHumanAccepted,
  isHumanOverride,
} from '../src/index.js';

const source = {
  adapter: 'claude-code',
  sessionId: 'ses-1',
  sessionFile: '/tmp/ses-1.jsonl',
  fromOffset: 0,
  toOffset: 12,
};

function eventOf(type: string) {
  return {
    id: `evt-${type}`,
    sessionId: 'ses-1',
    timestamp: '2026-08-25T09:14:00Z',
    type,
    actor: { type: 'agent', id: 'agent:claude-code' },
    payload: { text: 'anything' },
    source: { adapter: 'claude-code', sessionFile: '/tmp/ses-1.jsonl', offset: 3 },
  };
}

describe('MemoryEvent', () => {
  it('parses and round-trips every event type unchanged', () => {
    for (const type of EventType.options) {
      const input = eventOf(type);
      const parsed = MemoryEvent.parse(input);
      expect(parsed).toEqual(input);
    }
  });

  it('rejects an event missing a required field, naming the field', () => {
    const { sessionId: _omitted, ...incomplete } = eventOf('user_prompt');
    const result = MemoryEvent.safeParse(incomplete);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.path.includes('sessionId'))).toBe(true);
  });

  it('rejects an unknown event type', () => {
    expect(MemoryEvent.safeParse(eventOf('telepathy')).success).toBe(false);
  });

  it('rejects a non-ISO timestamp', () => {
    const bad = { ...eventOf('user_prompt'), timestamp: 'yesterday' };
    expect(MemoryEvent.safeParse(bad).success).toBe(false);
  });
});

describe('SessionDescriptor', () => {
  it('accepts a session with no working directory or branch', () => {
    const parsed = SessionDescriptor.parse({
      sessionId: 'ses-1',
      adapter: 'codex',
      sessionFile: '/tmp/ses-1.jsonl',
      cwd: null,
      branch: null,
      lastModified: '2026-08-25T09:14:00Z',
      formatVersion: 'codex-v1',
    });

    expect(parsed.cwd).toBeNull();
  });

  it('requires a declared format version so an unknown shape cannot be guessed at', () => {
    const result = SessionDescriptor.safeParse({
      sessionId: 'ses-1',
      adapter: 'codex',
      sessionFile: '/tmp/ses-1.jsonl',
      cwd: null,
      branch: null,
      lastModified: '2026-08-25T09:14:00Z',
    });

    expect(result.success).toBe(false);
  });
});

describe('records', () => {
  const decision = {
    id: 'dec-20260825-a3f2',
    type: 'decision' as const,
    sessionId: 'ses-1',
    episodeId: null,
    createdAt: '2026-08-25T09:18:00Z',
    source,
    question: 'Should cancellation be asynchronous?',
    choice: 'Asynchronous processing',
    reason: 'Provider callbacks can take several seconds.',
    alternatives: [
      {
        choice: 'Synchronous processing',
        status: 'rejected' as const,
        reason: 'Would block the request for the callback duration.',
        condition: 'Provider callbacks take seconds',
      },
    ],
    attribution: {
      proposedBy: { type: 'agent' as const, id: 'agent:claude-code' },
      acceptedBy: { type: 'human' as const, id: 'human:7a91' },
    },
    status: 'accepted' as const,
    supersededBy: null,
    relationships: [],
  };

  it('parses a decision carrying alternatives', () => {
    const parsed = DecisionRecord.parse(decision);
    expect(parsed.alternatives).toHaveLength(1);
    expect(parsed.alternatives[0]?.status).toBe('rejected');
  });

  it('parses a decision with no alternatives', () => {
    const parsed = DecisionRecord.parse({ ...decision, alternatives: [] });
    expect(parsed.alternatives).toEqual([]);
  });

  it('rejects an unknown extra field rather than silently dropping it', () => {
    const result = DecisionRecord.safeParse({ ...decision, confidence: 0.9 });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
  });

  it('rejects an alternative with no reason, since the reason is the payload', () => {
    const result = DecisionRecord.safeParse({
      ...decision,
      alternatives: [{ choice: 'Synchronous', status: 'rejected', reason: '', condition: null }],
    });

    expect(result.success).toBe(false);
  });

  it('keeps an unresolved question rather than requiring an answer', () => {
    const parsed = QuestionRecord.parse({
      id: 'q-20260825-91bc',
      type: 'question',
      sessionId: 'ses-1',
      episodeId: null,
      createdAt: '2026-08-25T09:14:00Z',
      source,
      question: 'Should the endpoint block unverified users?',
      answer: null,
      status: 'open',
      actor: { type: 'human', id: 'human:7a91' },
    });

    expect(parsed.status).toBe('open');
    expect(parsed.answer).toBeNull();
  });

  it('discriminates records by type through the union', () => {
    const parsed = MemoryRecord.parse(decision);
    expect(parsed.type).toBe('decision');
  });

  it('rejects a record whose type does not match its shape', () => {
    const result = MemoryRecord.safeParse({ ...decision, type: 'discovery' });
    expect(result.success).toBe(false);
  });

  it('accepts an action with an empty file list', () => {
    const parsed = ActionRecord.parse({
      id: 'act-20260825-2f19',
      type: 'action',
      sessionId: 'ses-1',
      episodeId: null,
      createdAt: '2026-08-25T09:31:00Z',
      source,
      description: 'Added the cancellation queue job.',
      status: 'completed',
      files: [],
    });

    expect(parsed.files).toEqual([]);
  });
});

describe('attribution', () => {
  it('treats an implicit agent decision as not human-accepted', () => {
    const attribution = Attribution.parse({
      proposedBy: { type: 'agent', id: 'agent:claude-code' },
      acceptedBy: 'implicit',
    });

    expect(isHumanAccepted(attribution)).toBe(false);
    expect(isHumanOverride(attribution)).toBe(false);
  });

  it('records an agent proposal accepted by a human', () => {
    const attribution = Attribution.parse({
      proposedBy: { type: 'agent', id: 'agent:claude-code' },
      acceptedBy: { type: 'human', id: 'human:7a91' },
    });

    expect(isHumanAccepted(attribution)).toBe(true);
    expect(isHumanOverride(attribution)).toBe(false);
  });

  it('records a human proposing and accepting as an override', () => {
    const attribution = Attribution.parse({
      proposedBy: { type: 'human', id: 'human:7a91' },
      acceptedBy: { type: 'human', id: 'human:7a91' },
    });

    expect(isHumanOverride(attribution)).toBe(true);
  });

  it('rejects an acceptance that is neither an actor nor implicit', () => {
    const result = Attribution.safeParse({
      proposedBy: { type: 'agent', id: 'agent:claude-code' },
      acceptedBy: 'probably',
    });

    expect(result.success).toBe(false);
  });
});

describe('DistillationResult', () => {
  it('flattens every record type into one ordered list', () => {
    const result = DistillationResult.parse({
      questions: [],
      discoveries: [
        {
          id: 'disc-20260825-91bc',
          type: 'discovery',
          sessionId: 'ses-1',
          episodeId: null,
          createdAt: '2026-08-25T09:16:00Z',
          source,
          text: 'Webhooks may be delivered more than once.',
        },
      ],
      decisions: [],
      actions: [],
      outcomes: [],
    });

    expect(flattenResult(result)).toHaveLength(1);
  });

  it('rejects the whole batch when one record is invalid', () => {
    const result = DistillationResult.safeParse({
      questions: [],
      discoveries: [{ id: 'disc-1', type: 'discovery', text: 'incomplete' }],
      decisions: [],
      actions: [],
      outcomes: [],
    });

    expect(result.success).toBe(false);
  });
});

describe('BackstoryConfig', () => {
  it('supplies defaults for every field', () => {
    const config = defaultConfig();

    expect(config.storePath).toBe('.backstory');
    expect(config.quietWindowMinutes).toBe(15);
    expect(config.cacheRetentionDays).toBe(30);
    expect(config.adapters).toEqual(['claude-code', 'codex', 'opencode']);
  });

  it('rejects a non-positive quiet window', () => {
    expect(BackstoryConfig.safeParse({ quietWindowMinutes: 0 }).success).toBe(false);
  });

  it('rejects an unknown config key rather than ignoring it', () => {
    expect(BackstoryConfig.safeParse({ quietWindowMinutes: 5, verbose: true }).success).toBe(false);
  });
});
