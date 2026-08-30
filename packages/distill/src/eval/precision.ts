import type { MemoryEvent, MemoryRecord } from '@trackway/core';
import { z } from 'zod';
import { renderTranscript } from '../prompts/extract.js';
import type { DistillRunner } from '../runner/contract.js';
import { extractJsonObject } from '../runner/validate.js';

/**
 * Whether an extracted decision is true of the session it came from.
 *
 * The answer key cannot measure this. It only holds decisions a session
 * recorded as an explicit option list, and most decisions are not made that
 * way: they are made in conversation. Every extraction outside that subset
 * counts against the key's precision no matter how correct it is, so the score
 * falls as the extractor finds more real decisions. Reading the worst-scoring
 * session by hand, all eight of its "false positives" were genuine engineering
 * choices with recorded alternatives.
 *
 * So this asks the only question that number cannot: is the decision real, and
 * does the record describe it correctly.
 */
export const PrecisionVerdict = z.enum(['sound', 'distorted', 'invented']);
export type PrecisionVerdict = z.infer<typeof PrecisionVerdict>;

const Judgement = z.strictObject({
  verdicts: z.array(
    z.strictObject({
      index: z.number().int().min(0),
      verdict: PrecisionVerdict,
      why: z.string().default(''),
    }),
  ),
});

export interface JudgedRecord {
  id: string;
  question: string;
  choice: string;
  verdict: PrecisionVerdict;
  why: string;
}

export interface PrecisionReport {
  judged: JudgedRecord[];
  sound: number;
  distorted: number;
  invented: number;
  /** Sound over judged. What "precision" was supposed to mean all along. */
  precision: number;
}

/** Kept small so a judgement fits one call and stays about the record. */
const EVIDENCE_MARGIN = 12;

/** Records distilled from the same region share a window and one call. */
function groupBySourceRegion(
  decisions: ReadonlyArray<Extract<MemoryRecord, { type: 'decision' }>>,
): Array<{ from: number; to: number; records: Array<Extract<MemoryRecord, { type: 'decision' }>> }> {
  const groups = new Map<string, { from: number; to: number; records: typeof decisions[number][] }>();

  for (const record of decisions) {
    const { fromOffset, toOffset } = record.source;
    const key = `${fromOffset}-${toOffset}`;
    const existing = groups.get(key);
    if (existing) existing.records.push(record);
    else groups.set(key, { from: fromOffset, to: toOffset, records: [record] });
  }

  return [...groups.values()].sort((a, b) => a.from - b.from);
}

/**
 * Judges extracted decisions against the part of the session they came from.
 *
 * One call per source region, not one for the session. Taking the widest span
 * across every decision looked focused and was not: a session distilled in
 * several chunks has decisions from end to end, so the window became the whole
 * transcript. On a 2565-event session that prompt was unanswerable and every
 * record came back unjudged, which the caller correctly excluded, so large
 * sessions quietly contributed nothing to the score at all. They are the ones
 * that extract worst, so their absence flattered the result.
 */
export async function judgePrecision(
  runner: DistillRunner,
  records: readonly MemoryRecord[],
  events: readonly MemoryEvent[],
): Promise<PrecisionReport> {
  const decisions = records.filter(
    (record): record is Extract<MemoryRecord, { type: 'decision' }> => record.type === 'decision',
  );

  if (decisions.length === 0) {
    return { judged: [], sound: 0, distorted: 0, invented: 0, precision: 0 };
  }

  const judged: JudgedRecord[] = [];

  for (const group of groupBySourceRegion(decisions)) {
    const evidence = events.filter(
      (event) =>
        event.source.offset >= group.from - EVIDENCE_MARGIN &&
        event.source.offset <= group.to + EVIDENCE_MARGIN,
    );

    let parsed: z.infer<typeof Judgement> | null = null;
    try {
      const raw = await runner.run(buildPrecisionPrompt(group.records, evidence));
      const result = Judgement.safeParse(extractJsonObject(raw));
      if (result.success) parsed = result.data;
    } catch {
      // A region that cannot be judged scores nothing rather than scoring badly.
    }

    const byIndex = new Map(
      (parsed?.verdicts ?? [])
        .filter((entry) => entry.index < group.records.length)
        .map((entry) => [entry.index, entry]),
    );

    group.records.forEach((record, index) => {
      const entry = byIndex.get(index);
      // An unjudged record is left out rather than assumed sound. A judge
      // failure must never be able to inflate the result.
      if (!entry) return;
      judged.push({
        id: record.id,
        question: record.question,
        choice: record.choice,
        verdict: entry.verdict,
        why: entry.why,
      });
    });
  }

  const count = (verdict: PrecisionVerdict): number =>
    judged.filter((entry) => entry.verdict === verdict).length;

  const sound = count('sound');
  return {
    judged,
    sound,
    distorted: count('distorted'),
    invented: count('invented'),
    precision: judged.length === 0 ? 0 : Number((sound / judged.length).toFixed(3)),
  };
}

export function buildPrecisionPrompt(
  decisions: ReadonlyArray<{ question: string; choice: string }>,
  evidence: readonly MemoryEvent[],
): string {
  const list = decisions
    .map((record, index) => `${index}. Q: ${record.question}\n   CHOSE: ${record.choice}`)
    .join('\n');

  return `You are auditing records produced from a coding session.

Below is part of the session, then a list of decisions a tool extracted from it.
For each extracted decision, judge it against the transcript only.

  sound      the session really does contain this decision, and the record
             states the question and what was chosen correctly.
  distorted  the session contains this decision, but the record gets it wrong:
             the wrong option is recorded as chosen, or the question is not the
             question that was actually settled.
  invented   the transcript does not support this decision at all.

A decision does not have to be dramatic to be sound. Choosing a column type,
picking where to put a fix, or settling how something should behave are all
real decisions. Judge whether the transcript supports it, not whether it was
important.

Do not require the session to have offered a list of options. Most decisions
are made in ordinary conversation, and those are exactly as real.

Do not reward or punish wording. The record paraphrases on purpose.

TRANSCRIPT
${renderTranscript(evidence)}

EXTRACTED DECISIONS
${list}

Return ONLY this JSON, one entry per extracted decision, no prose:
{"verdicts":[{"index":0,"verdict":"sound","why":"one short clause"}]}`;
}
