import type { MemoryRecord } from '@trackway/core';
import { z } from 'zod';
import type { DistillRunner } from '../runner/contract.js';
import { extractJsonObject } from '../runner/validate.js';
import type { ExpectedDecision } from './ground-truth.js';

const JudgeVerdict = z.strictObject({
  matches: z.array(
    z.strictObject({
      expectedIndex: z.number().int().min(0),
      extractedIndex: z.number().int().min(0),
    }),
  ),
});

export interface Match {
  expectedIndex: number;
  extractedIndex: number;
}

/**
 * Decides which extracted decisions correspond to which expected ones.
 *
 * Word overlap was tried first and does not work. A good extractor rewords:
 * "Stats row currently hardcoded fake. What should it be?" comes back as "How
 * to populate success story stats?", which is the same decision and shares one
 * content word. Jaccard scored that pair 0.056, indistinguishable from noise,
 * so a correct extraction scored zero.
 *
 * Judging semantic correspondence needs a model. One call per session compares
 * both lists at once rather than one call per pair.
 */
export interface Judge {
  match(expected: readonly ExpectedDecision[], extracted: readonly string[]): Promise<Match[]>;
}

export function createJudge(runner: DistillRunner): Judge {
  return {
    async match(expected, extracted) {
      if (expected.length === 0 || extracted.length === 0) return [];

      const prompt = buildJudgePrompt(expected, extracted);
      const output = await runner.run(prompt);

      // Unusable judge output means this session cannot be scored. Reporting
      // no matches understates the score, which is the safe direction: a judge
      // failure must never be able to inflate a result.
      let verdict: unknown;
      try {
        verdict = extractJsonObject(output);
      } catch {
        return [];
      }

      const parsed = JudgeVerdict.safeParse(verdict);
      if (!parsed.success) return [];

      // A judge that invents indices would inflate the score, so anything out
      // of range is dropped rather than trusted.
      return parsed.data.matches.filter(
        (match) =>
          match.expectedIndex < expected.length && match.extractedIndex < extracted.length,
      );
    },
  };
}

export function buildJudgePrompt(
  expected: readonly ExpectedDecision[],
  extracted: readonly string[],
): string {
  const expectedList = expected
    .map((item, index) => `${index}. ${item.question}`)
    .join('\n');
  const extractedList = extracted.map((item, index) => `${index}. ${item}`).join('\n');

  return `You are scoring an information-extraction system.

LIST A holds decision points that a coding session is known to contain. They are
taken from the literal option lists the session recorded, so they are ground truth.

LIST B holds decisions that the extractor produced from the same session.

Decide which entries in B describe the same decision as an entry in A. Wording
will differ, often completely: the extractor paraphrases and states the outcome
rather than the question. Judge whether they concern the same choice about the
same thing, not whether they share words.

Each A entry matches at most one B entry, and each B entry matches at most one A
entry. Leave anything unmatched out.

LIST A (expected)
${expectedList}

LIST B (extracted)
${extractedList}

Return ONLY this JSON, no prose:
{"matches":[{"expectedIndex":0,"extractedIndex":2}]}`;
}

/** Renders a record as the one-line description the judge compares. */
export function describeForJudge(record: MemoryRecord): string {
  return record.type === 'decision' ? `${record.question} → ${record.choice}` : '';
}
