import type { MemoryRecord } from '@backstory/core';
import { chunkEvents } from './chunk.js';
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

    const chunks = chunkEvents(
      events,
      options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize },
    );

    const cap = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
    const batch = chunks.slice(0, cap);

    if (batch.length < chunks.length) {
      // Never silent. A capped session is a session whose later half was not
      // read, and the caller has to be able to know that.
      options.onProgress?.(
        `session ${descriptor.sessionId}: distilling ${batch.length} of ${chunks.length} chunks (cap reached)`,
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

    // Chunks overlap, so the same decision can surface twice. Identity is
    // content-derived, which collapses them without any comparison.
    return dedupe(records);
  };
}
