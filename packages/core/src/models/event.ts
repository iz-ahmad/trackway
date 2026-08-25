import { z } from 'zod';
import { ActorRef } from './actor.js';

/**
 * The normalized event every adapter emits. Adapters differ in how they read
 * sessions. Core never sees that difference.
 */
export const EventType = z.enum([
  'session_start',
  'user_prompt',
  'agent_message',
  'tool_call',
  'tool_result',
  'file_change',
  'error',
  'session_end',
]);

/**
 * Where an event came from. `offset` is the position within the session file,
 * which is what watermarks advance over and what record IDs hash.
 */
export const EventSource = z.strictObject({
  adapter: z.string().min(1),
  sessionFile: z.string().min(1),
  offset: z.number().int().nonnegative(),
});

export const MemoryEvent = z.strictObject({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
  type: EventType,
  actor: ActorRef,
  /** Adapter-shaped content. Core does not interpret it; the distiller does. */
  payload: z.unknown(),
  source: EventSource,
});

/**
 * What an adapter reports about a session before anything is read from it.
 * The sweep decides eligibility from this alone, without parsing content.
 */
export const SessionDescriptor = z.strictObject({
  sessionId: z.string().min(1),
  adapter: z.string().min(1),
  sessionFile: z.string().min(1),
  /** Working directory the session ran in. Used to match sessions to a repo. */
  cwd: z.string().nullable(),
  branch: z.string().nullable(),
  lastModified: z.iso.datetime({ offset: true }),
  /** Adapter-declared format version. An unrecognized value is refused, not guessed at. */
  formatVersion: z.string().min(1),
});

export type EventType = z.infer<typeof EventType>;
export type EventSource = z.infer<typeof EventSource>;
export type MemoryEvent = z.infer<typeof MemoryEvent>;
export type SessionDescriptor = z.infer<typeof SessionDescriptor>;
