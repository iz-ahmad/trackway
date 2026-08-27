import { defaultRegistry } from '@backstory/adapters';
import {
  attributeToPeople,
  commitsBetween,
  currentIdentity,
  DEFAULT_GRACE_MINUTES,
  isRepository,
  linkCommits,
  upsertRecords,
  writeRecords,
  type MemoryRecord,
} from '@backstory/core';
import {
  ClaudeDistillRunner,
  createDistiller,
  purgeCache,
  runSweep,
  type SweepResult,
} from '@backstory/distill';
import { isolate } from '@backstory/core';
import { join } from 'node:path';
import { openWorkspaceIndex, type Workspace } from './workspace.js';

export interface SyncResult {
  sweep: SweepResult;
  written: number;
  skippedExisting: number;
  purgedCacheFiles: number;
}

export interface SyncOptions {
  maxSessions?: number;
  now?: Date;
}

/**
 * Sweep, distil, write records, update the index.
 *
 * Nothing here throws. This runs from `backstory sync`, from every other
 * command as a self-heal, and from an agent hook, and in all three cases a
 * failure must be reported rather than raised. Interrupting the developer's
 * coding session is the one outcome this system must never cause.
 */
const EMPTY: SyncResult = {
  sweep: { swept: [], skipped: [], failures: [], deferred: 0 },
  written: 0,
  skippedExisting: 0,
  purgedCacheFiles: 0,
};

export async function sync(workspace: Workspace, options: SyncOptions = {}): Promise<SyncResult> {
  return isolate(() => runSync(workspace, options), EMPTY, {
    operation: 'sync',
    logPath: join(workspace.cacheDir, 'failures.log'),
  });
}

async function runSync(workspace: Workspace, options: SyncOptions): Promise<SyncResult> {
  const registry = defaultRegistry();
  const distill = createDistiller({ runner: new ClaudeDistillRunner() });

  const sweep = await runSweep(registry, distill, {
    cacheDir: workspace.cacheDir,
    quietWindowMinutes: workspace.config.quietWindowMinutes,
    repoRoot: workspace.repoRoot,
    ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const distilled = sweep.swept.flatMap((session) => session.records);

  // Linking is derived from history that already exists, so it runs on every
  // record rather than only on ones written while a hook was installed. It is
  // also allowed to fail: a repository with no commits, or none at all, still
  // has a usable record. Attribution follows the link, because a commit author
  // is what the repository itself says about who was working.
  const records = await linkAndAttribute(workspace, distilled);

  // Persisting is isolated separately from sweeping. A locked index or an
  // unwritable store must not discard the sweep that already succeeded.
  const { written, skipped } = await isolate(
    () => persist(workspace, records),
    { written: 0, skipped: 0 },
    { operation: 'persist', logPath: join(workspace.cacheDir, 'failures.log') },
  );

  const purge = await purgeCache(
    workspace.cacheDir,
    workspace.config.cacheRetentionDays,
    options.now ?? new Date(),
  ).catch(() => ({ purged: 0, kept: 0 }));

  return { sweep, written, skippedExisting: skipped, purgedCacheFiles: purge.purged };
}

/**
 * Attaches commits and the person behind them.
 *
 * Retroactive on purpose. A `post-commit` hook can only link commits made after
 * someone installed it; matching a record's own timestamp against the log links
 * everything already in the repository, so a first run is useful immediately.
 */
async function linkAndAttribute(
  workspace: Workspace,
  records: readonly MemoryRecord[],
): Promise<MemoryRecord[]> {
  if (records.length === 0) return [];

  try {
    if (!(await isRepository(workspace.repoRoot))) return [...records];

    const times = records.map((record) => Date.parse(record.createdAt)).filter(Number.isFinite);
    if (times.length === 0) return [...records];

    const since = new Date(Math.min(...times));
    const until = new Date(Math.max(...times) + DEFAULT_GRACE_MINUTES * 60_000);

    const commits = await commitsBetween(workspace.repoRoot, since, until);
    const identity = await currentIdentity(workspace.repoRoot);

    return attributeToPeople(linkCommits(records, commits), identity);
  } catch {
    // Every part of this is an enrichment. None of it is worth losing a sweep.
    return [...records];
  }
}

/**
 * Writes records to disk, then indexes them.
 *
 * Files first, index second. The index is derived state, so a crash between the
 * two costs a rebuild rather than a lost record.
 */
export async function persist(
  workspace: Workspace,
  records: readonly MemoryRecord[],
): Promise<{ written: number; skipped: number }> {
  if (records.length === 0) return { written: 0, skipped: 0 };

  const results = await writeRecords(workspace.recordsDir, records);

  // Records sharing an identity collapse onto one file, which is the intended
  // dedup. Counting write attempts reported 113 for 101 files; count distinct
  // records instead.
  const written = new Set(results.filter((result) => result.written).map((r) => r.id)).size;

  const db = openWorkspaceIndex(workspace);
  try {
    upsertRecords(db, records);
  } finally {
    db.close();
  }

  return { written, skipped: results.length - written };
}
