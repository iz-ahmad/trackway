import type { MemoryEvent } from '@backstory/core';

/**
 * Events per distillation call.
 *
 * Chosen so a chunk fits comfortably in one request alongside the instructions,
 * with room for long tool output.
 */
export const DEFAULT_CHUNK_SIZE = 120;

/**
 * Events repeated at the start of the next chunk.
 *
 * A decision is often stated a few turns after the question that prompted it.
 * Cutting between the two loses both: the question looks unanswered and the
 * decision looks unmotivated. Overlapping costs a little duplication, which
 * content-derived ids collapse anyway.
 */
export const DEFAULT_OVERLAP = 12;

export interface Chunk {
  events: MemoryEvent[];
  fromOffset: number;
  toOffset: number;
  index: number;
  total: number;
}

/**
 * Splits a session into windows that each fit one call.
 *
 * Truncating instead was the first approach and it was wrong: a session with 27
 * decision points produced 5 records because the extractor never saw past the
 * first 200 events. Silent truncation is worse than a missing feature, because
 * the output looks complete.
 */
export function chunkEvents(
  events: readonly MemoryEvent[],
  options: { chunkSize?: number; overlap?: number } = {},
): Chunk[] {
  const size = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const overlap = Math.max(0, Math.min(options.overlap ?? DEFAULT_OVERLAP, size - 1));

  if (events.length === 0) return [];
  if (events.length <= size) {
    return [
      {
        events: [...events],
        fromOffset: events[0]!.source.offset,
        toOffset: events[events.length - 1]!.source.offset,
        index: 0,
        total: 1,
      },
    ];
  }

  const windows: MemoryEvent[][] = [];
  const step = size - overlap;

  for (let start = 0; start < events.length; start += step) {
    const window = events.slice(start, start + size);
    if (window.length === 0) break;
    windows.push(window);
    if (start + size >= events.length) break;
  }

  return windows.map((window, index) => ({
    events: window,
    fromOffset: window[0]!.source.offset,
    toOffset: window[window.length - 1]!.source.offset,
    index,
    total: windows.length,
  }));
}
