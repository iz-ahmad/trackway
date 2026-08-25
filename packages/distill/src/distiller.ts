import type { MemoryRecord } from '@backstory/core';
import { DEFAULT_CHUNK_SIZE, chunkEvents } from './chunk.js';
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
      const prompt = buildPrompt({
        events: chunk.events,
        adapterId: descriptor.adapter,
        ...(chunk.total > 1 ? { part: { index: chunk.index + 1, total: chunk.total } } : {}),
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
    return collapseNearDuplicates(dedupe(records));
  };
}
