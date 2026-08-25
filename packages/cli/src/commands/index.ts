import { defaultRegistry } from '@backstory/adapters';
import {
  BackstoryConfig,
  forgetRecord,
  forgetSession,
  getRecord,
  listRecords,
  listSessions,
  rebuildIndex,
  removeRecord,
  search,
  searchAlternatives,
  type RecordType,
} from '@backstory/core';
import { loadState } from '@backstory/distill';
import { alternativeLine, detail, oneLine, shortDate, truncate } from '../format.js';
import { hookCommand, hookTargets, installHook, isHookInstalled } from '../hook.js';
import { sync } from '../pipeline.js';
import {
  ensureIgnoreRules,
  loadWorkspace,
  openWorkspaceIndex,
  writeConfig,
  type Workspace,
} from '../workspace.js';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const consoleIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const NOT_A_REPO = 'Not inside a git repository. Backstory stores records per repository.';

async function requireWorkspace(io: Io): Promise<Workspace | null> {
  const workspace = await loadWorkspace();
  if (!workspace) {
    io.err(NOT_A_REPO);
    return null;
  }
  return workspace;
}

/**
 * Every read command sweeps first.
 *
 * This is the self-heal path. If the agent hook is missing, removed, or the
 * agent has none, records still catch up the next time the developer asks for
 * anything. A failure here is reported and ignored: a search must still return
 * what is already indexed.
 */
async function selfHeal(workspace: Workspace, io: Io, quiet: boolean): Promise<void> {
  try {
    const result = await sync(workspace, { maxSessions: 5 });
    if (!quiet && result.written > 0) {
      io.out(`(distilled ${result.written} new record${result.written === 1 ? '' : 's'})\n`);
    }
  } catch (error) {
    if (!quiet) io.err(`(sync skipped: ${String(error)})`);
  }
}

export async function initCommand(options: { hook?: boolean }, io: Io = consoleIo): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  await writeConfig(workspace.storeDir, BackstoryConfig.parse({}));
  const ignore = await ensureIgnoreRules(workspace.storeDir);

  io.out(`Initialized Backstory in ${workspace.storeDir}`);
  io.out(`  config:      ${workspace.config.storePath}/config.yml`);
  io.out(`  records:     ${workspace.config.storePath}/records/  (tracked by git)`);
  io.out(`  index:       ${workspace.config.storePath}/index.sqlite  (${ignore === 'created' ? 'now ignored' : 'already ignored'})`);
  io.out(`  event cache: outside the repo, purged after ${workspace.config.cacheRetentionDays} days`);

  const registry = defaultRegistry();
  io.out('\nAgents found:');
  for (const status of await registry.status()) {
    const state = status.available
      ? status.canDistill
        ? 'ready'
        : 'ingest only, cannot distil'
      : `unavailable (${status.reason ?? 'unknown'})`;
    io.out(`  ${status.id.padEnd(12)} ${state}`);
  }

  if (options.hook === false) {
    io.out('\nSkipped hook install. Records catch up whenever you run a backstory command.');
    return 0;
  }

  io.out('');
  for (const target of hookTargets()) {
    if (await isHookInstalled(target)) {
      io.out(`Hook already installed for ${target.agent}.`);
      continue;
    }

    const result = await installHook(target, hookCommand());
    if (result.status === 'installed') {
      io.out(`Hook installed for ${target.agent} in ${target.settingsPath}`);
      io.out('This is once per machine and covers every repository.');
    } else if (result.status === 'failed') {
      io.err(`Could not install the hook for ${target.agent}: ${result.reason ?? 'unknown'}`);
      io.err('Records will still catch up whenever you run a backstory command.');
    }
  }

  return 0;
}

export async function syncCommand(
  options: { quiet?: boolean; max?: number },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const result = await sync(
    workspace,
    options.max === undefined ? {} : { maxSessions: options.max },
  );

  if (options.quiet) return 0;

  const distilled = result.sweep.swept.filter((s) => !s.undistilled).length;
  const undistilled = result.sweep.swept.filter((s) => s.undistilled).length;

  io.out(`Swept ${result.sweep.swept.length} session(s).`);
  io.out(`  distilled:   ${distilled}`);
  if (undistilled > 0) io.out(`  ingest only: ${undistilled} (agent cannot distil)`);
  io.out(`  records:     ${result.written} new, ${result.skippedExisting} already present`);

  if (result.sweep.deferred > 0) {
    io.out(`  deferred:    ${result.sweep.deferred} (run again to continue)`);
  }

  for (const failure of result.sweep.failures) {
    io.err(`  failed: ${failure.sessionId.slice(0, 12)} — ${truncate(failure.reason, 90)}`);
  }

  return 0;
}

export async function statusCommand(_options: unknown, io: Io = consoleIo): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const db = openWorkspaceIndex(workspace);
  let total = 0;
  let sessions: ReturnType<typeof listSessions> = [];
  try {
    sessions = listSessions(db);
    total = sessions.reduce((sum, s) => sum + s.recordCount, 0);
  } finally {
    db.close();
  }

  io.out(`Store:   ${workspace.config.storePath}/  (${total} records across ${sessions.length} sessions)`);

  io.out('\nAgents:');
  for (const status of await defaultRegistry().status()) {
    const state = status.available
      ? status.canDistill
        ? 'ready'
        : 'ingest only'
      : `unavailable — ${status.reason ?? 'unknown'}`;
    io.out(`  ${status.id.padEnd(12)} ${state}`);
  }

  io.out('\nHooks:');
  for (const target of hookTargets()) {
    io.out(`  ${target.agent.padEnd(12)} ${(await isHookInstalled(target)) ? 'installed' : 'not installed'}`);
  }

  // A session that went quiet and never got distilled is the symptom of a
  // broken trigger. Reporting it is what turns silent breakage into visible.
  const state = await loadState(workspace.cacheDir);
  const failed = Object.values(state.sessions).filter((s) => s.lastError !== null);

  if (failed.length > 0) {
    io.out(`\nFailed distillation (${failed.length}):`);
    for (const session of failed.slice(0, 10)) {
      io.out(`  ${session.sessionId.slice(0, 12)}  ${truncate(session.lastError ?? '', 70)}`);
    }
  }

  const pending = await countPending(workspace);
  if (pending > 0) {
    io.out(`\n${pending} quiet session(s) not yet distilled. Run: backstory sync`);
  }

  return 0;
}

async function countPending(workspace: Workspace): Promise<number> {
  try {
    const registry = defaultRegistry();
    const discovered = await registry.listAllSessions({ repoRoot: workspace.repoRoot });
    const state = await loadState(workspace.cacheDir);

    const quietBefore = Date.now() - workspace.config.quietWindowMinutes * 60_000;

    return discovered.filter(({ descriptor }) => {
      if (Date.parse(descriptor.lastModified) > quietBefore) return false;
      const known = state.sessions[`${descriptor.adapter}:${descriptor.sessionId}`];
      return !known || known.lastSeenModified !== descriptor.lastModified;
    }).length;
  } catch {
    return 0;
  }
}

export async function searchCommand(
  query: string,
  options: { type?: string; limit?: number; json?: boolean; noSync?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;
  if (!options.noSync) await selfHeal(workspace, io, options.json === true);

  const db = openWorkspaceIndex(workspace);
  try {
    const hits = search(db, query, {
      ...(options.type ? { types: [options.type as RecordType] } : {}),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });

    if (options.json) {
      io.out(JSON.stringify(hits.map((hit) => hit.record), null, 2));
      return 0;
    }

    if (hits.length === 0) {
      io.out(`Nothing found for "${query}".`);
      return 0;
    }

    io.out(`${hits.length} result(s) for "${query}":\n`);
    for (const hit of hits) io.out(oneLine(hit.record));
    return 0;
  } finally {
    db.close();
  }
}

export async function rejectedCommand(
  query: string | undefined,
  options: { limit?: number; json?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const db = openWorkspaceIndex(workspace);
  try {
    const hits = query
      ? searchAlternatives(db, query, options.limit === undefined ? {} : { limit: options.limit })
      : listRecords(db, { types: ['decision'], ...(options.limit === undefined ? {} : { limit: options.limit }) })
          .flatMap((record) =>
            record.type === 'decision'
              ? record.alternatives.map((alternative) => ({
                  decisionId: record.id,
                  decisionChoice: record.choice,
                  choice: alternative.choice,
                  status: alternative.status,
                  reason: alternative.reason,
                  condition: alternative.condition,
                  createdAt: record.createdAt,
                  sessionId: record.sessionId,
                  rank: 0,
                }))
              : [],
          );

    if (options.json) {
      io.out(JSON.stringify(hits, null, 2));
      return 0;
    }

    if (hits.length === 0) {
      io.out(query ? `No discarded options match "${query}".` : 'No discarded options recorded yet.');
      return 0;
    }

    io.out(`${hits.length} option(s) considered and not taken:\n`);
    for (const hit of hits) io.out(`${alternativeLine(hit)}\n`);
    return 0;
  } finally {
    db.close();
  }
}

export async function decisionsCommand(
  options: { actor?: string; implicit?: boolean; limit?: number; json?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const db = openWorkspaceIndex(workspace);
  try {
    const records = listRecords(db, {
      types: ['decision'],
      ...(options.actor ? { actor: options.actor as 'human' | 'agent' } : {}),
      ...(options.implicit ? { implicitOnly: true } : {}),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });

    if (options.json) {
      io.out(JSON.stringify(records, null, 2));
      return 0;
    }

    if (records.length === 0) {
      io.out('No decisions recorded yet.');
      return 0;
    }

    for (const record of records) io.out(oneLine(record));
    return 0;
  } finally {
    db.close();
  }
}

export async function showCommand(
  id: string,
  options: { json?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const db = openWorkspaceIndex(workspace);
  try {
    const record = getRecord(db, id);
    if (!record) {
      io.err(`No record with id ${id}.`);
      return 1;
    }

    io.out(options.json ? JSON.stringify(record, null, 2) : detail(record));
    return 0;
  } finally {
    db.close();
  }
}

export async function sessionsCommand(
  options: { json?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const db = openWorkspaceIndex(workspace);
  try {
    const sessions = listSessions(db);

    if (options.json) {
      io.out(JSON.stringify(sessions, null, 2));
      return 0;
    }

    if (sessions.length === 0) {
      io.out('No sessions recorded yet. Run: backstory sync');
      return 0;
    }

    for (const session of sessions) {
      io.out(
        `${shortDate(session.lastAt)}  ${session.sessionId.slice(0, 14).padEnd(15)} ${String(session.recordCount).padStart(3)} records  ${session.adapter}`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

export async function forgetCommand(
  target: string,
  options: { session?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const db = openWorkspaceIndex(workspace);
  try {
    if (options.session) {
      const removed = await forgetSession(workspace.recordsDir, target);
      for (const id of removed) removeRecord(db, id);

      io.out(
        removed.length === 0
          ? `No records from session ${target}.`
          : `Removed ${removed.length} record(s) from session ${target}.`,
      );
      return 0;
    }

    const removed = await forgetRecord(workspace.recordsDir, target);
    if (!removed) {
      io.err(`No record with id ${target}.`);
      return 1;
    }

    removeRecord(db, target);
    io.out(`Removed ${target}.`);
    return 0;
  } finally {
    db.close();
  }
}

export async function graphCommandEntry(
  options: { port?: number; open?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const { graphCommand } = await import('./graph.js');
  return graphCommand(workspace, options, io);
}

/**
 * Serves memory to a coding agent over stdio.
 *
 * Read-only. Nothing here can write a record, so distillation stays the single
 * write path.
 */
export async function mcpCommand(_options: unknown, io: Io = consoleIo): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const { serveMcpOverStdio } = await import('@backstory/server');
  const db = openWorkspaceIndex(workspace);

  // stdout carries the protocol, so nothing else may be written to it.
  await serveMcpOverStdio(db);
  return 0;
}

export async function rebuildCommand(_options: unknown, io: Io = consoleIo): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const db = openWorkspaceIndex(workspace);
  try {
    const result = await rebuildIndex(db, workspace.recordsDir);
    io.out(`Rebuilt the index from ${result.indexed} record file(s).`);

    for (const failure of result.failures) {
      io.err(`  unreadable: ${failure.path} — ${failure.reason}`);
    }
    return 0;
  } finally {
    db.close();
  }
}
