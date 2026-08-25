import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * How far a session has been distilled, and when we last looked at it.
 *
 * This lives in the local cache rather than in the record store, because it is
 * per-machine bookkeeping. A teammate pulling records should not inherit our
 * watermarks: their agent wrote different session files.
 */
export const SessionState = z.strictObject({
  sessionId: z.string().min(1),
  adapter: z.string().min(1),
  /** Highest event offset already distilled. -1 means nothing yet. */
  watermark: z.number().int().min(-1),
  /** Session file mtime at the last sweep, used to detect new content. */
  lastSeenModified: z.string(),
  lastSweptAt: z.string(),
  /** Set when distillation failed, so status can report it rather than retry forever. */
  lastError: z.string().nullable().default(null),
  failureCount: z.number().int().min(0).default(0),
});

export const SweepState = z.strictObject({
  version: z.literal(1),
  sessions: z.record(z.string(), SessionState),
});

export type SessionState = z.infer<typeof SessionState>;
export type SweepState = z.infer<typeof SweepState>;

const STATE_FILE = 'sweep-state.json';

export function emptyState(): SweepState {
  return { version: 1, sessions: {} };
}

/** Key for a session, namespaced by adapter so ids cannot collide across agents. */
export function stateKey(adapter: string, sessionId: string): string {
  return `${adapter}:${sessionId}`;
}

export async function loadState(cacheDir: string): Promise<SweepState> {
  try {
    const parsed = SweepState.safeParse(JSON.parse(await readFile(join(cacheDir, STATE_FILE), 'utf8')));
    // A corrupt or outdated state file costs re-distillation, not correctness:
    // record IDs are content-derived, so re-running produces the same records.
    return parsed.success ? parsed.data : emptyState();
  } catch {
    return emptyState();
  }
}

/** Writes atomically, so an interrupted sweep cannot corrupt the watermarks. */
export async function saveState(cacheDir: string, state: SweepState): Promise<void> {
  await mkdir(cacheDir, { recursive: true });

  const target = join(cacheDir, STATE_FILE);
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;

  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
