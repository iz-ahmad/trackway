import type { EventType, MemoryEvent } from '@trackway/core';
import { sanitize } from '../redact/index.js';
import { FORMAT_V1, type RawEntry } from './format.js';

const ADAPTER_ID = 'claude-code';

export interface ParseOptions {
  sessionFile: string;
  sessionId: string;
  fromOffset?: number;
}

interface Mapped {
  type: EventType;
  actorType: 'human' | 'agent';
  payload: unknown;
}

/**
 * A user entry whose content is a plain string is a person typing. A user entry
 * whose content is an array of tool_result blocks is the harness feeding output
 * back to the model. Both arrive as `type: "user"`, so content shape is the
 * only thing that separates a human turn from machine traffic.
 */
function isHumanPrompt(entry: RawEntry): boolean {
  const content = entry.message?.content;
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return !content.some((block) => (block as { type?: string })?.type === 'tool_result');
}

/**
 * Replaces inline image data with a marker.
 *
 * Sessions carry screenshots as base64. Keeping them would grow the event cache
 * by megabytes per session and give the distiller nothing it can use.
 */
function stripImageData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripImageData);

  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    if (node.type === 'image') return { type: 'image', omitted: true };

    return Object.fromEntries(
      Object.entries(node).map(([key, val]) => [key, stripImageData(val)]),
    );
  }

  return value;
}

function blockTypes(entry: RawEntry): string[] {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  return content.map((block) => String((block as { type?: unknown })?.type ?? ''));
}

function mapEntry(entry: RawEntry): Mapped | null {
  const type = typeof entry.type === 'string' ? entry.type : '';
  const content = entry.message?.content;

  switch (type) {
    case 'user': {
      if (isHumanPrompt(entry)) {
        return { type: 'user_prompt', actorType: 'human', payload: { content } };
      }
      return { type: 'tool_result', actorType: 'agent', payload: { content, result: entry.toolUseResult } };
    }

    case 'assistant': {
      const types = blockTypes(entry);
      if (types.includes('tool_use')) {
        return { type: 'tool_call', actorType: 'agent', payload: { content } };
      }
      // A message that was only reasoning has nothing left once reasoning is
      // stripped, so it produces no event at all.
      if (types.length > 0 && types.every((blockType) => blockType === 'thinking')) {
        return null;
      }
      return { type: 'agent_message', actorType: 'agent', payload: { content } };
    }

    case 'file-history-snapshot':
    case 'file-history-delta':
      return { type: 'file_change', actorType: 'agent', payload: { snapshot: entry.snapshot } };

    default:
      return null;
  }
}

function timestampOf(entry: RawEntry, fallback: string): string {
  const raw = entry.timestamp;
  if (typeof raw !== 'string') return fallback;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

/**
 * Turns raw entries into normalized events.
 *
 * Sanitization runs here rather than downstream. Reading a session file means
 * reading the reasoning and whatever the agent read from disk, so the filter
 * has to sit at the boundary where content first enters the system.
 */
export function parseEntries(entries: readonly RawEntry[], options: ParseOptions): MemoryEvent[] {
  const events: MemoryEvent[] = [];
  const from = options.fromOffset ?? -1;
  let lastTimestamp = new Date(0).toISOString();

  entries.forEach((entry, offset) => {
    if (offset <= from) return;

    // Subagent traffic is a different conversation. Including it would mix a
    // subagent's decisions into the parent session's record.
    if (entry.isSidechain === true) return;
    if (entry.isMeta === true) return;

    const mapped = mapEntry(entry);
    if (!mapped) return;

    const timestamp = timestampOf(entry, lastTimestamp);
    lastTimestamp = timestamp;

    const { value } = sanitize(stripImageData(mapped.payload));

    events.push({
      id: `${ADAPTER_ID}:${options.sessionId}:${offset}`,
      sessionId: options.sessionId,
      timestamp,
      type: mapped.type,
      actor:
        mapped.actorType === 'human'
          ? { type: 'human', id: 'human:local' }
          : { type: 'agent', id: 'agent:claude-code' },
      payload: value,
      source: { adapter: ADAPTER_ID, sessionFile: options.sessionFile, offset },
    });
  });

  return events;
}

export { ADAPTER_ID as CLAUDE_CODE_ADAPTER_ID, FORMAT_V1 as CLAUDE_CODE_FORMAT };
