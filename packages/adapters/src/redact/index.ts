import { redactDeep, type Redaction } from './secrets.js';
import { stripReasoningDeep } from './thinking.js';

export * from './secrets.js';
export * from './thinking.js';

export interface SanitizeResult {
  value: unknown;
  redactions: Redaction[];
}

/**
 * The parse boundary filter. Every adapter runs session content through this
 * before emitting events, so nothing downstream can leak reasoning or secrets.
 *
 * `skipSecrets` is for adapters whose agent already redacts, such as OpenCode's
 * export. Running our pass again would only risk double-redacting text that is
 * already a placeholder.
 */
export function sanitize(value: unknown, options: { skipSecrets?: boolean } = {}): SanitizeResult {
  const withoutReasoning = stripReasoningDeep(value);

  if (options.skipSecrets) {
    return { value: withoutReasoning, redactions: [] };
  }

  const { value: redacted, redactions } = redactDeep(withoutReasoning);
  return { value: redacted, redactions };
}
