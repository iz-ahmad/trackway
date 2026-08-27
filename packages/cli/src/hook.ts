import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HOOK_MARKER = 'trackway sync';

export interface HookTarget {
  agent: string;
  settingsPath: string;
}

/**
 * Where each agent keeps user-level settings.
 *
 * User level, not project level, is the whole point: one install covers every
 * repository including ones that do not exist yet. A per-project hook would
 * have to be installed again for each repo and would miss new ones entirely.
 */
export function hookTargets(home: string = homedir()): HookTarget[] {
  return [{ agent: 'claude-code', settingsPath: join(home, '.claude', 'settings.json') }];
}

export interface HookInstallResult {
  agent: string;
  settingsPath: string;
  status: 'installed' | 'already-present' | 'failed';
  reason?: string;
}

/**
 * Adds a hook that fires a sweep as the developer works.
 *
 * The hook does nothing but start a detached sweep. It carries no capture
 * logic, so it cannot slow a session or fail in a way the developer notices,
 * and every command runs the same sweep as a fallback if it is ever removed.
 */
export async function installHook(target: HookTarget, command: string): Promise<HookInstallResult> {
  let settings: Record<string, unknown> = {};

  try {
    settings = JSON.parse(await readFile(target.settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // No settings file yet, or unreadable. Start from an empty object rather
    // than refusing: a fresh install is the common case.
  }

  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(hooks['Stop']) ? (hooks['Stop'] as unknown[]) : [];

  if (JSON.stringify(existing).includes(HOOK_MARKER)) {
    return { agent: target.agent, settingsPath: target.settingsPath, status: 'already-present' };
  }

  const entry = {
    hooks: [{ type: 'command', command, timeout: 5 }],
  };

  const next = {
    ...settings,
    hooks: { ...hooks, Stop: [...existing, entry] },
  };

  try {
    await mkdir(dirname(target.settingsPath), { recursive: true });
    await writeFile(target.settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return { agent: target.agent, settingsPath: target.settingsPath, status: 'installed' };
  } catch (error) {
    return {
      agent: target.agent,
      settingsPath: target.settingsPath,
      status: 'failed',
      reason: String(error instanceof Error ? error.message : error),
    };
  }
}

export async function isHookInstalled(target: HookTarget): Promise<boolean> {
  try {
    const raw = await readFile(target.settingsPath, 'utf8');
    return raw.includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

/** The command the hook runs. Detached and silent, so it cannot block a session. */
export function hookCommand(): string {
  return 'trackway sync --quiet &';
}
