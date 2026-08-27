import type { SessionAdapter } from '@trackway/adapters';
import type { SessionDescriptor } from '@trackway/core';
import type { Distiller } from '../sweep/run.js';
import { extractGroundTruth } from './ground-truth.js';
import { describeForJudge, type Judge } from './judge.js';
import { aggregate, scoreSession, type Scores, type SessionScore } from './score.js';

export interface EvalOptions {
  adapter: SessionAdapter;
  distill: Distiller;
  /** Caps how many scored sessions to run, since each one costs a model call. */
  limit?: number;
  /**
   * Decides which extracted decisions correspond to which expected ones.
   * Without one, scoring falls back to word overlap, which cannot recognise a
   * reworded extraction and under-reports badly.
   */
  judge?: Judge;
  onProgress?: (message: string) => void;
}

export interface EvalReport {
  sessions: SessionScore[];
  totals: Scores;
  /** Sessions carrying an answer key, whether or not they were scored. */
  candidates: number;
  failures: Array<{ sessionId: string; reason: string }>;
}

/**
 * Measures the extractor against sessions that carry their own answer key.
 *
 * Reports rather than gates. Suppressing a useful record to protect a precision
 * score would be the wrong trade, so this exists to tune the prompt and to make
 * a regression visible when the prompt changes.
 */
export async function runEval(options: EvalOptions): Promise<EvalReport> {
  const descriptors = await options.adapter.listSessions();

  const withKey: Array<{ descriptor: SessionDescriptor; expected: ReturnType<typeof extractGroundTruth> }> = [];

  for (const descriptor of descriptors) {
    try {
      const events = await options.adapter.readSession(descriptor);
      const expected = extractGroundTruth(events);
      if (expected.length > 0) withKey.push({ descriptor, expected });
    } catch {
      // Unreadable sessions cannot contribute an answer key.
    }
  }

  const batch = withKey.slice(0, options.limit ?? withKey.length);
  const sessions: SessionScore[] = [];
  const failures: EvalReport['failures'] = [];

  for (const [index, item] of batch.entries()) {
    options.onProgress?.(
      `[${index + 1}/${batch.length}] ${item.descriptor.sessionId.slice(0, 12)} (${item.expected.length} expected)`,
    );

    try {
      const events = await options.adapter.readSession(item.descriptor);
      const records = await options.distill({ descriptor: item.descriptor, events, fromOffset: -1 });
      const decisions = (records ?? []).filter((record) => record.type === 'decision');

      const judged = options.judge
        ? await options.judge.match(item.expected, decisions.map(describeForJudge))
        : undefined;

      sessions.push(
        scoreSession(item.descriptor.sessionId, item.expected, records ?? [], judged),
      );
    } catch (error) {
      failures.push({
        sessionId: item.descriptor.sessionId,
        reason: String(error instanceof Error ? error.message : error),
      });
    }
  }

  return { sessions, totals: aggregate(sessions), candidates: withKey.length, failures };
}
