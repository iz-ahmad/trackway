import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOOK_MARKER,
  ensureIgnoreRules,
  findRepoRoot,
  forgetCommand,
  hookCommand,
  hookTargets,
  installHook,
  isHookInstalled,
  loadWorkspace,
  persist,
  readConfig,
  readConfigResult,
  rejectedCommand,
  searchCommand,
  sessionsCommand,
  showCommand,
  writeConfig,
  type Io,
} from '../src/index.js';
import { BackstoryConfig, type MemoryRecord } from '@backstory/core';

const run = promisify(execFile);

let repo: string;
let previousCwd: string;

function captureIo(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (line) => lines.push(line), err: (line) => errors.push(line) };
}

function decisionRecord(overrides: Partial<Extract<MemoryRecord, { type: 'decision' }>> = {}) {
  return {
    id: 'dec-20260825-aaaaaaaa',
    type: 'decision' as const,
    sessionId: 'ses-1',
    episodeId: null,
    createdAt: '2026-08-25T09:18:00Z',
    significance: 'technical' as const,
    source: {
      adapter: 'claude-code',
      sessionId: 'ses-1',
      sessionFile: '/tmp/ses-1.jsonl',
      fromOffset: 0,
      toOffset: 12,
    },
    question: 'Which cache should we use?',
    choice: 'Redis',
    reason: 'Already deployed here.',
    alternatives: [
      {
        choice: 'PostgreSQL unlogged tables',
        status: 'rejected' as const,
        reason: 'Higher latency for this workload.',
        condition: 'PostgreSQL is not deployed here',
      },
    ],
    attribution: {
      proposedBy: { type: 'agent' as const, id: 'agent:claude-code' },
      acceptedBy: { type: 'human' as const, id: 'human:local' },
    },
    status: 'accepted' as const,
    supersededBy: null,
    relationships: [],
    ...overrides,
  };
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'backstory-cli-'));
  await run('git', ['init', '-q'], { cwd: repo });
  previousCwd = process.cwd();
  process.chdir(repo);
});

afterEach(async () => {
  process.chdir(previousCwd);
  await rm(repo, { recursive: true, force: true });
});

describe('workspace', () => {
  it('finds the repository root from a subdirectory', async () => {
    const nested = join(repo, 'packages', 'core');
    await mkdir(nested, { recursive: true });

    const root = await findRepoRoot(nested);

    // macOS reports /private/var for /var, so compare the tail.
    expect(root?.endsWith(repo.replace('/private', ''))).toBe(true);
  });

  it('reports no workspace outside a git repository', async () => {
    const loose = await mkdtemp(join(tmpdir(), 'backstory-loose-'));
    try {
      expect(await loadWorkspace(loose)).toBeNull();
    } finally {
      await rm(loose, { recursive: true, force: true });
    }
  });

  it('falls back to defaults when no config has been written', async () => {
    expect(await readConfig(repo)).toEqual(BackstoryConfig.parse({}));
  });

  it('round-trips a config through disk', async () => {
    const config = BackstoryConfig.parse({ quietWindowMinutes: 42 });
    await writeConfig(join(repo, '.backstory'), config);

    expect((await readConfig(repo)).quietWindowMinutes).toBe(42);
  });

  it('keeps the event cache outside the repository', async () => {
    const workspace = await loadWorkspace(repo);

    // A misconfigured ignore rule must not be able to commit parsed session
    // content, so the cache never lives inside the working tree.
    expect(workspace?.cacheDir.startsWith(repo)).toBe(false);
  });
});

describe('ignore rules', () => {
  it('ignores the index but leaves records tracked', async () => {
    const storeDir = join(repo, '.backstory');
    await ensureIgnoreRules(storeDir);
    await mkdir(join(storeDir, 'records'), { recursive: true });
    await writeFile(join(storeDir, 'index.sqlite'), 'binary', 'utf8');
    await writeFile(join(storeDir, 'records', 'dec-1.md'), '---\n---\n', 'utf8');

    const { stdout } = await run('git', ['status', '--porcelain', '--ignored'], { cwd: repo });

    // Records are the point of the product, so only the derived index is hidden.
    expect(stdout).toContain('!! .backstory/index.sqlite');
    expect(stdout).not.toContain('!! .backstory/records');
  });

  it('does not duplicate rules when run twice', async () => {
    const storeDir = join(repo, '.backstory');

    expect(await ensureIgnoreRules(storeDir)).toBe('created');
    expect(await ensureIgnoreRules(storeDir)).toBe('unchanged');

    const contents = await readFile(join(storeDir, '.gitignore'), 'utf8');
    expect(contents.match(/index\.sqlite\n/g)).toHaveLength(1);
  });

  it('appends to an ignore file that already has other rules', async () => {
    const storeDir = join(repo, '.backstory');
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, '.gitignore'), 'scratch/\n', 'utf8');

    await ensureIgnoreRules(storeDir);
    const contents = await readFile(join(storeDir, '.gitignore'), 'utf8');

    expect(contents).toContain('scratch/');
    expect(contents).toContain('index.sqlite');
  });

  it('actually keeps git from tracking the index', async () => {
    const storeDir = join(repo, '.backstory');
    await ensureIgnoreRules(storeDir);
    await writeFile(join(storeDir, 'index.sqlite'), 'binary', 'utf8');

    const { stdout } = await run('git', ['status', '--porcelain', '--ignored'], { cwd: repo });

    expect(stdout).toContain('!! .backstory/index.sqlite');
  });
});

describe('hook installation', () => {
  it('writes a hook into user-level settings, not the repository', () => {
    const [target] = hookTargets('/home/dev');

    // User level is the point: one install covers every repository, including
    // ones that do not exist yet.
    expect(target?.settingsPath).toBe('/home/dev/.claude/settings.json');
  });

  it('installs into a settings file that does not exist yet', async () => {
    const home = join(repo, 'home');
    const [target] = hookTargets(home);

    const result = await installHook(target!, hookCommand());

    expect(result.status).toBe('installed');
    expect(await isHookInstalled(target!)).toBe(true);
  });

  it('preserves settings that were already there', async () => {
    const home = join(repo, 'home');
    const [target] = hookTargets(home);
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      target!.settingsPath,
      JSON.stringify({ model: 'opus', hooks: { SessionStart: [{ hooks: [] }] } }),
      'utf8',
    );

    await installHook(target!, hookCommand());
    const settings = JSON.parse(await readFile(target!.settingsPath, 'utf8')) as Record<string, unknown>;

    expect(settings['model']).toBe('opus');
    expect((settings['hooks'] as Record<string, unknown>)['SessionStart']).toBeDefined();
    expect(JSON.stringify(settings)).toContain(HOOK_MARKER);
  });

  it('does not install twice', async () => {
    const home = join(repo, 'home');
    const [target] = hookTargets(home);

    await installHook(target!, hookCommand());
    const second = await installHook(target!, hookCommand());

    expect(second.status).toBe('already-present');
  });

  it('runs the sweep detached so it cannot block a session', () => {
    expect(hookCommand()).toContain('&');
    expect(hookCommand()).toContain('--quiet');
  });

  it('reports rather than throws when settings cannot be written', async () => {
    const result = await installHook(
      { agent: 'claude-code', settingsPath: '/proc/definitely/not/writable/settings.json' },
      hookCommand(),
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toBeTruthy();
  });
});

describe('reading commands', () => {
  async function seed(records: MemoryRecord[]): Promise<void> {
    const workspace = await loadWorkspace(repo);
    await persist(workspace!, records);
  }

  it('finds a decision by text', async () => {
    await seed([decisionRecord()]);
    const io = captureIo();

    const code = await searchCommand('Redis', { noSync: true }, io);

    expect(code).toBe(0);
    expect(io.lines.join('\n')).toContain('dec-20260825-aaaaaaaa');
  });

  it('says so plainly when nothing matches', async () => {
    await seed([decisionRecord()]);
    const io = captureIo();

    await searchCommand('kubernetes', { noSync: true }, io);

    expect(io.lines.join('\n')).toContain('Nothing found');
  });

  it('finds a discarded option by text that appears only in the rejected branch', async () => {
    await seed([decisionRecord()]);
    const io = captureIo();

    await rejectedCommand('unlogged', {}, io);
    const output = io.lines.join('\n');

    expect(output).toContain('PostgreSQL unlogged tables');
    expect(output).toContain('Higher latency');
    expect(output).toContain('instead: Redis');
  });

  it('shows the condition that made a rejection valid at the time', async () => {
    await seed([decisionRecord()]);
    const io = captureIo();

    await rejectedCommand('unlogged', {}, io);

    expect(io.lines.join('\n')).toContain('PostgreSQL is not deployed here');
  });

  it('lists every discarded option when given no query', async () => {
    await seed([decisionRecord()]);
    const io = captureIo();

    await rejectedCommand(undefined, {}, io);

    expect(io.lines.join('\n')).toContain('PostgreSQL unlogged tables');
  });

  it('shows one record in full', async () => {
    await seed([decisionRecord()]);
    const io = captureIo();

    await showCommand('dec-20260825-aaaaaaaa', {}, io);
    const output = io.lines.join('\n');

    expect(output).toContain('Which cache should we use?');
    expect(output).toContain('Not taken:');
    expect(output).toContain('AGENT, you accepted');
  });

  it('reports a missing record with a non-zero exit', async () => {
    const io = captureIo();

    const code = await showCommand('dec-nope', {}, io);

    expect(code).toBe(1);
    expect(io.errors.join('\n')).toContain('No record with id');
  });

  it('emits parseable JSON when asked', async () => {
    await seed([decisionRecord()]);
    const io = captureIo();

    await searchCommand('Redis', { json: true, noSync: true }, io);

    expect(() => JSON.parse(io.lines.join('\n'))).not.toThrow();
  });

  it('names an agent decision taken without explicit approval', async () => {
    await seed([
      decisionRecord({
        attribution: {
          proposedBy: { type: 'agent', id: 'agent:claude-code' },
          acceptedBy: 'implicit',
        },
      }),
    ]);
    const io = captureIo();

    await showCommand('dec-20260825-aaaaaaaa', {}, io);

    expect(io.lines.join('\n')).toContain('no explicit approval');
  });

  it('groups records by session', async () => {
    await seed([decisionRecord()]);
    const io = captureIo();

    await sessionsCommand({}, io);

    expect(io.lines.join('\n')).toContain('ses-1');
  });
});

// Covers AE12.
describe('forget', () => {
  it('removes a record from disk and from search', async () => {
    const workspace = await loadWorkspace(repo);
    await persist(workspace!, [decisionRecord()]);

    const io = captureIo();
    const code = await forgetCommand('dec-20260825-aaaaaaaa', {}, io);

    expect(code).toBe(0);

    const after = captureIo();
    await searchCommand('Redis', { noSync: true }, after);
    expect(after.lines.join('\n')).toContain('Nothing found');
  });

  it('reports a non-zero exit for an unknown id', async () => {
    const io = captureIo();

    expect(await forgetCommand('dec-nope', {}, io)).toBe(1);
    expect(io.errors.join('\n')).toContain('No record with id');
  });

  it('removes every record from one session and leaves others', async () => {
    const workspace = await loadWorkspace(repo);
    await persist(workspace!, [
      decisionRecord(),
      decisionRecord({ id: 'dec-20260825-bbbbbbbb', sessionId: 'ses-2', choice: 'Memcached' }),
    ]);

    const io = captureIo();
    await forgetCommand('ses-1', { session: true }, io);

    const after = captureIo();
    await searchCommand('Memcached', { noSync: true }, after);

    expect(io.lines.join('\n')).toContain('Removed 1 record');
    expect(after.lines.join('\n')).toContain('dec-20260825-bbbbbbbb');
  });
});

describe('commands outside a repository', () => {
  it('explain the problem rather than failing obscurely', async () => {
    const loose = await mkdtemp(join(tmpdir(), 'backstory-loose-'));
    process.chdir(loose);

    try {
      const io = captureIo();
      const code = await searchCommand('anything', { noSync: true }, io);

      expect(code).toBe(1);
      expect(io.errors.join('\n')).toContain('Not inside a git repository');
    } finally {
      process.chdir(repo);
      await rm(loose, { recursive: true, force: true });
    }
  });
});

describe('an unusable config file', () => {
  it('reports why it was rejected instead of defaulting silently', async () => {
    // Found by using the tool: setting quietWindowMinutes to 0 fails validation,
    // the file was discarded, and the setting appeared to have no effect with
    // nothing said about it.
    const storeDir = join(repo, '.backstory');
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, 'config.yml'), 'quietWindowMinutes: 0\n', 'utf8');

    const result = await readConfigResult(repo);

    expect(result.config.quietWindowMinutes).toBe(15);
    expect(result.problem).toContain('quietWindowMinutes');
    expect(result.problem).toContain('using defaults');
  });

  it('reports invalid YAML separately from an invalid value', async () => {
    const storeDir = join(repo, '.backstory');
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, 'config.yml'), 'quietWindow: [unclosed\n', 'utf8');

    const result = await readConfigResult(repo);

    expect(result.problem).toContain('not valid YAML');
  });

  it('reports an unknown key rather than ignoring it', async () => {
    const storeDir = join(repo, '.backstory');
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, 'config.yml'), 'quietWindowMinutes: 20\nverbose: true\n', 'utf8');

    const result = await readConfigResult(repo);

    // A typo in a key name would otherwise look like it worked.
    expect(result.problem).toBeTruthy();
  });

  it('says nothing when the config is valid', async () => {
    await writeConfig(join(repo, '.backstory'), BackstoryConfig.parse({ quietWindowMinutes: 20 }));

    const result = await readConfigResult(repo);

    expect(result.problem).toBeUndefined();
    expect(result.config.quietWindowMinutes).toBe(20);
  });

  it('says nothing when there is no config at all', async () => {
    const result = await readConfigResult(repo);

    expect(result.problem).toBeUndefined();
  });

  it('surfaces the problem through a command rather than hiding it', async () => {
    const storeDir = join(repo, '.backstory');
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, 'config.yml'), 'quietWindowMinutes: -5\n', 'utf8');

    const io = captureIo();
    await searchCommand('anything', { noSync: true }, io);

    expect(io.errors.join('\n')).toContain('warning:');
  });
});
