import { BackstoryConfig, openIndex, type IndexDatabase } from '@backstory/core';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const run = promisify(execFile);

export const CONFIG_FILE = 'config.yml';
export const INDEX_FILE = 'index.sqlite';

export interface Workspace {
  repoRoot: string;
  storeDir: string;
  recordsDir: string;
  cacheDir: string;
  indexPath: string;
  config: BackstoryConfig;
}

/**
 * Finds the repository root.
 *
 * Backstory is repo-scoped, and the store belongs at the root rather than in
 * whatever subdirectory a command happened to be run from.
 */
export async function findRepoRoot(from: string = process.cwd()): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd: from });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function loadWorkspace(from?: string): Promise<Workspace | null> {
  const repoRoot = await findRepoRoot(from);
  if (!repoRoot) return null;

  const config = await readConfig(repoRoot);
  const storeDir = resolve(repoRoot, config.storePath);

  return {
    repoRoot,
    storeDir,
    recordsDir: join(storeDir, 'records'),
    // The cache holds parsed session content, so it lives outside the repo
    // entirely. A misconfigured ignore rule should not be able to commit it.
    cacheDir: join(homedir(), '.backstory', 'cache', encodeURIComponent(repoRoot)),
    indexPath: join(storeDir, INDEX_FILE),
    config,
  };
}

export async function readConfig(repoRoot: string): Promise<BackstoryConfig> {
  for (const dir of ['.backstory', '.memory']) {
    try {
      const raw = await readFile(join(repoRoot, dir, CONFIG_FILE), 'utf8');
      const parsed = BackstoryConfig.safeParse(parseYaml(raw) ?? {});
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next location, then fall back to defaults.
    }
  }

  return BackstoryConfig.parse({});
}

export async function writeConfig(storeDir: string, config: BackstoryConfig): Promise<void> {
  await mkdir(storeDir, { recursive: true });
  await writeFile(join(storeDir, CONFIG_FILE), stringifyYaml(config), 'utf8');
}

export function isInitialized(workspace: Workspace | null): workspace is Workspace {
  return workspace !== null;
}

export function openWorkspaceIndex(workspace: Workspace): IndexDatabase {
  return openIndex(workspace.indexPath);
}

/**
 * Ignore rules Backstory needs.
 *
 * The index is a binary that would conflict on every merge, and it is
 * rebuildable from the records, so tracking it is pure cost. Records themselves
 * stay tracked: they are the point.
 */
export const IGNORE_RULES = [
  '# Backstory: derived index, rebuildable from records',
  'index.sqlite',
  'index.sqlite-shm',
  'index.sqlite-wal',
];

export async function ensureIgnoreRules(storeDir: string): Promise<'created' | 'unchanged'> {
  await mkdir(storeDir, { recursive: true });
  const path = join(storeDir, '.gitignore');

  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    // No ignore file yet.
  }

  const missing = IGNORE_RULES.filter((rule) => !existing.includes(rule));
  if (missing.length === 0) return 'unchanged';

  const next = existing.trimEnd();
  await writeFile(path, `${next ? `${next}\n` : ''}${IGNORE_RULES.join('\n')}\n`, 'utf8');
  return 'created';
}
