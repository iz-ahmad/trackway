import type { MemoryRecord } from '@backstory/core';

/**
 * Above this overlap, two records of the same type are describing the same
 * thing in different words.
 *
 * Deliberately conservative, and a safety net rather than the main defence.
 * Measured against real duplicate pairs, overlap ran from 0.33 to 0.86 while
 * genuinely different decisions reached 0.50, so no threshold separates them
 * cleanly. Chunks are disjoint precisely so this does not have to.
 *
 * At 0.75 it collapses only near-identical restatements and leaves anything
 * ambiguous alone, because a wrongly merged decision loses information
 * silently while a duplicate is merely visible.
 */
const NEAR_DUPLICATE_THRESHOLD = 0.75;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with',
  'is', 'are', 'be', 'do', 'we', 'should', 'this', 'that', 'it', 'as', 'at',
  'by', 'from', 'which', 'what', 'how', 'use', 'using', 'instead', 'rather',
  'than', 'not', 'no', 'yes', 'when', 'if', 'then',
]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

function overlap(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;

  return shared / Math.min(left.size, right.size);
}

/** The text that identifies what a record is about. */
function subjectOf(record: MemoryRecord): string {
  switch (record.type) {
    case 'question':
      return record.question;
    case 'discovery':
      return record.text;
    case 'decision':
      return `${record.question} ${record.choice}`;
    case 'action':
      return record.description;
    case 'outcome':
      return record.text;
  }
}

/** Prefers the record carrying more detail, since it is the better one to keep. */
function richness(record: MemoryRecord): number {
  if (record.type === 'decision') {
    return record.alternatives.length * 100 + record.reason.length;
  }
  return subjectOf(record).length;
}

/**
 * Collapses records that describe the same thing in different words.
 *
 * Chunks overlap so a question and its answer are not split apart, which means
 * the same decision is often seen twice. Content-derived ids cannot collapse
 * those, because the model rewords each time and a hash of different words is a
 * different hash. Dogfooding produced four records for one decision this way.
 *
 * Comparison is lexical and deliberately so. These duplicates share most of
 * their wording, unlike a genuinely reworded extraction being matched against
 * an unrelated phrasing, which needs a model. Spending a call per pair here
 * would cost more than the duplicates do.
 */
export function collapseNearDuplicates(records: readonly MemoryRecord[]): MemoryRecord[] {
  const kept: MemoryRecord[] = [];

  for (const record of records) {
    const existingIndex = kept.findIndex(
      (candidate) =>
        candidate.type === record.type &&
        candidate.sessionId === record.sessionId &&
        overlap(subjectOf(candidate), subjectOf(record)) >= NEAR_DUPLICATE_THRESHOLD,
    );

    if (existingIndex === -1) {
      kept.push(record);
      continue;
    }

    // Keep whichever says more. A record with alternatives beats one without.
    const existing = kept[existingIndex]!;
    if (richness(record) > richness(existing)) kept[existingIndex] = record;
  }

  return kept;
}
