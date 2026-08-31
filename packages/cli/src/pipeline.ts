import { defaultRegistry, parseTranscript } from '@trackway/adapters';
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
} from '@trackway/core';
import {
  ClaudeDistillRunner,
  createDistiller,
  purgeCache,
  runSweep,
  type SweepProgress,
  type SweepResult,
} from '@trackway/distill';
import { isolate } from '@trackway/core';
import { join } from 'node:path';
import { openWorkspaceIndex, type Workspace } from './workspace.js';

export interface SyncResult {
  sweep: SweepResult;
  written: number;
  skippedExisting: number;
  purgedCacheFiles: number;
  /**
   * What went wrong at a level that stopped the sync, rather than one session.
   *
   * Isolation keeps a failure from taking the caller down, but returning the
   * empty result on its own reported the same thing as a clean sweep with
   * nothing to do. A sync that fell over said "Swept 0 session(s)." and left
   * the person running it with nothing to go on.
   */
  errors: string[];
}

export interface SyncOptions {
  maxSessions?: number;
  now?: Date;
  onProgress?: (event: SweepProgress) => void;
}

function empty(): SyncResult {
  return {
    sweep: { swept: [], skipped: [], failures: [], deferred: 0 },
    written: 0,
    skippedExisting: 0,
    purgedCacheFiles: 0,
    errors: [],
  };
}

/**
 * Sweep, distil, write records, update the index.
 *
 * Nothing here throws. This runs from `trackway sync`, from every other
 * command as a self-heal, and from an agent hook, and in all three cases a
 * failure must be reported rather than raised. Interrupting the developer's
 * coding session is the one outcome this system must never cause.
 *
 * Not raising is not the same as not saying. Whatever was swallowed comes back
 * in `errors` for the caller to print.
 */
export async function sync(workspace: Workspace, options: SyncOptions = {}): Promise<SyncResult> {
  const errors: string[] = [];

  const result = await isolate(() => runSync(workspace, options), empty(), {
    operation: 'sync',
    logPath: join(workspace.cacheDir, 'failures.log'),
    onFailure: (failure) => errors.push(failure.message),
  });

  return { ...result, errors: [...result.errors, ...errors] };
}

async function runSync(workspace: Workspace, options: SyncOptions): Promise<SyncResult> {
  const registry = defaultRegistry();
  const distill = createDistiller({ runner: new ClaudeDistillRunner() });

  let written = 0;
  let skipped = 0;

  const sweep = await runSweep(registry, distill, {
    cacheDir: workspace.cacheDir,
    quietWindowMinutes: workspace.config.quietWindowMinutes,
    repoRoot: workspace.repoRoot,
    ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),

    // One session at a time, as it finishes. Holding everything until the last
    // session meant a sweep that was interrupted after twenty minutes kept
    // nothing, and the next run started from the beginning. The sweep treats a
    // throw here as that session failing, so its watermark stays put.
    onSession: async (session) => {
      if (session.records.length === 0) return;

      // Linking is derived from history that already exists, so it runs on
      // every record rather than only on ones written while a hook was
      // installed. It is also allowed to fail: a repository with no commits, or
      // none at all, still has a usable record. Attribution follows the link,
      // because a commit author is what the repository itself says about who
      // was working.
      const records = await linkAndAttribute(workspace, session.records);
      const result = await persist(workspace, records);

      written += result.written;
      skipped += result.skipped;
    },
  });

  const purge = await purgeCache(
    workspace.cacheDir,
    workspace.config.cacheRetentionDays,
    options.now ?? new Date(),
  ).catch(() => ({ purged: 0, kept: 0 }));

  return { sweep, written, skippedExisting: skipped, purgedCacheFiles: purge.purged, errors: [] };
}

/**
 * Attaches commits and the person behind them.
 *
 * Retroactive on purpose. A `post-commit` hook can only link commits made after
 * someone installed it; matching a record's own timestamp against the log links
 * everything already in the repository, so a first run is useful immediately.
 */
export async function linkAndAttribute(
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

export interface IngestResult {
  sessionId: string;
  agent: string;
  events: number;
  records: number;
  written: number;
}

/**
 * Reads one transcript in and treats it exactly like a session found on disk.
 *
 * The way in for an agent nobody has written an adapter for. Every adapter so
 * far reads a store somebody else designed, which means support waits on
 * reverse-engineering a format and on having that agent installed to verify
 * against. A documented shape anyone can produce needs neither.
 *
 * Nothing downstream is special-cased. The same distiller runs, the same fork
 * harvesting reads recorded option lists verbatim, the same linking attaches
 * commits, and the same records come out.
 */
export async function ingestTranscript(
  workspace: Workspace,
  input: unknown,
  options: { now?: () => Date } = {},
): Promise<IngestResult> {
  const { descriptor, events } = parseTranscript(input);

  const distill = createDistiller({
    runner: new ClaudeDistillRunner(),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const distilled = (await distill({ descriptor, events, fromOffset: 0 })) ?? [];
  const records = await linkAndAttribute(workspace, distilled);
  const { written } = await persist(workspace, records);

  return {
    sessionId: descriptor.sessionId,
    agent: descriptor.sessionFile.split(':')[1] ?? 'unknown',
    events: events.length,
    records: records.length,
    written,
  };
}
