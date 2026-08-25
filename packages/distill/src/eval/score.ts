import type { MemoryRecord } from '@backstory/core';
import type { ExpectedDecision } from './ground-truth.js';

export interface Scores {
  precision: number;
  recall: number;
  f1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

export interface SessionScore extends Scores {
  sessionId: string;
  expected: number;
  extracted: number;
  matched: Array<{ expected: string; extracted: string; similarity: number }>;
  missed: string[];
}

/** Below this, two strings are not describing the same decision. */
const MATCH_THRESHOLD = 0.34;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are',
  'be', 'do', 'we', 'should', 'this', 'that', 'it', 'as', 'at', 'by', 'from', 'which', 'what',
  'how', 'use', 'using', 'want', 'need',
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

/**
 * Jaccard overlap over content words.
 *
 * Extraction rewords: an expected question of "Which bot protection for the
 * deletion form?" may surface as "Use Turnstile for bot protection". Exact
 * matching would score a correct extraction as a miss, so scoring compares
 * meaning-bearing words instead.
 */
export function similarity(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;

  return shared / (left.size + right.size - shared);
}

/**
 * Scores one session's extraction against its answer key.
 *
 * Matching is greedy and one-to-one: each expected decision can be claimed by
 * at most one extracted record, so producing five near-duplicates of the same
 * decision counts as one match and four false positives rather than five hits.
 */
export function scoreSession(
  sessionId: string,
  expected: readonly ExpectedDecision[],
  records: readonly MemoryRecord[],
  /**
   * Supplied by the judge when one is available. Word overlap cannot recognise
   * a reworded extraction, so it is only the fallback.
   */
  judged?: ReadonlyArray<{ expectedIndex: number; extractedIndex: number }>,
): SessionScore {
  const extracted = records
    .filter((record) => record.type === 'decision')
    .map((record) => (record.type === 'decision' ? `${record.question} ${record.choice}` : ''));

  const claimed = new Set<number>();
  const matched: SessionScore['matched'] = [];
  const missed: string[] = [];

  if (judged) {
    const claimedExpected = new Set<number>();

    for (const pair of judged) {
      if (claimed.has(pair.extractedIndex) || claimedExpected.has(pair.expectedIndex)) continue;
      claimed.add(pair.extractedIndex);
      claimedExpected.add(pair.expectedIndex);
      matched.push({
        expected: expected[pair.expectedIndex]?.question ?? '',
        extracted: extracted[pair.extractedIndex] ?? '',
        similarity: 1,
      });
    }

    expected.forEach((item, index) => {
      if (!claimedExpected.has(index)) missed.push(item.question);
    });

    return {
      sessionId,
      expected: expected.length,
      extracted: extracted.length,
      matched,
      missed,
      ...ratios(matched.length, extracted.length - matched.length, missed.length),
    };
  }

  for (const item of expected) {
    let bestIndex = -1;
    let bestScore = 0;

    extracted.forEach((candidate, index) => {
      if (claimed.has(index)) return;
      const score = similarity(item.question, candidate);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    if (bestIndex >= 0 && bestScore >= MATCH_THRESHOLD) {
      claimed.add(bestIndex);
      matched.push({
        expected: item.question,
        extracted: extracted[bestIndex] ?? '',
        similarity: Number(bestScore.toFixed(3)),
      });
    } else {
      missed.push(item.question);
    }
  }

  const truePositives = matched.length;
  const falsePositives = extracted.length - truePositives;
  const falseNegatives = missed.length;

  return {
    sessionId,
    expected: expected.length,
    extracted: extracted.length,
    matched,
    missed,
    ...ratios(truePositives, falsePositives, falseNegatives),
  };
}

export function aggregate(sessions: readonly SessionScore[]): Scores {
  const truePositives = sum(sessions, (s) => s.truePositives);
  const falsePositives = sum(sessions, (s) => s.falsePositives);
  const falseNegatives = sum(sessions, (s) => s.falseNegatives);

  return ratios(truePositives, falsePositives, falseNegatives);
}

function ratios(truePositives: number, falsePositives: number, falseNegatives: number): Scores {
  const precision =
    truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall =
    truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    f1: Number(f1.toFixed(3)),
    truePositives,
    falsePositives,
    falseNegatives,
  };
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

/**
 * A precision number alone hides the failure that matters. A session where the
 * extractor produced nothing scores perfect precision, so silence is reported
 * separately.
 */
export function summarize(sessions: readonly SessionScore[]): string {
  const totals = aggregate(sessions);
  const silent = sessions.filter((s) => s.extracted === 0 && s.expected > 0).length;

  return [
    `sessions scored:  ${sessions.length}`,
    `precision:        ${totals.precision}`,
    `recall:           ${totals.recall}`,
    `f1:               ${totals.f1}`,
    `matched:          ${totals.truePositives}`,
    `unmatched output: ${totals.falsePositives}`,
    `missed:           ${totals.falseNegatives}`,
    `silent sessions:  ${silent}`,
  ].join('\n');
}
