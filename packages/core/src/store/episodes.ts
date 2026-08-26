import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

/**
 * A topic the session spent time on.
 *
 * Stored beside the records rather than inside them, because a topic is a
 * property of the grouping rather than of any one record. Records carry only
 * the id, so re-grouping renames a topic in one place.
 */
export const Episode = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  sessionId: z.string().min(1),
});

export const EpisodeFile = z.strictObject({
  version: z.literal(1),
  episodes: z.array(Episode),
});

export type Episode = z.infer<typeof Episode>;

const FILE = 'episodes.yml';

export async function readEpisodes(storeDir: string): Promise<Episode[]> {
  try {
    const parsed = EpisodeFile.safeParse(parseYaml(await readFile(join(storeDir, FILE), 'utf8')));
    return parsed.success ? parsed.data.episodes : [];
  } catch {
    // No topics recorded yet, which is not an error: records still read fine
    // ungrouped.
    return [];
  }
}

export async function writeEpisodes(storeDir: string, episodes: readonly Episode[]): Promise<void> {
  await mkdir(storeDir, { recursive: true });
  await writeFile(
    join(storeDir, FILE),
    stringifyYaml({ version: 1, episodes: [...episodes] }),
    'utf8',
  );
}
