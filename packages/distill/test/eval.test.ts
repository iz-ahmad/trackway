import type { MemoryEvent, MemoryRecord } from '@backstory/core';
import { describe, expect, it } from 'vitest';
import {
  aggregate,
  buildJudgePrompt,
  createJudge,
  describeForJudge,
  extractGroundTruth,
  hasGroundTruth,
  scoreSession,
  similarity,
  summarize,
  tokenize,
  type ExpectedDecision,
} from '../src/index.js';

function toolCall(name: string, input: unknown, sessionId = 'ses-1'): MemoryEvent {
  return {
    id: 'e-1',
    sessionId,
    timestamp: '2026-08-25T09:00:00Z',
    type: 'tool_call',
    actor: { type: 'agent', id: 'agent:claude-code' },
    payload: { content: [{ type: 'tool_use', id: 'tu-1', name, input }] },
    source: { adapter: 'claude-code', sessionFile: '/tmp/a.jsonl', offset: 0 },
  };
}

/**
 * The answer that resolves a fork.
 *
 * Every ground-truth test needs one now. An option list on its own says a
 * question was asked, not that anything was decided, and the answer key is
 * about decisions.
 */
function answer(text: string, question = 'Which bot protection for the deletion form?'): MemoryEvent {
  return {
    id: 'e-2',
    sessionId: 'ses-1',
    timestamp: '2026-08-25T09:00:00Z',
    type: 'tool_result',
    actor: { type: 'agent', id: 'agent:claude-code' },
    payload: {
      content: [
        { type: 'tool_result', tool_use_id: 'tu-1', content: `The user answered: "${question}"="${text}"` },
      ],
    },
    source: { adapter: 'claude-code', sessionFile: '/tmp/a.jsonl', offset: 1 },
  };
}

/** Shaped like a real stored option list. */
const optionList = {
  questions: [
    {
      question: 'Which bot protection for the deletion form?',
      header: 'Bot defense',
      options: [
        { label: 'Cloudflare Turnstile', description: 'Real CAPTCHA-grade protection.' },
        { label: 'Honeypot + timing only', description: 'Zero config, weaker.' },
        { label: 'Nothing for now', description: 'Ship without it.' },
      ],
    },
  ],
};

function decision(question: string, choice: string): MemoryRecord {
  return {
    id: `dec-${question.length}`,
    type: 'decision',
    sessionId: 'ses-1',
    episodeId: null,
    commits: [],
    significance: 'technical',
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

describe('ground truth', () => {
  it('reconstructs the question and the options not taken', () => {
    const [expected] = extractGroundTruth([
      toolCall('AskUserQuestion', optionList),
      answer('Cloudflare Turnstile'),
    ]);

    expect(expected?.question).toBe('Which bot protection for the deletion form?');
    expect(expected?.chosen).toBe('Cloudflare Turnstile');
    expect(expected?.rejected).toEqual(['Honeypot + timing only', 'Nothing for now']);
  });

  it('expects nothing from a fork the developer dismissed', () => {
    // 23 of 188 real forks end this way. Counting them capped recall at 0.88
    // however good extraction became, and scored the fix that stopped writing
    // them down as decisions as a regression.
    const declined: MemoryEvent = {
      ...answer('x'),
      payload: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'The tool use was rejected.' },
        ],
      },
    };

    expect(extractGroundTruth([toolCall('AskUserQuestion', optionList), declined])).toEqual([]);
  });

  it('expects nothing from an option list that was never answered', () => {
    expect(extractGroundTruth([toolCall('AskUserQuestion', optionList)])).toEqual([]);
  });

  it('takes a freehand answer as the decision, rejecting everything offered', () => {
    const [expected] = extractGroundTruth([
      toolCall('AskUserQuestion', optionList),
      answer('None of these. Rate-limit by IP instead.'),
    ]);

    expect(expected?.chosen).toBe('None of these. Rate-limit by IP instead.');
    expect(expected?.rejected).toHaveLength(3);
  });

  it('reads only structured tool input, never prose', () => {
    const prose: MemoryEvent = {
      ...toolCall('AskUserQuestion', optionList),
      type: 'agent_message',
      payload: { content: [{ type: 'text', text: 'Should we use Turnstile or a honeypot?' }] },
    };

    // An answer key derived by the same judgement being measured would prove
    // nothing, so prose contributes no expectations.
    expect(extractGroundTruth([prose])).toEqual([]);
  });

  it('recognises the equivalent tool under other agent vocabularies', () => {
    const resolved = answer('Cloudflare Turnstile');
    expect(extractGroundTruth([toolCall('ask_question', optionList), resolved])).toHaveLength(1);
    expect(
      extractGroundTruth([toolCall('request_user_input', optionList), resolved]),
    ).toHaveLength(1);
  });

  it('ignores tool calls that are not option lists', () => {
    expect(extractGroundTruth([toolCall('Read', { file_path: 'src/a.ts' })])).toEqual([]);
  });

  it('extracts every question from a multi-question call', () => {
    const multi = {
      questions: [
        optionList.questions[0],
        { question: 'Which storage backend?', options: [{ label: 'Redis' }, { label: 'Postgres' }] },
      ],
    };

    expect(
      extractGroundTruth([
        toolCall('AskUserQuestion', multi),
        answer('Cloudflare Turnstile'),
        answer('Redis', 'Which storage backend?'),
      ]),
    ).toHaveLength(2);
  });

  it('skips a malformed question rather than failing the session', () => {
    const malformed = { questions: [{ question: 'No options here' }, optionList.questions[0]] };

    expect(
      extractGroundTruth([
        toolCall('AskUserQuestion', malformed),
        answer('Cloudflare Turnstile'),
      ]),
    ).toHaveLength(1);
  });

  it('contributes nothing from a session with no structured decision points', () => {
    const plain: MemoryEvent = { ...toolCall('Read', {}), type: 'user_prompt' };

    expect(hasGroundTruth([plain])).toBe(false);
    expect(extractGroundTruth([plain])).toEqual([]);
  });
});

describe('similarity', () => {
  it('drops stopwords and short words so wording differences do not dominate', () => {
    expect([...tokenize('Should we use the Redis cache for this?')]).toEqual(['redis', 'cache']);
  });

  it('scores a reworded extraction of the same decision as a match', () => {
    const score = similarity(
      'Which bot protection for the deletion form?',
      'Use Cloudflare Turnstile for bot protection on the deletion form',
    );

    expect(score).toBeGreaterThan(0.34);
  });

  it('scores unrelated decisions as a non-match', () => {
    const score = similarity('Which cache should we use?', 'Rename the pagination helper');

    expect(score).toBeLessThan(0.34);
  });

  it('returns zero when either side has no content words', () => {
    expect(similarity('the a of', 'Redis cache')).toBe(0);
  });
});

describe('scoring', () => {
  const expected: ExpectedDecision[] = [
    {
      question: 'Which bot protection for the deletion form?',
      chosen: null,
      rejected: [],
      sessionId: 'ses-1',
    },
    { question: 'Which cache should we use?', chosen: null, rejected: [], sessionId: 'ses-1' },
  ];

  it('counts a reworded but correct extraction as a hit', () => {
    const score = scoreSession('ses-1', expected, [
      decision('Which bot protection for the deletion form?', 'Turnstile'),
      decision('Which cache should we use?', 'Redis'),
    ]);

    expect(score.truePositives).toBe(2);
    expect(score.precision).toBe(1);
    expect(score.recall).toBe(1);
  });

  it('counts extraction the answer key does not contain as a false positive', () => {
    const score = scoreSession('ses-1', expected, [
      decision('Which bot protection for the deletion form?', 'Turnstile'),
      decision('Which cache should we use?', 'Redis'),
      decision('Rename the pagination helper', 'Yes'),
    ]);

    expect(score.falsePositives).toBe(1);
    expect(score.precision).toBeLessThan(1);
    expect(score.recall).toBe(1);
  });

  it('counts a missed decision as a false negative', () => {
    const score = scoreSession('ses-1', expected, [
      decision('Which bot protection for the deletion form?', 'Turnstile'),
    ]);

    expect(score.falseNegatives).toBe(1);
    expect(score.recall).toBe(0.5);
    expect(score.missed).toEqual(['Which cache should we use?']);
  });

  it('does not let near-duplicates of one decision claim several hits', () => {
    const score = scoreSession('ses-1', [expected[0]!], [
      decision('Which bot protection for the deletion form?', 'Turnstile'),
      decision('Which bot protection for the deletion form?', 'Turnstile again'),
      decision('Which bot protection for the deletion form?', 'Turnstile once more'),
    ]);

    expect(score.truePositives).toBe(1);
    expect(score.falsePositives).toBe(2);
  });

  it('scores an over-capturing extractor as low precision and high recall', () => {
    const noisy = [
      decision('Which bot protection for the deletion form?', 'Turnstile'),
      decision('Which cache should we use?', 'Redis'),
      ...Array.from({ length: 8 }, (_, i) => decision(`Trivial matter ${i}`, 'Whatever')),
    ];

    const score = scoreSession('ses-1', expected, noisy);

    expect(score.recall).toBe(1);
    expect(score.precision).toBeLessThan(0.3);
  });

  it('scores a silent extractor as perfect precision and zero recall', () => {
    const score = scoreSession('ses-1', expected, []);

    expect(score.precision).toBe(1);
    expect(score.recall).toBe(0);
  });

  it('ignores non-decision records when scoring decisions', () => {
    const discovery: MemoryRecord = {
      id: 'disc-1',
      type: 'discovery',
      sessionId: 'ses-1',
      episodeId: null,
      commits: [],
      significance: 'technical',
      createdAt: '2026-08-25T09:00:00Z',
      source: {
        adapter: 'claude-code',
        sessionId: 'ses-1',
        sessionFile: '/tmp/a.jsonl',
        fromOffset: 0,
        toOffset: 5,
      },
      text: 'Something learned.',
    };

    const score = scoreSession('ses-1', [expected[0]!], [
      decision('Which bot protection for the deletion form?', 'Turnstile'),
      discovery,
    ]);

    expect(score.falsePositives).toBe(0);
  });
});

describe('reporting', () => {
  it('aggregates across sessions', () => {
    const a = scoreSession('ses-1', [
      { question: 'Which cache?', chosen: null, rejected: [], sessionId: 'ses-1' },
    ], [decision('Which cache?', 'Redis')]);

    const b = scoreSession('ses-2', [
      { question: 'Which queue?', chosen: null, rejected: [], sessionId: 'ses-2' },
    ], []);

    const totals = aggregate([a, b]);

    expect(totals.truePositives).toBe(1);
    expect(totals.falseNegatives).toBe(1);
    expect(totals.recall).toBe(0.5);
  });

  it('reports silent sessions separately, since silence scores perfect precision', () => {
    const silent = scoreSession('ses-1', [
      { question: 'Which cache?', chosen: null, rejected: [], sessionId: 'ses-1' },
    ], []);

    const report = summarize([silent]);

    expect(report).toContain('precision:        1');
    expect(report).toContain('silent sessions:  1');
  });

  it('reports perfect scores for a session with nothing expected and nothing produced', () => {
    const totals = aggregate([scoreSession('ses-1', [], [])]);

    expect(totals.precision).toBe(1);
    expect(totals.recall).toBe(1);
  });
});

describe('judge-based matching', () => {
  const expected: ExpectedDecision[] = [
    {
      question: 'Stats row currently hardcoded fake. What should it be?',
      chosen: null,
      rejected: [],
      sessionId: 'ses-1',
    },
    { question: 'One story or many?', chosen: null, rejected: [], sessionId: 'ses-1' },
  ];

  const rewordedExtraction = [
    decision('How to populate success story stats shown on spotlight?', 'Derive from seller data'),
    decision('Display strategy: single story or multiple?', 'Rotate through multiple stories'),
  ];

  it('word overlap cannot recognise a reworded extraction', () => {
    // Both pairs describe the same decision, and both score near zero. This is
    // why the judge exists, and the fallback stays only for when no judge is
    // available.
    const lexical = scoreSession('ses-1', expected, rewordedExtraction);

    expect(lexical.truePositives).toBe(0);
    expect(similarity(expected[1]!.question, 'Display strategy: single story or multiple?')).toBeLessThan(
      0.34,
    );
  });

  it('scores the same extraction correctly when a judge supplies the matches', () => {
    const judged = scoreSession('ses-1', expected, rewordedExtraction, [
      { expectedIndex: 0, extractedIndex: 0 },
      { expectedIndex: 1, extractedIndex: 1 },
    ]);

    expect(judged.truePositives).toBe(2);
    expect(judged.precision).toBe(1);
    expect(judged.recall).toBe(1);
  });

  it('reports what the judge did not match as missed', () => {
    const judged = scoreSession('ses-1', expected, rewordedExtraction, [
      { expectedIndex: 0, extractedIndex: 0 },
    ]);

    expect(judged.missed).toEqual(['One story or many?']);
    expect(judged.falsePositives).toBe(1);
  });

  it('ignores a duplicate claim on the same extracted decision', () => {
    const judged = scoreSession('ses-1', expected, rewordedExtraction, [
      { expectedIndex: 0, extractedIndex: 0 },
      { expectedIndex: 1, extractedIndex: 0 },
    ]);

    expect(judged.truePositives).toBe(1);
  });

  it('builds a prompt that tells the judge wording will differ', () => {
    const prompt = buildJudgePrompt(expected, ['Some extracted decision']);

    expect(prompt).toContain('Wording');
    expect(prompt).toContain('not whether they share words');
    expect(prompt).toContain('0. Stats row');
  });

  it('drops matches that point outside either list', async () => {
    const judge = createJudge({
      id: 'stub',
      async isAvailable() {
        return { available: true };
      },
      async run() {
        return JSON.stringify({
          matches: [
            { expectedIndex: 0, extractedIndex: 0 },
            { expectedIndex: 99, extractedIndex: 0 },
            { expectedIndex: 0, extractedIndex: 99 },
          ],
        });
      },
    });

    const matches = await judge.match(expected, ['one extracted decision']);

    expect(matches).toEqual([{ expectedIndex: 0, extractedIndex: 0 }]);
  });

  it('returns no matches rather than throwing when the judge output is unusable', async () => {
    const judge = createJudge({
      id: 'stub',
      async isAvailable() {
        return { available: true };
      },
      async run() {
        return 'I am not sure how to answer that.';
      },
    });

    await expect(judge.match(expected, ['a decision'])).resolves.toEqual([]);
  });

  it('does not call the model when either list is empty', async () => {
    let called = false;
    const judge = createJudge({
      id: 'stub',
      async isAvailable() {
        return { available: true };
      },
      async run() {
        called = true;
        return '{"matches":[]}';
      },
    });

    expect(await judge.match(expected, [])).toEqual([]);
    expect(await judge.match([], ['a decision'])).toEqual([]);
    expect(called).toBe(false);
  });

  it('renders a decision for the judge as question and outcome', () => {
    expect(describeForJudge(rewordedExtraction[0]!)).toContain('→');
  });
});
