import { z } from 'zod';

/**
 * Who did a thing. Backstory must never claim a human approved something they
 * never saw, so attribution is modelled explicitly rather than inferred.
 */
export const ActorRef = z.strictObject({
  type: z.enum(['human', 'agent']),
  id: z.string().min(1),
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
