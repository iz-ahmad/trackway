import type { MemoryRecord } from '../models/record.js';
import type { Commit } from './repo.js';

/**
 * How long after a record's own window a commit still counts as its work.
 *
 * Work and the commit that captures it are minutes to hours apart, not days.
 * Four hours covers a long afternoon on one problem without swallowing the
 * next morning's unrelated commit.
 */
export const DEFAULT_GRACE_MINUTES = 240;

/**
 * How many commits one record may claim.
 *
 * A record that links to twenty commits has told the reader nothing. Past a
 * handful, the link is describing a working session rather than a decision.
 */
export const MAX_COMMITS_PER_RECORD = 5;

export interface LinkOptions {
  graceMinutes?: number;
  maxPerRecord?: number;
}

/**
 * Attaches the commits a record's work produced.
 *
 * This is derived rather than captured, which is the whole point. A tool that
 * hooks `post-commit` knows the link only for commits made after it was
 * installed. Matching a record's own time window against the repository's
 * history works on every commit already in it, so a repository gets its
 * decision trail on the first run rather than in three months.
 *
 * The match is time, not content. Reading a diff to decide whether a commit
 * implements a decision needs a model and would be wrong often enough to be
 * worse than nothing; when a decision was made and when it landed are both
 * facts already on disk.
 */
export function linkCommits(
  records: readonly MemoryRecord[],
  commits: readonly Commit[],
  options: LinkOptions = {},
): MemoryRecord[] {
  if (commits.length === 0) return [...records];

  const grace = (options.graceMinutes ?? DEFAULT_GRACE_MINUTES) * 60_000;
  const limit = options.maxPerRecord ?? MAX_COMMITS_PER_RECORD;

  const dated = commits
    .map((commit) => ({ commit, at: Date.parse(commit.authoredAt) }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at);

  return records.map((record) => {
    const madeAt = Date.parse(record.createdAt);
    if (!Number.isFinite(madeAt)) return record;

    // A record is dated at the end of the region it came from, so the commit
    // that carries it lands at or after that moment, never before.
    const matched = dated
      .filter((entry) => entry.at >= madeAt && entry.at <= madeAt + grace)
      .slice(0, limit)
      .map((entry) => entry.commit);

    if (matched.length === 0) return record;

    return {
      ...record,
      commits: matched.map((commit) => ({
        sha: commit.sha,
        subject: commit.subject,
        authoredAt: commit.authoredAt,
        author: commit.author,
        authorEmail: commit.authorEmail,
      })),
    };
  });
}

/**
 * Names the person a record's work belongs to.
 *
 * A commit author is the strongest evidence available: it is what the
 * repository itself records about who was working, and unlike a machine's git
 * config it stays right when the record is read on someone else's machine.
 *
 * `fallback` is that machine's config, for records no commit claimed.
 */
export function authorOf(
  record: MemoryRecord,
  fallback: { name: string; email: string } | null,
): { id: string; name: string } | null {
  const commit = record.commits[0];
  if (commit && commit.authorEmail) {
    return { id: `human:${commit.authorEmail}`, name: commit.author };
  }
  if (fallback?.email) return { id: `human:${fallback.email}`, name: fallback.name };
  return null;
}

/**
 * Rewrites `human:local` into a named person wherever the evidence supports it.
 *
 * Every record written before authorship existed says `human:local`, which is
 * true and useless: it means "somebody at this machine". Records keep that
 * value when nothing better is known rather than inventing a name.
 */
export function attributeToPeople(
  records: readonly MemoryRecord[],
  fallback: { name: string; email: string } | null,
): MemoryRecord[] {
  return records.map((record) => {
    const person = authorOf(record, fallback);
    if (!person) return record;

    if (record.type === 'question') {
      if (record.actor.type !== 'human') return record;
      return { ...record, actor: { ...record.actor, id: person.id, name: person.name } };
    }

    if (record.type !== 'decision') return record;

    const { proposedBy, acceptedBy } = record.attribution;
    return {
      ...record,
      attribution: {
        proposedBy:
          proposedBy.type === 'human'
            ? { ...proposedBy, id: person.id, name: person.name }
            : proposedBy,
        acceptedBy:
          acceptedBy !== 'implicit' && acceptedBy.type === 'human'
            ? { ...acceptedBy, id: person.id, name: person.name }
            : acceptedBy,
      },
    };
  });
}
