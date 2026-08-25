import { readAllRecords, type ReadFailure } from '../store/store.js';
import { clearIndex, openIndex, writeSchemaVersion, SCHEMA_VERSION, type IndexDatabase } from './schema.js';
import { upsertRecords } from './upsert.js';

export interface RebuildResult {
  indexed: number;
  failures: ReadFailure[];
}

/**
 * Rebuilds the index from the record files alone.
 *
 * The index is derived state and must be reproducible from what git tracks.
 * Nothing here reads any other source.
 */
export async function rebuildIndex(db: IndexDatabase, storeDir: string): Promise<RebuildResult> {
  const { records, failures } = await readAllRecords(storeDir);

  clearIndex(db);
  upsertRecords(db, records);
  writeSchemaVersion(db, SCHEMA_VERSION);

  return { indexed: records.length, failures };
}

/** Opens the index at `indexPath` and rebuilds it from `storeDir`. */
export async function rebuildIndexAt(indexPath: string, storeDir: string): Promise<RebuildResult> {
  const db = openIndex(indexPath);
  try {
    return await rebuildIndex(db, storeDir);
  } finally {
    db.close();
  }
}
