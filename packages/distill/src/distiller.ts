import { withDerivedId, type MemoryRecord } from '@backstory/core';
import { DEFAULT_CHUNK_SIZE, chunkEvents } from './chunk.js';
import { describeForksForPrompt, forkAlternatives, harvestForks, type HarvestedFork } from './harvest.js';
import { collapseNearDuplicates } from './dedupe.js';
import { buildPrompt } from './prompts/extract.js';
import type { DistillRunner } from './runner/contract.js';
import { toRecords } from './runner/validate.js';
import type { Distiller } from './sweep/run.js';

export interface DistillerOptions {
  runner: DistillRunner;
  now?: () => Date;
  chunkSize?: number;
  /** Caps calls per session so one enormous session cannot run away. */
  maxChunks?: number;
  onProgress?: (message: string) => void;
}

const DEFAULT_MAX_CHUNKS = 12;

/**
 * Turns a recorded fork into a record.
 *
 * Attribution is certain here in a way it never is from prose: the agent asked
 * and a person answered, so it is recorded as exactly that.
 *
 * Not every fork is a decision. A dismissed one is a question nobody answered,
 * and calling it a decision produced records that showed the reader a fork and
 * could not say which way it went. A freehand answer is a decision the
 * developer wrote themselves, with every offered option rejected.
 */
function forkToRecord(
  fork: HarvestedFork,
  sessionId: string,
  adapter: string,
  sessionFile: string,
): MemoryRecord {
  const source = {
    adapter,
    sessionId,
    sessionFile,
    fromOffset: fork.offset,
    toOffset: fork.offset,
  };

  const common = {
    sessionId,
    episodeId: null,
    commits: [],
    createdAt: fork.timestamp,
    source,
  };

  if (fork.outcome.kind === 'declined') {
    return withDerivedId({
      ...common,
      type: 'question' as const,
      significance: 'technical' as const,
      question: fork.question,
      answer: null,
      status: 'open' as const,
      actor: { type: 'agent' as const, id: `agent:${adapter}` },
    }) as MemoryRecord;
  }

  const outcome = fork.outcome;
  const answered = outcome.kind === 'answered';
  const choice = outcome.kind === 'answered' ? outcome.text : outcome.label;

  return withDerivedId({
    ...common,
    type: 'decision' as const,
    significance: 'technical' as const,
    question: fork.question,
    choice,
    reason: answered
      ? 'Written by the developer rather than taken from the options offered.'
      : (fork.options.find((option) => option.label === choice)?.reason ??
        'The session recorded the choice but no reasoning for it.'),
    alternatives: forkAlternatives(fork),
    attribution: {
      // A freehand answer came from the developer, so they proposed it. The
      // agent only proposed the options they turned down.
      proposedBy: answered
        ? ({ type: 'human' as const, id: 'human:local' } as const)
        : ({ type: 'agent' as const, id: `agent:${adapter}` } as const),
      acceptedBy: { type: 'human' as const, id: 'human:local' } as const,
    },
    status: 'accepted' as const,
    supersededBy: null,
    relationships: [],
  }) as MemoryRecord;
}

/**
 * Drops model decisions that restate a fork already read from the session.
 *
 * The prompt asks the model not to re-emit these and it does anyway. That is
 * the same lesson the discovery triage learned: a rule buried in a larger
 * prompt is a request, not a constraint, and only code enforces it.
 *
 * Identity cannot catch these on its own, because a decision is identified by
 * its choice and the model rewords the choice. The question is the reliable
 * key: it comes verbatim from structured tool input, and two genuinely
 * different decisions do not share one word for word.
 */
function withoutReharvested(
  records: readonly MemoryRecord[],
  forks: readonly HarvestedFork[],
): MemoryRecord[] {
  if (forks.length === 0) return [...records];

  const asked = new Set(forks.map((fork) => normalizeSubject(fork.question)));

  return records.filter(
    (record) => record.type !== 'decision' || !asked.has(normalizeSubject(record.question)),
  );
}

/** Matches the folding the ID derivation uses, so the two agree on sameness. */
function normalizeSubject(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function dedupe(records: readonly MemoryRecord[]): MemoryRecord[] {
  const seen = new Map<string, MemoryRecord>();
  for (const record of records) if (!seen.has(record.id)) seen.set(record.id, record);
  return [...seen.values()];
}

/**
 * Wires a runner and the extraction prompt into the sweep's Distiller shape.
 *
 * Returns null rather than throwing when there is nothing worth sending, so the
 * sweep records the region as handled instead of retrying it forever.
 */
export function createDistiller(options: DistillerOptions): Distiller {
  const now = options.now ?? (() => new Date());

  return async ({ descriptor, events, fromOffset }): Promise<MemoryRecord[] | null> => {
    if (events.length === 0) return null;

    /*
     * Forks the session recorded literally are taken as given rather than
     * re-derived. They carry the exact question, every option, and each
     * option's own argument, written before anyone knew which way it would go.
     * Asking a model to reconstruct that from prose loses most of it: measured
     * on one real session, twelve recorded forks came back as decisions with a
     * median of one alternative.
     */
    const forks = harvestForks(events);
    const harvested = forks.map((fork) =>
      forkToRecord(fork, descriptor.sessionId, descriptor.adapter, descriptor.sessionFile),
    );

    const cap = options.maxChunks ?? DEFAULT_MAX_CHUNKS;

    // A very long session widens its chunks rather than losing its tail.
    // Capping the number of chunks alone still drops the end of a session, and
    // dropping the end is exactly the failure this replaced: a 2100-event
    // session would have been read only to the two-thirds mark.
    const requested = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunkSize = Math.max(requested, Math.ceil(events.length / cap));

    const batch = chunkEvents(events, { chunkSize });

    if (chunkSize > requested) {
      options.onProgress?.(
        `session ${descriptor.sessionId}: ${events.length} events, widening chunks to ${chunkSize} to cover it in ${batch.length} calls`,
      );
    }

    const records: MemoryRecord[] = [];
    const failures: unknown[] = [];

    for (const chunk of batch) {
      const inChunk = forks.filter(
        (fork) => fork.offset >= chunk.fromOffset && fork.offset <= chunk.toOffset,
      );

      const prompt = buildPrompt({
        events: chunk.events,
        adapterId: descriptor.adapter,
        ...(chunk.total > 1 ? { part: { index: chunk.index + 1, total: chunk.total } } : {}),
        ...(inChunk.length > 0 ? { alreadyCaptured: describeForksForPrompt(inChunk) } : {}),
      });

      try {
        const output = await options.runner.run(prompt);

        records.push(
          ...toRecords(output, {
            sessionId: descriptor.sessionId,
            adapter: descriptor.adapter,
            sessionFile: descriptor.sessionFile,
            fromOffset: Math.max(chunk.fromOffset, 0),
            toOffset: chunk.toOffset,
            createdAt: chunk.events.at(-1)?.timestamp ?? now().toISOString(),
          }),
        );
      } catch (error) {
        // One bad chunk must not cost the whole session. A long session is
        // exactly where losing everything hurts most.
        failures.push(error);
      }
    }

    if (records.length === 0 && failures.length > 0) {
      // Rethrow the original rather than wrapping it. The sweep distinguishes a
      // runner failure from invalid output, and a wrapper would erase that.
      throw failures[0];
    }

    // Two passes. Identical records collapse on their id; records that say the
    // same thing in different words need comparing, because the model rewords
    // between chunks and a hash of different words is a different hash.
    // Harvested forks come first so a near-duplicate from the model collapses
    // into the recorded one rather than replacing it.
    return collapseNearDuplicates(dedupe([...harvested, ...withoutReharvested(records, forks)]));
  };
}
