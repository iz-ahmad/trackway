import type { MemoryEvent } from '@backstory/core';

/**
 * A decision point the session recorded literally, with no interpretation.
 *
 * Some sessions contain the agent's own option lists as structured tool input:
 * the question, every option with its rationale, and which one the developer
 * picked. That is ground truth nobody had to label. It is the answer key for
 * measuring whether the extractor finds what a session actually decided.
 */
export interface ExpectedDecision {
  question: string;
  chosen: string | null;
  rejected: string[];
  sessionId: string;
}

interface ToolUse {
  type?: unknown;
  name?: unknown;
  input?: unknown;
}

/** Tool names that carry an explicit option list across supported agents. */
const OPTION_TOOLS = new Set(['AskUserQuestion', 'ask_question', 'request_user_input']);

/**
 * Pulls expected decisions out of a session's events.
 *
 * Reads only structured tool input. Nothing here interprets prose, because an
 * answer key derived by the same kind of judgement being measured would prove
 * nothing.
 */
export function extractGroundTruth(events: readonly MemoryEvent[]): ExpectedDecision[] {
  const expected: ExpectedDecision[] = [];

  for (const event of events) {
    if (event.type !== 'tool_call') continue;

    for (const block of toolUseBlocks(event.payload)) {
      if (typeof block.name !== 'string' || !OPTION_TOOLS.has(block.name)) continue;

      const input = block.input as { questions?: unknown } | undefined;
      const questions = Array.isArray(input?.questions) ? input.questions : [];

      for (const raw of questions) {
        const parsed = parseQuestion(raw, event.sessionId);
        if (parsed) expected.push(parsed);
      }
    }
  }

  return expected;
}

function parseQuestion(raw: unknown, sessionId: string): ExpectedDecision | null {
  if (!raw || typeof raw !== 'object') return null;

  const node = raw as { question?: unknown; options?: unknown };
  if (typeof node.question !== 'string' || !Array.isArray(node.options)) return null;

  const labels = node.options
    .map((option) => (option as { label?: unknown })?.label)
    .filter((label): label is string => typeof label === 'string');

  if (labels.length === 0) return null;

  // The transcript records what was offered. Which option the developer took is
  // not stored alongside it, so the chosen field stays null and scoring is
  // measured on whether the fork was found at all.
  return { question: node.question, chosen: null, rejected: labels.slice(1), sessionId };
}

function toolUseBlocks(payload: unknown): ToolUse[] {
  const found: ToolUse[] = [];

  function walk(value: unknown, depth = 0): void {
    if (depth > 6) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;

    const node = value as ToolUse & Record<string, unknown>;
    if (node.type === 'tool_use' && typeof node.name === 'string') found.push(node);

    for (const child of Object.values(node)) walk(child, depth + 1);
  }

  walk(payload);
  return found;
}

/** True when a session carries any structured decision point. */
export function hasGroundTruth(events: readonly MemoryEvent[]): boolean {
  return extractGroundTruth(events).length > 0;
}
