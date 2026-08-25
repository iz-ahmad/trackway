/**
 * Removes model reasoning from parsed content.
 *
 * This is structural, not heuristic. Reasoning blocks are typed by the agent,
 * so they are dropped by type rather than guessed at from their text. That
 * distinction matters: the origin spec forbids storing reasoning traces, and a
 * heuristic filter would be a guarantee we could not actually make.
 *
 * The filter runs at the parse boundary, before anything reaches disk. Reading
 * a session file means reading the reasoning, so nothing downstream can be
 * trusted to drop it later.
 */

/** Content block types that carry model reasoning across supported agents. */
const REASONING_BLOCK_TYPES = new Set([
  'thinking',
  'redacted_thinking',
  'reasoning',
  'reasoning_content',
]);

export function isReasoningBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const type = (block as { type?: unknown }).type;
  return typeof type === 'string' && REASONING_BLOCK_TYPES.has(type);
}

/** Drops reasoning blocks from a content array. */
export function stripReasoningBlocks(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => !isReasoningBlock(block));
}

/**
 * Recursively removes reasoning blocks and reasoning-bearing keys from any
 * value. Applied to whole session entries so no adapter has to remember to.
 */
export function stripReasoningDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => !isReasoningBlock(item)).map(stripReasoningDeep);
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !REASONING_BLOCK_TYPES.has(key))
      .map(([key, val]) => [key, stripReasoningDeep(val)] as const);
    return Object.fromEntries(entries);
  }

  return value;
}

/** True when any reasoning content survives. Used to assert the filter held. */
export function containsReasoning(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => isReasoningBlock(item) || containsReasoning(item));

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, val]) => REASONING_BLOCK_TYPES.has(key) || containsReasoning(val),
    );
  }

  return false;
}
