import type { MemoryEvent } from '@trackway/core';
import { harvestForks } from '../harvest.js';

/**
 * A decision point the session recorded literally, with no interpretation.
 *
 * Some sessions contain the agent's own option lists as structured tool input:
 * the question, every option with its rationale, and what the developer
 * answered. That is ground truth nobody had to label. It is the answer key for
 * measuring whether the extractor finds what a session actually decided.
 */
export interface ExpectedDecision {
  question: string;
  /** The option taken, or the developer's own words when they typed an answer. */
  chosen: string | null;
  rejected: string[];
  sessionId: string;
}

/**
 * Pulls expected decisions out of a session's events.
 *
 * Reads only structured tool input, through the same harvester the distiller
 * uses. That shared path is the point. This file used to parse option lists
 * itself, and when the harvester learned that a fork can be declined or
 * answered freehand, the copy here did not: the key went on expecting a
 * decision for every option list ever shown, including the 23 of 188 that were
 * dismissed without one. Recall was measured against a key that was 12% wrong
 * and could not be beaten however good extraction became.
 *
 * A fork nobody resolved is not a decision the extractor failed to find. It is
 * a question, which is what the distiller now records, and it belongs in no
 * answer key about decisions.
 */
export function extractGroundTruth(events: readonly MemoryEvent[]): ExpectedDecision[] {
  const expected: ExpectedDecision[] = [];

  for (const fork of harvestForks(events)) {
    if (fork.outcome.kind === 'declined') continue;

    const chosen = fork.outcome.kind === 'chosen' ? fork.outcome.label : fork.outcome.text;

    expected.push({
      question: fork.question,
      chosen,
      // A freehand answer rejects everything that was offered. An option taken
      // rejects the rest.
      rejected: fork.options
        .map((option) => option.label)
        .filter((label) => label !== chosen),
      sessionId: eventSessionId(events),
    });
  }

  return expected;
}

/** Sessions are read whole, so every event carries the same id. */
function eventSessionId(events: readonly MemoryEvent[]): string {
  return events[0]?.sessionId ?? '';
}

/** True when a session carries enough recorded forks to score against. */
export function hasGroundTruth(events: readonly MemoryEvent[]): boolean {
  return extractGroundTruth(events).length > 0;
}
