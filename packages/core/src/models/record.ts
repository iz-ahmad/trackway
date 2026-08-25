import { z } from 'zod';
import { ActorRef, Attribution } from './actor.js';

export const RecordType = z.enum(['question', 'discovery', 'decision', 'action', 'outcome']);

/**
 * Provenance back to the session region a record was distilled from. The
 * offset range is what makes record IDs deterministic and re-ingestion a no-op.
 */
export const RecordSource = z.strictObject({
  adapter: z.string().min(1),
  sessionId: z.string().min(1),
  sessionFile: z.string().min(1),
  fromOffset: z.number().int().nonnegative(),
  toOffset: z.number().int().nonnegative(),
});

/** Relationship vocabulary is deliberately small. Five types, no ontology. */
export const Relationship = z.strictObject({
  type: z.enum(['supports', 'influences', 'implements', 'supersedes', 'related_to']),
  targetId: z.string().min(1),
});

/**
 * An option that was raised and not taken. This is the payload users come back
 * for, so the reason is required rather than optional.
 *
 * `condition` holds the reason restated as a checkable fact when the reason was
 * conditional ("Redis is not deployed here"). Nothing acts on it yet. Capturing
 * it now avoids re-processing every record later.
 */
export const Alternative = z.strictObject({
  choice: z.string().min(1),
  status: z.enum(['rejected', 'considered']),
  reason: z.string().min(1),
  condition: z.string().nullable(),
});

const base = {
  id: z.string().min(1),
  sessionId: z.string().min(1),
  episodeId: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  source: RecordSource,
};

export const QuestionRecord = z.strictObject({
  ...base,
  type: z.literal('question'),
  question: z.string().min(1),
  /** Null while unresolved. An unanswered question is kept, not discarded. */
  answer: z.string().nullable(),
  status: z.enum(['open', 'resolved']),
  actor: ActorRef,
});

export const DiscoveryRecord = z.strictObject({
  ...base,
  type: z.literal('discovery'),
  text: z.string().min(1),
});

export const DecisionRecord = z.strictObject({
  ...base,
  type: z.literal('decision'),
  question: z.string().min(1),
  choice: z.string().min(1),
  reason: z.string().min(1),
  alternatives: z.array(Alternative),
  attribution: Attribution,
  status: z.enum(['accepted', 'superseded']),
  supersededBy: z.string().nullable(),
  relationships: z.array(Relationship),
});

export const ActionRecord = z.strictObject({
  ...base,
  type: z.literal('action'),
  description: z.string().min(1),
  status: z.enum(['completed', 'partial', 'failed']),
  files: z.array(z.string()),
});

export const OutcomeRecord = z.strictObject({
  ...base,
  type: z.literal('outcome'),
  text: z.string().min(1),
  result: z.enum(['passed', 'failed', 'unresolved']),
});

export const MemoryRecord = z.discriminatedUnion('type', [
  QuestionRecord,
  DiscoveryRecord,
  DecisionRecord,
  ActionRecord,
  OutcomeRecord,
]);

/**
 * What the distiller returns for one finalized region. Validated wholesale:
 * a single invalid record rejects the batch rather than writing partial output.
 */
export const DistillationResult = z.strictObject({
  questions: z.array(QuestionRecord),
  discoveries: z.array(DiscoveryRecord),
  decisions: z.array(DecisionRecord),
  actions: z.array(ActionRecord),
  outcomes: z.array(OutcomeRecord),
});

export type RecordType = z.infer<typeof RecordType>;
export type RecordSource = z.infer<typeof RecordSource>;
export type Relationship = z.infer<typeof Relationship>;
export type Alternative = z.infer<typeof Alternative>;
export type QuestionRecord = z.infer<typeof QuestionRecord>;
export type DiscoveryRecord = z.infer<typeof DiscoveryRecord>;
export type DecisionRecord = z.infer<typeof DecisionRecord>;
export type ActionRecord = z.infer<typeof ActionRecord>;
export type OutcomeRecord = z.infer<typeof OutcomeRecord>;
export type MemoryRecord = z.infer<typeof MemoryRecord>;
export type DistillationResult = z.infer<typeof DistillationResult>;

/** Flattens a distillation result into one ordered list. */
export function flattenResult(result: DistillationResult): MemoryRecord[] {
  return [
    ...result.questions,
    ...result.discoveries,
    ...result.decisions,
    ...result.actions,
    ...result.outcomes,
  ];
}
