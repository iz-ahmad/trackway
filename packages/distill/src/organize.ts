import type { MemoryRecord } from '@backstory/core';
import { z } from 'zod';
import type { DistillRunner } from './runner/contract.js';
import { extractJsonObject } from './runner/validate.js';

const Organization = z.strictObject({
  episodes: z.array(
    z.strictObject({
      id: z.string().min(1),
      title: z.string().min(1),
      recordIndexes: z.array(z.number().int().min(0)),
    }),
  ),
  significance: z
    .record(z.string(), z.enum(['business', 'technical', 'direction', 'working']))
    .default({}),
});

export interface Episode {
  id: string;
  title: string;
  recordIds: string[];
}

export interface OrganizeResult {
  records: MemoryRecord[];
  episodes: Episode[];
}

/**
 * Groups records into topics and classifies what each one is.
 *
 * Runs over a whole session at once rather than per chunk, because a topic
 * spans chunks and neither grouping nor altitude can be judged from a slice.
 *
 * Both jobs are one call. They need the same input and the same reading of what
 * the session was about, so splitting them would pay twice for one judgement.
 */
export async function organizeSession(
  runner: DistillRunner,
  records: readonly MemoryRecord[],
): Promise<OrganizeResult> {
  if (records.length === 0) return { records: [], episodes: [] };

  const output = await runner.run(buildOrganizePrompt(records));

  let parsed: unknown;
  try {
    parsed = extractJsonObject(output);
  } catch {
    return { records: [...records], episodes: [] };
  }

  const result = Organization.safeParse(parsed);
  if (!result.success) return { records: [...records], episodes: [] };

  const assigned = result.data.significance;
  const episodeOf = new Map<number, string>();
  const episodes: Episode[] = [];

  for (const episode of result.data.episodes) {
    const ids: string[] = [];

    for (const index of episode.recordIndexes) {
      const record = records[index];
      if (!record) continue;
      // First claim wins, so a record cannot appear under two topics.
      if (episodeOf.has(index)) continue;
      episodeOf.set(index, episode.id);
      ids.push(record.id);
    }

    if (ids.length > 0) episodes.push({ id: episode.id, title: episode.title, recordIds: ids });
  }

  const updated = records.map((record, index) => ({
    ...record,
    episodeId: episodeOf.get(index) ?? null,
    // Anything the pass did not classify stays demoted rather than promoted.
    significance: assigned[String(index)] ?? record.significance,
  }));

  return { records: updated, episodes };
}

/** How the developer figured in a record, when the record knows. */
function involvement(record: MemoryRecord): string | null {
  if (record.type === 'decision') {
    const { proposedBy, acceptedBy } = record.attribution;
    if (acceptedBy === 'implicit') return 'agent decided alone';
    if (proposedBy.type === 'human') return 'developer directed';
    if (acceptedBy.type === 'human') return 'developer approved';
    return 'agent decided alone';
  }

  if (record.type === 'question') {
    return record.actor.type === 'human' ? 'developer asked' : 'agent asked';
  }

  return null;
}

export function buildOrganizePrompt(records: readonly MemoryRecord[]): string {
  const lines = records.map((record, index) => {
    const subject =
      record.type === 'decision'
        ? `${record.question} -> ${record.choice}`
        : record.type === 'question'
          ? record.question
          : record.type === 'action'
            ? record.description
            : record.text;

    // Whether a person was involved is the strongest available evidence, and
    // it is recorded rather than inferred. Withholding it forces the model to
    // guess at the one thing the data already knows.
    const who = involvement(record);

    return `${index}. [${record.type}${who ? ` | ${who}` : ''}] ${subject
      .replace(/\s+/g, ' ')
      .slice(0, 180)}`;
  });

  return `You are organising the memory of one software development session.

Two jobs.

FIRST: group the records into topics. A topic is a coherent piece of work the
session spent time on, the kind of thing a person would name when asked what
they worked on. Aim for between three and twelve topics. Every record belongs to
exactly one. Order topics by when their work started.

Title each topic in three to five plain words describing the work, not the
outcome. "Credential redaction" rather than "Fixed redaction bugs".

SECOND: classify every record into one of four kinds.

"business"  — what the product should do, for whom, and why. Product logic
              decided or learned. Still true after a full rewrite. This is the
              only kind an agent may have arrived at alone and still keep,
              because a fact about the domain is valuable whoever found it.
"technical" — an architecture-shaping choice THE DEVELOPER MADE OR APPROVED.
              What the system supports, which approach it takes, what ships.
              A choice the agent made alone is not this, however clever, unless
              it changed the architecture.
"direction" — an instruction the developer gave that steered the work.
"working"   — everything else the agent decided while executing: parse
              strategy, data shapes, hash contents, streaming, regular
              expressions, naming, which file to read.

Each record is tagged with how the developer figured in it. Use that first, it
is recorded rather than guessed:

  "developer directed"   -> direction
  "developer approved"   -> technical, or business if it is about the product
  "developer asked"      -> direction or business
  "agent decided alone"  -> working, unless it is a fact about the domain
                            (business) or it changed the architecture

Expect two thirds or more to be "working". A session of real engineering
produces far more execution detail than project history.

When torn, choose "working". Wrongly promoting a detail buries what matters,
and the whole purpose is a view a person can read.

RECORDS
${lines.join('\n')}

Return ONLY this JSON, no prose. Every record index must appear in
"significance", keyed by its number as a string:
{"episodes":[{"id":"ep-1","title":"Credential redaction","recordIndexes":[3,7,12]}],
 "significance":{"0":"technical","1":"working","2":"direction"}}`;
}
