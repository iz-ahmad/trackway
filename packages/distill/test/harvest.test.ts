import type { MemoryEvent } from '@backstory/core';
import { describe, expect, it } from 'vitest';
import { describeForksForPrompt, forkAlternatives, harvestForks } from '../src/index.js';

function toolCall(name: string, input: unknown, id = 'tu-1', offset = 0): MemoryEvent {
  return {
    id: `e-${offset}`,
    sessionId: 'ses-1',
    timestamp: '2026-08-26T09:00:00Z',
    type: 'tool_call',
    actor: { type: 'agent', id: 'agent:claude-code' },
    payload: { content: [{ type: 'tool_use', id, name, input }] },
    source: { adapter: 'claude-code', sessionFile: '/tmp/a.jsonl', offset },
  };
}

function toolResult(text: string, id = 'tu-1', offset = 1): MemoryEvent {
  return {
    id: `e-${offset}`,
    sessionId: 'ses-1',
    timestamp: '2026-08-26T09:01:00Z',
    type: 'tool_result',
    actor: { type: 'agent', id: 'agent:claude-code' },
    payload: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
    source: { adapter: 'claude-code', sessionFile: '/tmp/a.jsonl', offset },
  };
}

/** Shaped exactly like a real recorded option list. */
const optionList = {
  questions: [
    {
      question: 'What should trigger passive distillation?',
      header: 'Trigger',
      options: [
        { label: 'Agent hook (Recommended)', description: 'Records exist at commit time.' },
        { label: 'Git pre-commit hook', description: 'Needs setting up in every repository.' },
        { label: 'Background daemon', description: 'A process to supervise.' },
      ],
    },
  ],
};

describe('harvesting a recorded fork', () => {
  it('keeps every option the session offered, not just one', () => {
    // The extractor was re-deriving these from prose and returning a median of
    // one alternative where the session had recorded three or four.
    const [fork] = harvestForks([toolCall('AskUserQuestion', optionList)]);

    expect(fork?.options).toHaveLength(3);
  });

  it('keeps each option’s own argument as its reason', () => {
    const [fork] = harvestForks([toolCall('AskUserQuestion', optionList)]);

    expect(fork?.options[1]).toEqual({
      label: 'Git pre-commit hook',
      reason: 'Needs setting up in every repository.',
    });
  });

  it('keeps the question in the words it was asked', () => {
    const [fork] = harvestForks([toolCall('AskUserQuestion', optionList)]);

    expect(fork?.question).toBe('What should trigger passive distillation?');
  });

  it('records which option was taken', () => {
    const [fork] = harvestForks([
      toolCall('AskUserQuestion', optionList),
      toolResult('"Trigger"="Agent hook (Recommended)"'),
    ]);

    expect(fork?.chosen).toBe('Agent hook (Recommended)');
  });

  it('matches a choice even when the answer drops a label suffix', () => {
    const [fork] = harvestForks([
      toolCall('AskUserQuestion', optionList),
      toolResult('The user chose Agent hook for this.'),
    ]);

    expect(fork?.chosen).toBe('Agent hook (Recommended)');
  });

  it('leaves the choice unknown rather than guessing', () => {
    // Recording the wrong choice would be worse than recording none.
    const [fork] = harvestForks([
      toolCall('AskUserQuestion', optionList),
      toolResult('The user wants to clarify these questions.'),
    ]);

    expect(fork?.chosen).toBeNull();
  });

  it('keeps a fork whose choice was never recorded, for its options', () => {
    const forks = harvestForks([toolCall('AskUserQuestion', optionList)]);

    expect(forks).toHaveLength(1);
    expect(forks[0]?.options).toHaveLength(3);
  });

  it('turns the options not taken into alternatives', () => {
    const [fork] = harvestForks([
      toolCall('AskUserQuestion', optionList),
      toolResult('"Trigger"="Agent hook (Recommended)"'),
    ]);

    const alternatives = forkAlternatives(fork!);

    expect(alternatives.map((a) => a.choice)).toEqual([
      'Git pre-commit hook',
      'Background daemon',
    ]);
    expect(alternatives[0]?.reason).toContain('every repository');
  });

  it('recognises the equivalent tool in other agents', () => {
    expect(harvestForks([toolCall('ask_question', optionList)])).toHaveLength(1);
    expect(harvestForks([toolCall('request_user_input', optionList)])).toHaveLength(1);
  });

  it('ignores tool calls that are not option lists', () => {
    expect(harvestForks([toolCall('Read', { file_path: 'a.ts' })])).toEqual([]);
  });

  it('harvests every question from a multi-question call', () => {
    const multi = {
      questions: [
        optionList.questions[0],
        { question: 'Which store?', options: [{ label: 'Redis' }, { label: 'Postgres' }] },
      ],
    };

    expect(harvestForks([toolCall('AskUserQuestion', multi)])).toHaveLength(2);
  });

  it('skips a question with no options rather than failing the session', () => {
    const malformed = { questions: [{ question: 'No options' }, optionList.questions[0]] };

    expect(harvestForks([toolCall('AskUserQuestion', malformed)])).toHaveLength(1);
  });

  it('handles an option with no description', () => {
    const bare = { questions: [{ question: 'Which?', options: [{ label: 'This one' }] }] };
    const [fork] = harvestForks([toolCall('AskUserQuestion', bare)]);

    expect(fork?.options[0]?.reason).toBe('');
    expect(forkAlternatives({ ...fork!, chosen: null })[0]?.reason).toContain('No reason');
  });

  it('records where in the session each fork happened', () => {
    const forks = harvestForks([
      toolCall('AskUserQuestion', optionList, 'a', 4),
      toolCall('AskUserQuestion', optionList, 'b', 40),
    ]);

    expect(forks.map((f) => f.offset)).toEqual([4, 40]);
  });
});

describe('telling the extractor what is already captured', () => {
  it('lists the recorded forks and marks the chosen option', () => {
    const forks = harvestForks([
      toolCall('AskUserQuestion', optionList),
      toolResult('"Trigger"="Agent hook (Recommended)"'),
    ]);

    const text = describeForksForPrompt(forks);

    expect(text).toContain('What should trigger passive distillation?');
    expect(text).toContain('CHOSEN');
    expect(text).toContain('Do NOT emit a decision for any of these');
  });

  it('says nothing when a chunk recorded no forks', () => {
    expect(describeForksForPrompt([])).toBe('');
  });
});
