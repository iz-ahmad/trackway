import type { MemoryEvent, MemoryRecord } from '@trackway/core';
import { describe, expect, it } from 'vitest';
import { buildPrecisionPrompt, judgePrecision, RunnerError } from '../src/index.js';
import type { DistillRunner } from '../src/index.js';

function event(offset: number): MemoryEvent {
  return {
    id: `e-${offset}`,
    sessionId: 'ses-1',
    timestamp: '2026-08-30T09:00:00Z',
    type: 'user_prompt',
    actor: { type: 'human', id: 'human:local' },
    payload: { content: [{ type: 'text', text: `turn ${offset}` }] },
    source: { adapter: 'claude-code', sessionFile: '/tmp/a.jsonl', offset },
  };
}

function decision(question: string, choice = 'Redis'): MemoryRecord {
  return {
    id: `dec-${question.length}-${choice.length}`,
    type: 'decision',
    sessionId: 'ses-1',
    episodeId: null,
    commits: [],
    createdAt: '2026-08-30T09:00:00Z',
    significance: 'technical',
    source: {
      adapter: 'claude-code',
      sessionId: 'ses-1',
      sessionFile: '/tmp/a.jsonl',
      fromOffset: 0,
      toOffset: 4,
    },
    question,
    choice,
    reason: 'because',
    alternatives: [],
    attribution: {
      proposedBy: { type: 'agent', id: 'agent:claude-code' },
      acceptedBy: { type: 'human', id: 'human:local' },
    },
    status: 'accepted',
    supersededBy: null,
    relationships: [],
  };
}

function runnerReturning(body: unknown): DistillRunner {
  return {
    id: 'stub',
    isAvailable: async () => ({ available: true }),
    run: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const events = [event(0), event(1), event(2), event(3)];

describe('judging whether an extracted decision is true of its session', () => {
  it('counts a sound record as precise', async () => {
    const runner = runnerReturning({ verdicts: [{ index: 0, verdict: 'sound', why: 'stated' }] });

    const report = await judgePrecision(runner, [decision('Which cache?')], events);

    expect(report.precision).toBe(1);
    expect(report.sound).toBe(1);
  });

  it('counts an invented record against precision', async () => {
    const runner = runnerReturning({ verdicts: [{ index: 0, verdict: 'invented', why: 'absent' }] });

    const report = await judgePrecision(runner, [decision('Which cache?')], events);

    expect(report.precision).toBe(0);
    expect(report.invented).toBe(1);
  });

  it('counts a distorted record against precision, since the record is wrong', async () => {
    const runner = runnerReturning({ verdicts: [{ index: 0, verdict: 'distorted', why: 'inverted' }] });

    const report = await judgePrecision(runner, [decision('Which cache?')], events);

    expect(report.precision).toBe(0);
    expect(report.distorted).toBe(1);
  });

  it('leaves out a record the judge did not rule on rather than assuming it sound', async () => {
    // A judge failure must never be able to inflate a result.
    const runner = runnerReturning({ verdicts: [{ index: 0, verdict: 'sound', why: '' }] });

    const report = await judgePrecision(
      runner,
      [decision('Which cache?'), decision('Which queue?', 'SQS')],
      events,
    );

    expect(report.judged).toHaveLength(1);
    expect(report.precision).toBe(1);
  });

  it('drops a verdict pointing at a record that does not exist', async () => {
    const runner = runnerReturning({ verdicts: [{ index: 9, verdict: 'sound', why: '' }] });

    const report = await judgePrecision(runner, [decision('Which cache?')], events);

    expect(report.judged).toEqual([]);
  });

  it('scores nothing when the judge returns unusable output', async () => {
    const report = await judgePrecision(runnerReturning('not json'), [decision('Which cache?')], events);

    expect(report.judged).toEqual([]);
    expect(report.precision).toBe(0);
  });

  it('scores nothing when the judge cannot be reached', async () => {
    const failing: DistillRunner = {
      id: 'stub',
      isAvailable: async () => ({ available: true }),
      run: async () => {
        throw new RunnerError('stub', 'timeout', 'timed out');
      },
    };

    await expect(judgePrecision(failing, [decision('Which cache?')], events)).resolves.toMatchObject({
      judged: [],
    });
  });

  it('judges nothing when there are no decisions to judge', async () => {
    const report = await judgePrecision(runnerReturning({ verdicts: [] }), [], events);

    expect(report.judged).toEqual([]);
  });
});

describe('the precision prompt', () => {
  it('tells the judge that a decision need not have been offered as a list', () => {
    // The whole reason this measurement exists: the answer key only holds
    // option-list decisions, and most decisions are made in conversation.
    const prompt = buildPrecisionPrompt([{ question: 'Which cache?', choice: 'Redis' }], events);

    expect(prompt).toContain('Do not require the session to have offered a list of options');
  });

  it('tells the judge to ignore wording, since the record paraphrases', () => {
    const prompt = buildPrecisionPrompt([{ question: 'Which cache?', choice: 'Redis' }], events);

    expect(prompt).toContain('paraphrases');
  });

  it('shows the transcript the decisions came from', () => {
    const prompt = buildPrecisionPrompt([{ question: 'Which cache?', choice: 'Redis' }], events);

    expect(prompt).toContain('turn 0');
  });
});
