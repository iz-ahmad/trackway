import { z } from 'zod';

/**
 * Who did a thing. Backstory must never claim a human approved something they
 * never saw, so attribution is modelled explicitly rather than inferred.
 */
export const ActorRef = z.strictObject({
  type: z.enum(['human', 'agent']),
  /**
   * Stable key. For a human this is `human:<email>` where an email is known,
   * and `human:local` where it is not, which is what every record written
   * before authorship existed still carries.
   */
  id: z.string().min(1),
  /**
   * How to address them on screen. "You" is only true for one reader, and a
   * project has more than one developer in it.
   */
  name: z.string().min(1).optional(),
});

/**
 * `implicit` marks an agent decision that proceeded without explicit human
 * approval. It is a distinct state, not a human acceptance.
 */
export const Acceptance = z.union([ActorRef, z.literal('implicit')]);

export const Attribution = z.strictObject({
  proposedBy: ActorRef,
  acceptedBy: Acceptance,
});

export type ActorRef = z.infer<typeof ActorRef>;
export type Acceptance = z.infer<typeof Acceptance>;
export type Attribution = z.infer<typeof Attribution>;

/** True when a human explicitly accepted, as opposed to an implicit agent decision. */
export function isHumanAccepted(attribution: Attribution): boolean {
  return attribution.acceptedBy !== 'implicit' && attribution.acceptedBy.type === 'human';
}

/** True when the agent proposed and a human accepted. */
export function isHumanOverride(attribution: Attribution): boolean {
  return (
    attribution.proposedBy.type === 'human' &&
    attribution.acceptedBy !== 'implicit' &&
    attribution.acceptedBy.type === 'human'
  );
}
