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

/**
 * What kind of thing a record is, which decides whether it belongs in the
 * project's story or in the agent's working notes.
 *
 * The distinction is the difference between a readable history and a wall.
 * Roughly two thirds of what a session produces is `working`, and showing it
 * alongside the rest buries the part a person came for.
 *
 * - `business`  what the product should do, for whom, and why. Product logic
 *               learned or decided. Survives a rewrite of the codebase.
 * - `technical` an engineering choice that shapes the project: what to support,
 *               which approach, what the architecture is. A developer would
 *               defend it in review.
 * - `direction` an instruction the developer gave that steered the work. Not a
 *               decision the agent made, a decision the agent was handed.
 * - `working`   the agent's own detail while executing: parse strategy, hash
 *               contents, whether to stream a file. Kept, not foregrounded.
 */
export const Significance = z.enum(['business', 'technical', 'direction', 'working']);

/** The kinds a reader wants by default. `working` is everything else. */
export const FOREGROUND_SIGNIFICANCE = ['business', 'technical', 'direction'] as const;

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
  /**
   * Defaults to `working` so an unclassified record is demoted rather than
   * promoted. Wrongly foregrounding noise costs more than wrongly hiding
   * something, because the whole point is a readable default view.
   */
  significance: Significance.default('working'),
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
export type Significance = z.infer<typeof Significance>;
export type Relationship = z.infer<typeof Relationship>;
export type Alternative = z.infer<typeof Alternative>;
export type QuestionRecord = z.infer<typeof QuestionRecord>;
export type DiscoveryRecord = z.infer<typeof DiscoveryRecord>;
export type DecisionRecord = z.infer<typeof DecisionRecord>;
export type ActionRecord = z.infer<typeof ActionRecord>;
export type OutcomeRecord = z.infer<typeof OutcomeRecord>;
export type MemoryRecord = z.infer<typeof MemoryRecord>;
export type DistillationResult = z.infer<typeof DistillationResult>;

/**
 * What a record counts as, once its recorded attribution is taken into account.
 *
 * The classifier is asked to judge significance from text, and it is generous
 * with `technical`: it kept marking an agent's own parse strategy as project
 * history. Attribution already answers the question the classifier is guessing
 * at, so the rule is applied here where it cannot drift between model versions.
 *
 * The developer's involvement is the discriminator. A technical decision is
 * part of the project's story when a person made or approved it. The same
 * choice made by an agent mid-task is working detail, however sound.
 *
 * A domain fact is the exception: it is worth keeping whoever found it, because
 * it describes the problem rather than the work.
 */
export function effectiveSignificance(record: MemoryRecord): Significance {
  if (record.type === 'decision') {
    const { proposedBy, acceptedBy } = record.attribution;

    if (proposedBy.type === 'human') return 'direction';
    if (acceptedBy === 'implicit') {
      return record.significance === 'business' ? 'business' : 'working';
    }
    return record.significance === 'working' ? 'technical' : record.significance;
  }

  if (record.type === 'question') {
    return record.actor.type === 'human' ? 'direction' : record.significance;
  }

  // Discoveries stand on their own: a fact about the domain or the system is
  // useful regardless of who noticed it.
  if (record.type === 'discovery') return record.significance;

  // Actions and outcomes are what git already records, so they stay demoted
  // unless they carry product meaning.
  return record.significance === 'business' ? 'business' : 'working';
}

/** True when a record belongs in the default, readable view. */
export function isForeground(record: MemoryRecord): boolean {
  return (FOREGROUND_SIGNIFICANCE as readonly string[]).includes(
    effectiveSignificance(record),
  );
}

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
