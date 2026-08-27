import { describe, expect, it } from 'vitest';
import { attributeToPeople, authorOf, linkCommits } from '../src/index.js';
import type { Commit, MemoryRecord } from '../src/index.js';

function commit(sha: string, authoredAt: string, author = 'Ada', email = 'ada@example.com'): Commit {
  return { sha, subject: `work ${sha}`, authoredAt, author, authorEmail: email };
}

function decision(createdAt: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: `dec-${createdAt}`,
    type: 'decision',
    sessionId: 'ses-1',
    episodeId: null,
    commits: [],
    createdAt,
    significance: 'technical',
    source: {
      adapter: 'claude-code',
      sessionId: 'ses-1',
      sessionFile: '/tmp/ses-1.jsonl',
      fromOffset: 0,
      toOffset: 4,
    },
    question: 'Which cache?',
    choice: 'Redis',
    reason: 'Already deployed.',
    alternatives: [],
    attribution: {
      proposedBy: { type: 'agent', id: 'agent:claude-code' },
      acceptedBy: { type: 'human', id: 'human:local' },
    },
    status: 'accepted',
    supersededBy: null,
    relationships: [],
    ...overrides,
  } as MemoryRecord;
}

describe('linking records to the commits they produced', () => {
  it('claims a commit made shortly after the decision', () => {
    const [linked] = linkCommits(
      [decision('2026-08-25T10:00:00Z')],
      [commit('a1', '2026-08-25T10:30:00Z')],
    );

    expect(linked?.commits.map((c) => c.sha)).toEqual(['a1']);
  });

  it('never claims a commit made before the decision', () => {
    // Work cannot land before it was decided, so an earlier commit is somebody
    // else's, and claiming it would put the wrong name on the record too.
    const [linked] = linkCommits(
      [decision('2026-08-25T10:00:00Z')],
      [commit('older', '2026-08-25T09:00:00Z')],
    );

    expect(linked?.commits).toEqual([]);
  });

  it('lets go once the grace period has passed', () => {
    const [linked] = linkCommits(
      [decision('2026-08-25T10:00:00Z')],
      [commit('tomorrow', '2026-08-26T10:00:00Z')],
    );

    expect(linked?.commits).toEqual([]);
  });

  it('caps how many commits one record may claim', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      commit(`c${i}`, new Date(Date.parse('2026-08-25T10:00:00Z') + (i + 1) * 60_000).toISOString()),
    );

    const [linked] = linkCommits([decision('2026-08-25T10:00:00Z')], many);

    expect(linked?.commits).toHaveLength(5);
  });

  it('leaves records alone when the repository has no commits', () => {
    const records = [decision('2026-08-25T10:00:00Z')];

    expect(linkCommits(records, [])).toEqual(records);
  });

  it('survives a record with an unparseable date rather than dropping it', () => {
    const broken = decision('not a date');

    expect(linkCommits([broken], [commit('a1', '2026-08-25T10:30:00Z')])).toEqual([broken]);
  });
});

describe('naming the person behind a record', () => {
  const linked = linkCommits(
    [decision('2026-08-25T10:00:00Z')],
    [commit('a1', '2026-08-25T10:30:00Z', 'Ada Lovelace', 'ada@example.com')],
  );

  it('takes the name from the commit author, not from this machine', () => {
    expect(authorOf(linked[0]!, { name: 'Someone Else', email: 'else@example.com' })).toEqual({
      id: 'human:ada@example.com',
      name: 'Ada Lovelace',
    });
  });

  it('falls back to this machine only when no commit claimed the record', () => {
    expect(authorOf(decision('2026-08-25T10:00:00Z'), { name: 'Ada', email: 'ada@example.com' }))
      .toEqual({ id: 'human:ada@example.com', name: 'Ada' });
  });

  it('names nobody rather than guessing when there is no evidence at all', () => {
    expect(authorOf(decision('2026-08-25T10:00:00Z'), null)).toBeNull();
  });

  it('puts the person on both sides of the attribution', () => {
    const [named] = attributeToPeople(linked, null);

    expect(named?.type === 'decision' && named.attribution.acceptedBy).toEqual({
      type: 'human',
      id: 'human:ada@example.com',
      name: 'Ada Lovelace',
    });
  });

  it('leaves the agent side of an attribution alone', () => {
    const [named] = attributeToPeople(linked, null);

    expect(named?.type === 'decision' && named.attribution.proposedBy).toEqual({
      type: 'agent',
      id: 'agent:claude-code',
    });
  });

  it('keeps human:local when nothing better is known', () => {
    const [named] = attributeToPeople([decision('2026-08-25T10:00:00Z')], null);

    expect(named?.type === 'decision' && named.attribution.acceptedBy).toEqual({
      type: 'human',
      id: 'human:local',
    });
  });
});
