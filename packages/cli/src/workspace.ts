import { TrackwayConfig, openIndex, type IndexDatabase } from '@trackway/core';
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
  /** Set when the config file exists but was unusable. Surfaced by status. */
  configProblem?: string;
  storeDir: string;
  recordsDir: string;
  cacheDir: string;
  indexPath: string;
  config: TrackwayConfig;
}

/**
 * Finds the repository root.
 *
 * Trackway is repo-scoped, and the store belongs at the root rather than in
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

  const { config, problem } = await readConfigResult(repoRoot);
  const storeDir = resolve(repoRoot, config.storePath);

  return {
    repoRoot,
    storeDir,
    ...(problem === undefined ? {} : { configProblem: problem }),
    recordsDir: join(storeDir, 'records'),
    // The cache holds parsed session content, so it lives outside the repo
    // entirely. A misconfigured ignore rule should not be able to commit it.
    cacheDir: join(homedir(), '.trackway', 'cache', encodeURIComponent(repoRoot)),
    indexPath: join(storeDir, INDEX_FILE),
    config,
  };
}

export interface ConfigResult {
  config: TrackwayConfig;
  /** Set when a config file exists but could not be used. */
  problem?: string;
}

/**
 * Reads the config, reporting why it was rejected rather than defaulting quietly.
 *
 * Silently substituting defaults for an invalid config is how a setting appears
 * to have no effect. Setting quietWindowMinutes to 0 does exactly that: zero
 * fails validation, the file is discarded, and the tool behaves as though the
 * edit never happened.
 */
export async function readConfigResult(repoRoot: string): Promise<ConfigResult> {
  for (const dir of ['.trackway', '.memory']) {
    let raw: string;
    try {
      raw = await readFile(join(repoRoot, dir, CONFIG_FILE), 'utf8');
    } catch {
      continue; // No config in this location.
    }

    let parsedYaml: unknown;
    try {
      parsedYaml = parseYaml(raw) ?? {};
    } catch (error) {
      return {
        config: TrackwayConfig.parse({}),
        problem: `${dir}/${CONFIG_FILE} is not valid YAML (${String(error).slice(0, 120)}); using defaults`,
      };
    }

    const parsed = TrackwayConfig.safeParse(parsedYaml);
    if (parsed.success) return { config: parsed.data };

    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');

    return {
      config: TrackwayConfig.parse({}),
      problem: `${dir}/${CONFIG_FILE} was rejected (${detail}); using defaults`,
    };
  }

  return { config: TrackwayConfig.parse({}) };
}

export async function readConfig(repoRoot: string): Promise<TrackwayConfig> {
  return (await readConfigResult(repoRoot)).config;
}

export async function writeConfig(storeDir: string, config: TrackwayConfig): Promise<void> {
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
 * Ignore rules Trackway needs.
 *
 * The index is a binary that would conflict on every merge, and it is
 * rebuildable from the records, so tracking it is pure cost. Records themselves
 * stay tracked: they are the point.
 */
export const IGNORE_RULES = [
  '# Trackway: derived index, rebuildable from records',
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
