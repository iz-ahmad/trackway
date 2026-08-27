import { Transcript, type MemoryEvent, type SessionDescriptor } from '@trackway/core';
import { sanitize } from '../redact/index.js';

export const ADAPTER_ID = 'transcript';
export const FORMAT_VERSION = '1';

export class InvalidTranscriptError extends Error {
  constructor(readonly detail: string) {
    super(`The transcript is not valid: ${detail}`);
    this.name = 'InvalidTranscriptError';
  }
}

/**
 * Reads a transcript into the same events every other adapter emits.
 *
 * Redaction runs here, exactly as it does on the file-backed adapters. A
 * transcript arriving over a pipe is no more trusted than a session file, and
 * the promise that credentials never reach disk has to hold on every way in.
 */
export function parseTranscript(input: unknown): {
  descriptor: SessionDescriptor;
  events: MemoryEvent[];
} {
  const parsed = Transcript.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    throw new InvalidTranscriptError(`${where}${first?.message ?? 'unrecognized shape'}`);
  }

  const transcript = parsed.data;
  const started = transcript.startedAt ?? new Date(0).toISOString();
  const sessionFile = `${ADAPTER_ID}:${transcript.agent}:${transcript.sessionId}`;

  const events: MemoryEvent[] = [];
  let lastTimestamp = started;
  let offset = 0;

  const push = (
    type: MemoryEvent['type'],
    actorType: 'human' | 'agent',
    payload: unknown,
    at: string,
  ): void => {
    const { value } = sanitize(payload);
    events.push({
      id: `${ADAPTER_ID}:${transcript.sessionId}:${offset}`,
      sessionId: transcript.sessionId,
      timestamp: at,
      type,
      actor:
        actorType === 'human'
          ? { type: 'human', id: 'human:local' }
          : { type: 'agent', id: `agent:${transcript.agent}` },
      payload: value,
      source: { adapter: ADAPTER_ID, sessionFile, offset },
    });
    offset += 1;
  };

  for (const entry of transcript.entries) {
    // Entries without their own time inherit the last one seen, so ordering
    // holds even for a producer that records no timestamps at all.
    const at = entry.at ?? lastTimestamp;
    lastTimestamp = at;

    if (entry.role === 'user') {
      push('user_prompt', 'human', { type: 'user_message', text: entry.text }, at);
      continue;
    }

    if (entry.role === 'assistant') {
      push('agent_message', 'agent', { type: 'assistant_message', text: entry.text }, at);
      continue;
    }

    // A call and its result are one entry to write and two events to read,
    // because that is the shape fork harvesting already understands: it looks
    // for a `tool_use` block and the `tool_result` that answers it.
    const toolUseId = `${transcript.sessionId}-tool-${offset}`;
    push(
      'tool_call',
      'agent',
      {
        message: {
          content: [
            { type: 'tool_use', id: toolUseId, name: entry.name, input: entry.input ?? {} },
          ],
        },
      },
      at,
    );

    if (entry.output !== undefined) {
      push(
        'tool_result',
        'agent',
        {
          message: {
            content: [{ type: 'tool_result', tool_use_id: toolUseId, content: entry.output }],
          },
        },
        at,
      );
    }
  }

  return {
    descriptor: {
      sessionId: transcript.sessionId,
      adapter: ADAPTER_ID,
      sessionFile,
      cwd: transcript.cwd ?? null,
      branch: transcript.branch ?? null,
      lastModified: lastTimestamp,
      formatVersion: FORMAT_VERSION,
    },
    events,
  };
}
