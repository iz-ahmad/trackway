import type { AdapterRegistry, SessionAdapter } from '@trackway/adapters';
import type { MemoryEvent, MemoryRecord, SessionDescriptor } from '@trackway/core';
import { assessEligibility, type SkipReason } from './quiet.js';
import { loadState, saveState, stateKey, type SweepState } from './state.js';

export interface SweepOptions {
  cacheDir: string;
  quietWindowMinutes: number;
  repoRoot?: string;
  now?: Date;
  /** Caps work per invocation so a first run over a large backlog stays responsive. */
  maxSessions?: number;
}

/**
 * Turns a quiet session's new events into records.
 *
 * Supplied by the caller rather than imported, so the sweep can be tested
 * without invoking a model, and so an adapter that cannot distil can be handled
 * by returning null.
 */
export type Distiller = (input: {
  descriptor: SessionDescriptor;
  events: MemoryEvent[];
  fromOffset: number;
}) => Promise<MemoryRecord[] | null>;

/**
 * Marks records that came from a session where some region could not be read.
 *
 * A session distilled in several calls can have one of them fail after retries
 * while the rest succeed. Those records are worth keeping, but the watermark
 * must not move past the part that failed, or those events are skipped forever
 * and nothing ever says so. Record IDs derive from content, so re-reading the
 * region on the next sweep costs a second pass and creates no duplicates.
 */
export const PARTIAL = Symbol.for('trackway.partialDistillation');

export function markPartial(records: MemoryRecord[], failures: number): MemoryRecord[] {
  return Object.defineProperty(records, PARTIAL, {
    value: failures,
    enumerable: false,
  }) as MemoryRecord[];
}

export function partialFailures(records: MemoryRecord[] | null): number {
  const value = records === null ? undefined : (records as unknown as Record<symbol, unknown>)[PARTIAL];
  return typeof value === 'number' ? value : 0;
}

export interface SweptSession {
  sessionId: string;
  adapter: string;
  records: MemoryRecord[];
  eventCount: number;
  /** True when the adapter cannot distil, so events were read but not turned into records. */
  undistilled: boolean;
  /** How many regions failed after retries. Their events are retried next sweep. */
  partial?: number;
}

export interface SweepFailure {
  sessionId: string;
  adapter: string;
  reason: string;
}

export interface SweepResult {
  swept: SweptSession[];
  skipped: Array<{ sessionId: string; adapter: string; reason: SkipReason }>;
  failures: SweepFailure[];
  /** Sessions eligible but not reached because the per-run cap was hit. */
  deferred: number;
}

/**
 * One pass over every available adapter.
 *
 * Nothing here throws. A sweep runs from a CLI command and, later, from an
 * agent hook; in both cases a failure must be reported rather than raised,
 * because interrupting the developer's coding session is the one outcome this
 * system must never cause.
 */
export async function runSweep(
  registry: AdapterRegistry,
  distill: Distiller,
  options: SweepOptions,
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const state = await loadState(options.cacheDir);

  const result: SweepResult = { swept: [], skipped: [], failures: [], deferred: 0 };

  const discovered = await registry.listAllSessions(
    options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot },
  );

  const eligible: Array<{ descriptor: SessionDescriptor; adapter: SessionAdapter }> = [];

  for (const { descriptor, adapter } of discovered) {
    const assessment = assessEligibility(descriptor, state, {
      quietWindowMinutes: options.quietWindowMinutes,
      now,
      ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
    });

    if (assessment.eligible) {
      eligible.push({ descriptor, adapter });
    } else {
      result.skipped.push({
        sessionId: descriptor.sessionId,
        adapter: descriptor.adapter,
        reason: assessment.reason ?? 'already-distilled',
      });
    }
  }

  const cap = options.maxSessions ?? eligible.length;
  const batch = eligible.slice(0, cap);
  result.deferred = eligible.length - batch.length;

  for (const { descriptor, adapter } of batch) {
    const key = stateKey(descriptor.adapter, descriptor.sessionId);
    const previous = state.sessions[key];
    const fromOffset = previous?.watermark ?? -1;

    try {
      const events = await adapter.readSession(descriptor, { fromOffset });

      if (events.length === 0) {
        recordSuccess(state, key, descriptor, fromOffset, now);
        continue;
      }

      const highestOffset = events.reduce(
        (max, event) => Math.max(max, event.source.offset),
        fromOffset,
      );

      if (!adapter.capabilities.canDistill) {
        result.swept.push({
          sessionId: descriptor.sessionId,
          adapter: descriptor.adapter,
          records: [],
          eventCount: events.length,
          undistilled: true,
        });
        // The watermark still advances. Re-reading events we cannot distil
        // every sweep would be wasted work with no different outcome.
        recordSuccess(state, key, descriptor, highestOffset, now);
        continue;
      }

      const records = await distill({ descriptor, events, fromOffset });

      if (records === null) {
        result.swept.push({
          sessionId: descriptor.sessionId,
          adapter: descriptor.adapter,
          records: [],
          eventCount: events.length,
          undistilled: true,
        });
        recordSuccess(state, key, descriptor, highestOffset, now);
        continue;
      }

      const unread = partialFailures(records);

      result.swept.push({
        sessionId: descriptor.sessionId,
        adapter: descriptor.adapter,
        records,
        eventCount: events.length,
        undistilled: false,
        ...(unread > 0 ? { partial: unread } : {}),
      });

      if (unread > 0) {
        // Keep what was read, and leave the watermark where it was so the part
        // that failed is read again next time rather than skipped in silence.
        recordFailure(
          state,
          key,
          descriptor,
          previous,
          now,
          new Error(`${unread} of the session could not be read and will be retried`),
        );
      } else {
        recordSuccess(state, key, descriptor, highestOffset, now);
      }
    } catch (error) {
      result.failures.push({
        sessionId: descriptor.sessionId,
        adapter: descriptor.adapter,
        reason: String(error instanceof Error ? error.message : error),
      });
      recordFailure(state, key, descriptor, previous, now, error);
    }
  }

  await saveState(options.cacheDir, state).catch(() => {
    // A state write failure costs re-distillation next run, not correctness.
  });

  return result;
}

function recordSuccess(
  state: SweepState,
  key: string,
  descriptor: SessionDescriptor,
  watermark: number,
  now: Date,
): void {
  state.sessions[key] = {
    sessionId: descriptor.sessionId,
    adapter: descriptor.adapter,
    watermark,
    lastSeenModified: descriptor.lastModified,
    lastSweptAt: now.toISOString(),
    lastError: null,
    failureCount: 0,
  };
}

function recordFailure(
  state: SweepState,
  key: string,
  descriptor: SessionDescriptor,
  previous: SweepState['sessions'][string] | undefined,
  now: Date,
  error: unknown,
): void {
  state.sessions[key] = {
    sessionId: descriptor.sessionId,
    adapter: descriptor.adapter,
    // The watermark does not advance on failure, so the region is retried.
    watermark: previous?.watermark ?? -1,
    lastSeenModified: descriptor.lastModified,
    lastSweptAt: now.toISOString(),
    lastError: String(error instanceof Error ? error.message : error),
    failureCount: (previous?.failureCount ?? 0) + 1,
  };
}
