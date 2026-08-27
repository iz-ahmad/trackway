import { z } from 'zod';

/**
 * The transcript format any agent can be piped in as.
 *
 * Every adapter so far reads a store somebody else designed, which means an
 * agent is supported only once its format has been reverse-engineered and, more
 * to the point, once there is a machine with that agent installed to verify the
 * parser against. That is a real ceiling: Cursor keeps its history in an
 * undocumented SQLite database, and guessing at it is how a parser ships broken.
 *
 * This is the way in that needs none of that. It is small enough to produce
 * from a shell script and strict enough that a malformed transcript is refused
 * with a reason rather than half-read.
 */

/** One turn. `tool` carries both sides of a call, because they arrive together. */
export const TranscriptEntry = z.discriminatedUnion('role', [
  z.strictObject({
    role: z.literal('user'),
    text: z.string().min(1),
    at: z.iso.datetime({ offset: true }).optional(),
  }),
  z.strictObject({
    role: z.literal('assistant'),
    text: z.string().min(1),
    at: z.iso.datetime({ offset: true }).optional(),
  }),
  z.strictObject({
    role: z.literal('tool'),
    name: z.string().min(1),
    /**
     * Whatever the tool was called with.
     *
     * Worth care rather than an afterthought. A tool named `AskUserQuestion`,
     * `ask_question` or `request_user_input` whose input carries
     * `questions[].options[]` is read as a recorded fork: the question, every
     * option and each option's own reasoning are taken verbatim, with no model
     * involved and nothing inferred. That path is the most accurate thing this
     * product has, and an adapter that shapes its option lists this way gets it
     * for free.
     */
    input: z.unknown().optional(),
    output: z.string().optional(),
    at: z.iso.datetime({ offset: true }).optional(),
  }),
]);

export const Transcript = z.strictObject({
  /**
   * Which agent produced this. Free text, recorded on every record so a reader
   * can tell where a decision came from.
   */
  agent: z.string().min(1),
  /**
   * Stable identifier for this conversation. Re-ingesting the same id is a
   * no-op rather than a duplicate, because record IDs derive from content and
   * the session it came from.
   */
  sessionId: z.string().min(1),
  /** Absolute path of the repository this happened in. */
  cwd: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  /** Fallback for entries with no `at` of their own. */
  startedAt: z.iso.datetime({ offset: true }).optional(),
  entries: z.array(TranscriptEntry).min(1),
});

export type TranscriptEntry = z.infer<typeof TranscriptEntry>;
export type Transcript = z.infer<typeof Transcript>;
