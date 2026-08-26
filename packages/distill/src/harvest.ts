import type { Alternative, MemoryEvent } from '@backstory/core';

/**
 * A decision point the session recorded literally, options and all.
 *
 * When an agent presents a choice, it stores the question, every option, and
 * each option's reasoning as structured tool input. That is the richest record
 * of a fork that exists anywhere: it is what was actually offered, in the words
 * it was offered in, before anyone summarised it.
 *
 * The distiller was re-deriving all of this from conversation prose and losing
 * most of it. Measured on one real session: twelve option lists recorded, and
 * the extractor produced decisions with a median of one alternative.
 */
export interface HarvestedFork {
  question: string;
  /** Every option offered, in the order offered. */
  options: Array<{ label: string; reason: string }>;
  /** Which option the developer took, when the session recorded an answer. */
  chosen: string | null;
  /** Where in the session this happened, for provenance and ordering. */
  offset: number;
  timestamp: string;
}

interface ToolUse {
  type?: unknown;
  name?: unknown;
  id?: unknown;
  input?: unknown;
}

/** Tools that present an explicit option list, across supported agents. */
const OPTION_TOOLS = new Set(['AskUserQuestion', 'ask_question', 'request_user_input']);

/**
 * Pulls every recorded fork out of a session.
 *
 * Reads structured tool input only. Nothing here interprets prose, which is the
 * point: this is the part of a session that needs no interpretation.
 */
export function harvestForks(events: readonly MemoryEvent[]): HarvestedFork[] {
  const forks: HarvestedFork[] = [];
  const answers = collectAnswers(events);

  for (const event of events) {
    if (event.type !== 'tool_call') continue;

    for (const block of toolUses(event.payload)) {
      if (typeof block.name !== 'string' || !OPTION_TOOLS.has(block.name)) continue;

      const input = block.input as { questions?: unknown } | undefined;
      const questions = Array.isArray(input?.questions) ? input.questions : [];
      const toolId = typeof block.id === 'string' ? block.id : null;

      for (const raw of questions) {
        const fork = parseQuestion(raw, event, toolId, answers);
        if (fork) forks.push(fork);
      }
    }
  }

  return forks;
}

function parseQuestion(
  raw: unknown,
  event: MemoryEvent,
  toolId: string | null,
  answers: Map<string, string>,
): HarvestedFork | null {
  if (!raw || typeof raw !== 'object') return null;

  const node = raw as { question?: unknown; options?: unknown };
  if (typeof node.question !== 'string' || !Array.isArray(node.options)) return null;

  const options = node.options
    .map((option) => {
      const entry = option as { label?: unknown; description?: unknown };
      if (typeof entry.label !== 'string') return null;
      return {
        label: entry.label,
        // The description is the agent's own argument for that option. It is
        // already a reason, written before anyone knew which way it would go.
        reason: typeof entry.description === 'string' ? entry.description : '',
      };
    })
    .filter((option): option is { label: string; reason: string } => option !== null);

  if (options.length === 0) return null;

  return {
    question: node.question,
    options,
    chosen: matchChoice(toolId ? answers.get(toolId) : undefined, options),
    offset: event.source.offset,
    timestamp: event.timestamp,
  };
}

/**
 * Finds what the developer picked.
 *
 * The result arrives as a tool result naming the chosen label, so the match is
 * on the label text rather than an index. A label the session does not name is
 * left null rather than assumed: recording the wrong choice would be worse than
 * recording none.
 */
function matchChoice(
  answerText: string | undefined,
  options: ReadonlyArray<{ label: string }>,
): string | null {
  if (!answerText) return null;

  const exact = options.find((option) => answerText.includes(option.label));
  if (exact) return exact.label;

  // Labels sometimes carry a suffix the answer drops, such as "(Recommended)".
  const trimmed = options.find((option) => {
    const bare = option.label.replace(/\s*\([^)]*\)\s*$/, '').trim();
    return bare.length > 0 && answerText.includes(bare);
  });

  return trimmed?.label ?? null;
}

/** Maps a tool-use id to the text of its result. */
function collectAnswers(events: readonly MemoryEvent[]): Map<string, string> {
  const answers = new Map<string, string>();

  for (const event of events) {
    if (event.type !== 'tool_result') continue;

    for (const block of toolResults(event.payload)) {
      if (block.id && block.text) answers.set(block.id, block.text);
    }
  }

  return answers;
}

function toolResults(payload: unknown): Array<{ id: string | null; text: string }> {
  const found: Array<{ id: string | null; text: string }> = [];

  function walk(value: unknown, depth = 0): void {
    if (depth > 6) return;
    if (Array.isArray(value)) return value.forEach((item) => walk(item, depth + 1));
    if (!value || typeof value !== 'object') return;

    const node = value as Record<string, unknown>;
    if (node['type'] === 'tool_result') {
      const id = typeof node['tool_use_id'] === 'string' ? node['tool_use_id'] : null;
      found.push({ id, text: textOf(node['content']) });
    }

    for (const child of Object.values(node)) walk(child, depth + 1);
  }

  walk(payload);
  return found;
}

function textOf(value: unknown, depth = 0): string {
  if (depth > 5) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => textOf(item, depth + 1)).join(' ');
  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    return typeof node['text'] === 'string' ? node['text'] : textOf(Object.values(node), depth + 1);
  }
  return '';
}

function toolUses(payload: unknown): ToolUse[] {
  const found: ToolUse[] = [];

  function walk(value: unknown, depth = 0): void {
    if (depth > 6) return;
    if (Array.isArray(value)) return value.forEach((item) => walk(item, depth + 1));
    if (!value || typeof value !== 'object') return;

    const node = value as ToolUse & Record<string, unknown>;
    if (node.type === 'tool_use' && typeof node.name === 'string') found.push(node);

    for (const child of Object.values(node)) walk(child, depth + 1);
  }

  walk(payload);
  return found;
}

/** Renders a harvested fork as the alternatives of a decision record. */
export function forkAlternatives(fork: HarvestedFork): Alternative[] {
  return fork.options
    .filter((option) => option.label !== fork.chosen)
    .map((option) => ({
      choice: option.label,
      status: 'rejected' as const,
      reason: option.reason || 'No reason was recorded for this option.',
      condition: null,
    }));
}

/**
 * Describes the forks to the extractor so it does not restate them.
 *
 * The model still writes the decision's own reasoning, which lives in what was
 * said after the choice. It should not re-derive the question or the options,
 * because the session already recorded both exactly.
 */
export function describeForksForPrompt(forks: readonly HarvestedFork[]): string {
  if (forks.length === 0) return '';

  const lines = forks.map((fork, index) => {
    const options = fork.options
      .map((option) => `     ${option.label === fork.chosen ? 'CHOSEN' : '     '} ${option.label}`)
      .join('\n');

    return `  ${index + 1}. ${fork.question}\n${options}`;
  });

  return `
DECISION POINTS ALREADY RECORDED

This session stored the following choices verbatim, with their options. They are
facts, not something for you to infer, and they are handled separately.

${lines.join('\n\n')}

Do NOT emit a decision for any of these; they are already captured. Record only
decisions the list above does not cover.`;
}
