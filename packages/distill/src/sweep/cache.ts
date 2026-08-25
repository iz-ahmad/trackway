import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Removes cached event files past their retention window.
 *
 * Raw events are working state, not durable memory. They hold parsed session
 * content including whatever the agent read from disk, so keeping them
 * indefinitely grows a private copy of the developer's work for no benefit.
 */
export async function purgeCache(
  cacheDir: string,
  retentionDays: number,
  now: Date = new Date(),
): Promise<{ purged: number; kept: number }> {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  let purged = 0;
  let kept = 0;

  let entries: string[];
  try {
    entries = await readdir(join(cacheDir, 'events'));
  } catch {
    return { purged: 0, kept: 0 };
  }

  for (const name of entries) {
    const path = join(cacheDir, 'events', name);
    try {
      const info = await stat(path);
      if (info.mtime.getTime() < cutoff) {
        await rm(path, { force: true });
        purged += 1;
      } else {
        kept += 1;
      }
    } catch {
      // Already gone or unreadable. Either way there is nothing to purge.
    }
  }

  return { purged, kept };
}
