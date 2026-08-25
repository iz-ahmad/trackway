import { DistillationResult, type MemoryRecord, flattenResult, withDerivedId } from '@backstory/core';
import { z } from 'zod';

/**
 * What the model is asked to return.
 *
 * Deliberately looser than the stored record: the model supplies content and
 * attribution, and everything derivable is filled in afterwards. Asking a model
 * to produce IDs, offsets, and timestamps invites it to invent them, and an
 * invented provenance field is worse than a missing one.
 */
const RawAlternative = z.strictObject({
  choice: z.string().min(1),
  status: z.enum(['rejected', 'considered']),
  reason: z.string().min(1),
  condition: z.string().nullable().default(null),
});

const RawActor = z.strictObject({
  type: z.enum(['human', 'agent']),
  id: z.string().min(1).default('unknown'),
});

const RawAttribution = z.strictObject({
  proposedBy: RawActor,
  acceptedBy: z.union([RawActor, z.literal('implicit')]),
});

export const RawDistillation = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        question: z.string().min(1),
        answer: z.string().nullable().default(null),
        status: z.enum(['open', 'resolved']),
        actor: RawActor,
      }),
    )
    .default([]),
  discoveries: z.array(z.strictObject({ text: z.string().min(1) })).default([]),
  decisions: z
    .array(
      z.strictObject({
        question: z.string().min(1),
        choice: z.string().min(1),
        reason: z.string().min(1),
        alternatives: z.array(RawAlternative).default([]),
        attribution: RawAttribution,
      }),
    )
    .default([]),
  actions: z
    .array(
      z.strictObject({
        description: z.string().min(1),
        status: z.enum(['completed', 'partial', 'failed']),
        files: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  outcomes: z
    .array(
      z.strictObject({
        text: z.string().min(1),
        result: z.enum(['passed', 'failed', 'unresolved']),
      }),
    )
    .default([]),
});

export type RawDistillation = z.infer<typeof RawDistillation>;

export class InvalidDistillationError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(`${message}: ${detail}`);
    this.name = 'InvalidDistillationError';
  }
}

export interface Provenance {
  sessionId: string;
  adapter: string;
  sessionFile: string;
  fromOffset: number;
  toOffset: number;
  createdAt: string;
}

/**
 * Pulls a JSON object out of model output.
 *
 * Models wrap JSON in prose or fences even when told not to. Recovering the
 * object is cheap; rejecting the whole batch because of a stray "Here is the
 * JSON:" would throw away real extraction for a formatting slip.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // Fall through to brace matching.
  }

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new InvalidDistillationError('no JSON object found in output', candidate.slice(0, 200));
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (cause) {
    throw new InvalidDistillationError('output was not valid JSON', String(cause).slice(0, 200));
  }
}

/**
 * Validates model output and turns it into records.
 *
 * The batch is rejected whole rather than partially accepted. A model that got
 * one record's shape wrong is not trustworthy for the rest of that response,
 * and half-written memory is harder to notice than none.
 */
export function toRecords(text: string, provenance: Provenance): MemoryRecord[] {
  const parsed = RawDistillation.safeParse(extractJsonObject(text));

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .slice(0, 5)
      .join('; ');
    throw new InvalidDistillationError('model output did not match the record schema', detail);
  }

  const source = {
    adapter: provenance.adapter,
    sessionId: provenance.sessionId,
    sessionFile: provenance.sessionFile,
    fromOffset: provenance.fromOffset,
    toOffset: provenance.toOffset,
  };

  const base = {
    sessionId: provenance.sessionId,
    episodeId: null,
    createdAt: provenance.createdAt,
    source,
  };

  const raw = parsed.data;

  const result = DistillationResult.parse({
    questions: raw.questions.map((q) => withDerivedId({ ...base, type: 'question' as const, ...q })),
    discoveries: raw.discoveries.map((d) =>
      withDerivedId({ ...base, type: 'discovery' as const, ...d }),
    ),
    decisions: raw.decisions.map((d) =>
      withDerivedId({
        ...base,
        type: 'decision' as const,
        ...d,
        status: 'accepted' as const,
        supersededBy: null,
        relationships: [],
      }),
    ),
    actions: raw.actions.map((a) => withDerivedId({ ...base, type: 'action' as const, ...a })),
    outcomes: raw.outcomes.map((o) => withDerivedId({ ...base, type: 'outcome' as const, ...o })),
  });

  return flattenResult(result);
}
