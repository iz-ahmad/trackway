import type { MemoryEvent } from '@backstory/core';

const MAX_TEXT_PER_EVENT = 1200;

/**
 * The extraction prompt.
 *
 * Written for precision over volume. The failure mode that kills this product
 * is not missing a decision, it is filling someone's repository with records
 * they did not ask for and would not defend in review. So the instruction is
 * to skip aggressively, and to leave the batch empty when a session was routine
 * work.
 *
 * Attribution is spelled out because getting it wrong is worse than omitting
 * it: recording that a person approved something they never saw makes the whole
 * store untrustworthy.
 */
export const EXTRACTION_INSTRUCTIONS = `You extract durable engineering memory from a coding-agent session.

Return ONLY a JSON object. No prose before or after it, no markdown fences.

Shape:
{
  "questions":   [{ "question": str, "answer": str|null, "status": "open"|"resolved",
                    "actor": { "type": "human"|"agent", "id": str } }],
  "discoveries": [{ "text": str }],
  "decisions":   [{ "question": str, "choice": str, "reason": str,
                    "alternatives": [{ "choice": str, "status": "rejected"|"considered",
                                       "reason": str, "condition": str|null }],
                    "attribution": { "proposedBy": { "type": ..., "id": str },
                                     "acceptedBy": { "type": ..., "id": str } | "implicit" } }],
  "actions":     [{ "description": str, "status": "completed"|"partial"|"failed", "files": [str] }],
  "outcomes":    [{ "text": str, "result": "passed"|"failed"|"unresolved" }]
}

WHAT TO RECORD

Record something only if a developer returning in six weeks would be helped by
it. Most of a session is not that. An empty array is the correct answer far more
often than a full one, and returning all five arrays empty is a valid response.

Record:
- Decisions where a real choice was made between options that mattered.
- Rejected alternatives, with WHY each was dropped. This is the most valuable
  thing you can capture. Commit history records what was built; nothing records
  what was considered and discarded.
- Discoveries: facts learned about the system that were not obvious beforehand
  and would change how someone approaches related work.
- Questions that shaped the work, especially ones left unresolved.
- Actions only when they carry intent that the diff alone does not.
- Outcomes only when they resolve something that was genuinely in doubt.

Do NOT record:
- Routine file reading, searching, or navigation.
- Restating what the code already says.
- Obvious next steps, or narration of what is about to happen.
- Trivial or mechanical choices: formatting, naming with no consequence,
  which of two equivalent helpers to call.
- The same decision more than once, however many times it was discussed.
- Anything you are inferring rather than observing. If the session does not
  show it, it did not happen.

CONDITIONS ON REJECTED OPTIONS

When an option was dropped for a reason that could stop being true, put that
reason in "condition" as a plain checkable statement.

  reason:    "Redis would be another service to run and we do not have one yet."
  condition: "Redis is not deployed in this project"

When the reason is a permanent property rather than a current circumstance,
leave condition null.

ATTRIBUTION

Getting this wrong is worse than leaving it out.

- The agent suggested and the person agreed → proposedBy agent, acceptedBy human.
- The person directed it → proposedBy human, acceptedBy human.
- The agent decided and simply proceeded, with no human response → acceptedBy
  MUST be the string "implicit". Never record a human acceptance that did not
  happen.
- Use "human:local" for the developer and "agent:<name>" for the agent.

REASONING

The session contains no model reasoning; it has been removed before you see it.
Do not reconstruct, infer, or invent it. Record only what was said and done.`;

export interface PromptInput {
  events: readonly MemoryEvent[];
  adapterId: string;
  /** Set when a session was split, so the model knows it is seeing a slice. */
  part?: { index: number; total: number };
}

/**
 * Renders events into the transcript the model reads.
 *
 * Each event is truncated. Whole tool outputs can run to tens of thousands of
 * characters, and the decision-bearing content is almost always near the start.
 */
export function renderTranscript(events: readonly MemoryEvent[]): string {
  return events
    .map((event) => {
      const who = event.actor.type === 'human' ? 'DEVELOPER' : 'AGENT';
      return `[${event.type} | ${who}]\n${summarizePayload(event.payload)}`;
    })
    .join('\n\n');
}

function summarizePayload(payload: unknown): string {
  const text = collectText(payload).join('\n').trim();
  if (text.length === 0) return '(no text content)';
  return text.length > MAX_TEXT_PER_EVENT
    ? `${text.slice(0, MAX_TEXT_PER_EVENT)}\n… (truncated)`
    : text;
}

/** Pulls human-readable strings out of an adapter-shaped payload. */
function collectText(value: unknown, depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectText(item, depth + 1));

  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    const interesting = ['text', 'content', 'message', 'command', 'description', 'output', 'name'];

    const found = interesting.flatMap((key) =>
      key in node ? collectText(node[key], depth + 1) : [],
    );

    return found.length > 0 ? found : [];
  }

  return [];
}

export function buildPrompt(input: PromptInput): string {
  const transcript = renderTranscript(input.events);

  const partNote = input.part
    ? `\n\nThis is part ${input.part.index} of ${input.part.total} of one session. Record only what this part shows. Earlier and later parts are handled separately, so do not speculate about what came before or after.`
    : '';

  return `${EXTRACTION_INSTRUCTIONS}${partNote}

SESSION TRANSCRIPT (agent: ${input.adapterId}, ${input.events.length} events)
---
${transcript}
---

Return the JSON object now.`;
}
