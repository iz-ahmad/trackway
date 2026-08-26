import { defaultRegistry } from '@backstory/adapters';
import { upsertRecords, writeRecords, type MemoryRecord } from '@backstory/core';
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

  const records = sweep.swept.flatMap((session) => session.records);

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
