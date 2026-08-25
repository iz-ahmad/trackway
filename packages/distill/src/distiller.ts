import type { MemoryRecord } from '@backstory/core';
import { buildPrompt } from './prompts/extract.js';
import type { DistillRunner } from './runner/contract.js';
import { toRecords } from './runner/validate.js';
import type { Distiller } from './sweep/run.js';

export interface DistillerOptions {
  runner: DistillRunner;
  now?: () => Date;
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

    const prompt = buildPrompt({ events, adapterId: descriptor.adapter });
    const output = await options.runner.run(prompt);

    const toOffset = events.reduce((max, e) => Math.max(max, e.source.offset), fromOffset);

    return toRecords(output, {
      sessionId: descriptor.sessionId,
      adapter: descriptor.adapter,
      sessionFile: descriptor.sessionFile,
      fromOffset: Math.max(fromOffset, 0),
      toOffset,
      createdAt: (events.at(-1)?.timestamp ?? now().toISOString()),
    });
  };
}
