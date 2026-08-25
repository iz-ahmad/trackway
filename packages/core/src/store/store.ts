import { randomBytes } from 'node:crypto';
import { open, mkdir, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { recordFilename } from '../ids/derive.js';
import type { MemoryRecord } from '../models/record.js';
import { MalformedRecordError, deserializeRecord, serializeRecord } from './serialize.js';

export interface WriteResult {
  id: string;
  path: string;
  /** False when an identical record was already on disk and nothing was rewritten. */
  written: boolean;
}

export interface ReadFailure {
  path: string;
  reason: string;
}

export interface ReadAllResult {
  records: MemoryRecord[];
  /** Files that could not be read. One bad file never hides the rest. */
  failures: ReadFailure[];
}

/**
 * Writes a record atomically.
 *
 * Content goes to a temp file in the same directory, is flushed to disk, then
 * renamed over the target. Rename within a directory is atomic, so a crash
 * leaves either the old file or the new one, never a half-written record.
 *
 * Writing a record whose content is already on disk is a no-op. Record IDs are
 * content-derived, so an identical ID means identical content.
 */
export async function writeRecord(storeDir: string, record: MemoryRecord): Promise<WriteResult> {
  await mkdir(storeDir, { recursive: true });

  const path = join(storeDir, recordFilename(record.id));
  const contents = serializeRecord(record);

  const existing = await readFileOrNull(path);
  if (existing === contents) {
    return { id: record.id, path, written: false };
  }

  const tempPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tempPath, 'wx');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }

  return { id: record.id, path, written: true };
}

/** Writes many records, stopping at the first failure. */
export async function writeRecords(
  storeDir: string,
  records: readonly MemoryRecord[],
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  for (const record of records) {
    results.push(await writeRecord(storeDir, record));
  }
  return results;
}

export async function readRecord(path: string): Promise<MemoryRecord> {
  return deserializeRecord(await readFile(path, 'utf8'));
}

/**
 * Reads every record in the store. A malformed file is reported and skipped
 * rather than aborting the read, so one bad record cannot make the store
 * unsearchable.
 */
export async function readAllRecords(storeDir: string): Promise<ReadAllResult> {
  const records: MemoryRecord[] = [];
  const failures: ReadFailure[] = [];

  for (const name of await listRecordFiles(storeDir)) {
    const path = join(storeDir, name);
    try {
      records.push(await readRecord(path));
    } catch (error) {
      failures.push({
        path,
        reason: error instanceof MalformedRecordError ? error.message : String(error),
      });
    }
  }

  records.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return { records, failures };
}

/** Removes one record. Returns false when it was not there to begin with. */
export async function forgetRecord(storeDir: string, id: string): Promise<boolean> {
  try {
    await rm(join(storeDir, recordFilename(id)));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** Removes every record distilled from one session. Returns the IDs removed. */
export async function forgetSession(storeDir: string, sessionId: string): Promise<string[]> {
  const { records } = await readAllRecords(storeDir);
  const removed: string[] = [];

  for (const record of records) {
    if (record.sessionId !== sessionId) continue;
    if (await forgetRecord(storeDir, record.id)) removed.push(record.id);
  }

  return removed;
}

async function listRecordFiles(storeDir: string): Promise<string[]> {
  try {
    const names = await readdir(storeDir);
    return names.filter((name) => name.endsWith('.md')).sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
