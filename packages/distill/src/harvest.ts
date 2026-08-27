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
/**
 * How a fork ended.
 *
 * Measured across 470 sessions and 186 forks: 77% of answers name one of the
 * offered options, 9% are typed freehand, and 12% are declined outright.
 * Collapsing those last two into "no choice recorded" threw away a fifth of
 * everything the tool exists to keep, and turned every declined fork into a
 * decision that could not say what was decided.
 */
export type ForkOutcome =
  /** The answer named one of the options offered. */
  | { kind: 'chosen'; label: string }
  /** The developer typed their own answer instead of taking an option. */
  | { kind: 'answered'; text: string }
  /** The fork was dismissed without an answer. It is not a decision. */
  | { kind: 'declined' };

export interface HarvestedFork {
  question: string;
  /** Every option offered, in the order offered. */
  options: Array<{ label: string; reason: string }>;
  outcome: ForkOutcome;
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
    outcome: readOutcome(toolId ? answers.get(toolId) : undefined, node.question, options),
    offset: event.source.offset,
    timestamp: event.timestamp,
  };
}

/** How the harness reports a fork the developer dismissed. */
const DECLINED = [/the tool use was rejected/i, /doesn't want to proceed with this tool use/i];

/**
 * Reads how a fork ended.
 *
 * Order matters. A declined fork's result still quotes the question and can
 * contain an option's words, so rejection is tested before any matching.
 */
function readOutcome(
  answerText: string | undefined,
  question: string,
  options: ReadonlyArray<{ label: string }>,
): ForkOutcome {
  if (!answerText) return { kind: 'declined' };
  if (DECLINED.some((pattern) => pattern.test(answerText))) return { kind: 'declined' };

  const answer = answerFor(answerText, question);

  // Match against the answer alone when one was parsed. Matching the whole
  // result text let an option's words inside the echoed question count as a
  // choice the developer never made.
  const haystack = answer ?? answerText;

  const exact = options.find((option) => haystack.includes(option.label));
  if (exact) return { kind: 'chosen', label: exact.label };

  // Labels sometimes carry a suffix the answer drops, such as "(Recommended)".
  const trimmed = options.find((option) => {
    const bare = option.label.replace(/\s*\([^)]*\)\s*$/, '').trim();
    return bare.length > 0 && haystack.includes(bare);
  });
  if (trimmed) return { kind: 'chosen', label: trimmed.label };

  // A typed answer is a real answer. It is the developer declining every option
  // offered and saying what they wanted instead, which is worth more than the
  // options were.
  if (answer && answer.trim().length > 0) return { kind: 'answered', text: answer.trim() };

  return { kind: 'declined' };
}

/**
 * Pulls this question's answer out of a result that reports every question and
 * answer as `"question"="answer"` pairs.
 *
 * One tool call can carry several questions, so the pair is located by its
 * question rather than by taking the first one.
 */
export function answerFor(resultText: string, question: string): string | null {
  const pairs = [...resultText.matchAll(/"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g)];
  if (pairs.length === 0) return null;

  const unescape = (value: string) => value.replace(/\\(.)/g, '$1');
  const wanted = question.trim();

  for (const [, asked, given] of pairs) {
    if (asked !== undefined && unescape(asked).trim() === wanted) {
      return given === undefined ? null : unescape(given);
    }
  }

  // A single pair with a question we could not align is still this question's
  // answer, because a one-question call has only one.
  return pairs.length === 1 ? unescape(pairs[0]![2] ?? '') : null;
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
  const taken = fork.outcome.kind === 'chosen' ? fork.outcome.label : null;
  return fork.options
    .filter((option) => option.label !== taken)
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
    const taken = fork.outcome.kind === 'chosen' ? fork.outcome.label : null;
    const options = fork.options
      .map((option) => `     ${option.label === taken ? 'CHOSEN' : '     '} ${option.label}`)
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
