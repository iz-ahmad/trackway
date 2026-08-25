import { UnknownFormatError } from '../contract.js';

/**
 * Session files are JSON Lines, one entry per line, exactly one session per
 * file. Confirmed against real sessions: a `/clear` starts a new file and
 * leaves the previous one complete on disk.
 */
export const FORMAT_V1 = 'claude-code/jsonl-v1';

/** Entry types seen in real sessions. Unknown types are skipped, not refused. */
export const KNOWN_ENTRY_TYPES = new Set([
  'user',
  'assistant',
  'attachment',
  'system',
  'summary',
  'ai-title',
  'last-prompt',
  'mode',
  'permission-mode',
  'file-history-snapshot',
  'file-history-delta',
]);

/** Fields that must be present for a file to be recognized as this format. */
const REQUIRED_FIELDS = ['type', 'uuid'] as const;

export interface RawEntry {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  version?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  message?: { role?: unknown; content?: unknown } | undefined;
  toolUseResult?: unknown;
  [key: string]: unknown;
}

/**
 * Decides whether a file is a session we know how to read.
 *
 * Refusing an unrecognized shape is the point. Guessing at an unfamiliar format
 * writes wrong records, and a wrong record is worse than a missing one because
 * nothing downstream can tell it apart from a correct one.
 */
export function detectFormat(entries: readonly RawEntry[], sessionFile: string): string {
  if (entries.length === 0) {
    throw new UnknownFormatError('claude-code', sessionFile, 'file contains no parseable entries');
  }

  const withFields = entries.find((entry) =>
    REQUIRED_FIELDS.every((field) => entry[field] !== undefined),
  );

  if (!withFields) {
    throw new UnknownFormatError(
      'claude-code',
      sessionFile,
      `no entry carries the expected fields (${REQUIRED_FIELDS.join(', ')})`,
    );
  }

  const recognized = entries.filter(
    (entry) => typeof entry.type === 'string' && KNOWN_ENTRY_TYPES.has(entry.type),
  );

  if (recognized.length === 0) {
    const seen = [...new Set(entries.map((entry) => String(entry.type)))].slice(0, 5).join(', ');
    throw new UnknownFormatError(
      'claude-code',
      sessionFile,
      `no recognized entry types (saw: ${seen})`,
    );
  }

  return FORMAT_V1;
}

/**
 * Parses JSON Lines, tolerating a truncated final line.
 *
 * A session file is appended to while the agent runs, so reading one that is
 * still being written can catch a partial last line. That is normal, not
 * corruption: every complete line before it is still valid.
 */
export function parseLines(contents: string): { entries: RawEntry[]; truncatedTail: boolean } {
  const lines = contents.split('\n');
  const entries: RawEntry[] = [];
  let truncatedTail = false;

  lines.forEach((line, position) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    try {
      entries.push(JSON.parse(trimmed) as RawEntry);
    } catch {
      if (position === lines.length - 1) {
        truncatedTail = true;
        return;
      }
      // A malformed line in the middle is skipped. One bad line must not cost
      // us the rest of the session.
    }
  });

  return { entries, truncatedTail };
}
