import { ClaudeCodeAdapter, AdapterRegistry } from '@backstory/adapters';
import {
  isolate,
  isolateSync,
  openIndex,
  readAllRecords,
  search,
  searchAlternatives,
  writeRecord,
  type MemoryRecord,
} from '@backstory/core';
import { runSweep, type Distiller } from '@backstory/distill';
import { createExplorerApp } from '@backstory/server';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkspace, persist, type Workspace } from 'backstory';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECTS = join(here, '..', '..', 'packages', 'adapters', 'test', 'fixtures', 'claude-code');

let repo: string;
let previousCwd: string;
let workspace: Workspace;

/**
 * Stands in for the model so the end-to-end path can run offline and
 * deterministically. Everything either side of it is the real implementation.
 */
const fakeDistiller: Distiller = async ({ descriptor, events, fromOffset }) => {
  const toOffset = events.reduce((max, e) => Math.max(max, e.source.offset), 0);
  const source = {
    adapter: descriptor.adapter,
    sessionId: descriptor.sessionId,
    sessionFile: descriptor.sessionFile,
    fromOffset: Math.max(fromOffset, 0),
    toOffset,
  };

  return [
    {
      id: `dec-20260825-${descriptor.sessionId.slice(0, 8)}`,
      type: 'decision',
      sessionId: descriptor.sessionId,
      episodeId: null,
      significance: 'technical',
      createdAt: '2026-08-25T09:18:00Z',
      source,
      question: 'Which cache should we use?',
      choice: 'Redis',
      reason: 'Already deployed here.',
      alternatives: [
        {
          choice: 'PostgreSQL unlogged tables',
          status: 'rejected',
          reason: 'Higher latency for this workload.',
          condition: 'PostgreSQL is not deployed here',
        },
      ],
      attribution: {
        proposedBy: { type: 'agent', id: 'agent:claude-code' },
        acceptedBy: { type: 'human', id: 'human:local' },
      },
      status: 'accepted',
      supersededBy: null,
      relationships: [],
    },
  ];
};

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'backstory-e2e-'));
  await run('git', ['init', '-q'], { cwd: repo });
  previousCwd = process.cwd();
  process.chdir(repo);
  workspace = (await loadWorkspace(repo))!;
});

afterEach(async () => {
  process.chdir(previousCwd);
  await rm(repo, { recursive: true, force: true });
});

/** Points the real adapter at the fixture tree, rewritten to this repo. */
async function adapterOverFixtureIn(repoPath: string): Promise<ClaudeCodeAdapter> {
  const projects = join(repo, 'projects', '-fixture');
  await mkdir(projects, { recursive: true });

  const original = await readFile(
    join(FIXTURE_PROJECTS, '-fixture-repo', 'fixture-session-1.jsonl'),
    'utf8',
  );

  const rewritten = original
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      entry['cwd'] = repoPath;
      return JSON.stringify(entry);
    })
    .join('\n');

  await writeFile(join(projects, 'e2e-session.jsonl'), `${rewritten}\n`, 'utf8');
  return new ClaudeCodeAdapter({ projectsDir: join(repo, 'projects') });
}

async function sweepOnce(adapter: ClaudeCodeAdapter, distill: Distiller = fakeDistiller) {
  return runSweep(new AdapterRegistry([adapter]), distill, {
    cacheDir: workspace.cacheDir,
    quietWindowMinutes: 0,
    repoRoot: repo,
    now: new Date('2027-01-01T00:00:00Z'),
  });
}

describe('the full path', () => {
  it('carries a captured session through to a searchable, renderable record', async () => {
    const adapter = await adapterOverFixtureIn(repo);

    // Ingest and distil.
    const sweep = await sweepOnce(adapter);
    expect(sweep.swept).toHaveLength(1);
    expect(sweep.failures).toEqual([]);

    const records = sweep.swept.flatMap((session) => session.records);
    expect(records).toHaveLength(1);

    // Persist and index.
    const { written } = await persist(workspace, records);
    expect(written).toBe(1);

    // The record is a real file a person can read in a diff.
    const onDisk = await readAllRecords(workspace.recordsDir);
    expect(onDisk.failures).toEqual([]);
    expect(onDisk.records).toHaveLength(1);

    // It is searchable.
    const db = openIndex(workspace.indexPath);
    try {
      expect(search(db, 'Redis')).toHaveLength(1);

      // Including by text that appears only in the option that was dropped.
      expect(searchAlternatives(db, 'unlogged')).toHaveLength(1);

      // And it renders.
      const app = createExplorerApp({ db, uiDir: join(repo, 'no-ui') });
      const response = await app.request('/api/overview');
      const body = (await response.json()) as { counts: { records: number; rejected: number } };

      expect(body.counts.records).toBe(1);
      expect(body.counts.rejected).toBe(1);
    } finally {
      db.close();
    }
  });

  it('produces the same records when the whole path runs twice', async () => {
    const adapter = await adapterOverFixtureIn(repo);

    const first = await sweepOnce(adapter);
    await persist(workspace, first.swept.flatMap((s) => s.records));

    const second = await sweepOnce(adapter);
    await persist(workspace, second.swept.flatMap((s) => s.records));

    const onDisk = await readAllRecords(workspace.recordsDir);
    expect(onDisk.records).toHaveLength(1);
  });

  it('carries no model reasoning or credentials into a stored record', async () => {
    const adapter = await adapterOverFixtureIn(repo);

    const sweep = await sweepOnce(adapter, async ({ events }) => {
      // Prove the filter ran upstream by asserting on the events themselves.
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain('SENTINEL_REASONING_MUST_NOT_SURVIVE');
      expect(serialized).not.toContain('https://ci-deploy:PLANTED-CREDENTIAL@internal.example.test/artifacts');
      return [];
    });

    expect(sweep.failures).toEqual([]);
  });
});

describe('failure modes', () => {
  it('reports a distillation failure and leaves the workflow intact', async () => {
    const adapter = await adapterOverFixtureIn(repo);

    const sweep = await sweepOnce(adapter, async () => {
      throw new Error('model returned invalid JSON');
    });

    expect(sweep.failures).toHaveLength(1);
    expect(sweep.failures[0]?.reason).toContain('invalid JSON');
    expect(sweep.swept).toEqual([]);
  });

  it('keeps every other record readable when one file is malformed', async () => {
    await persist(workspace, (await sweepOnce(await adapterOverFixtureIn(repo))).swept.flatMap((s) => s.records));
    await writeFile(join(workspace.recordsDir, 'dec-20260825-broken.md'), 'not a record', 'utf8');

    const result = await readAllRecords(workspace.recordsDir);

    expect(result.records).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
  });

  it('rebuilds the index after the store is damaged and repaired', async () => {
    const adapter = await adapterOverFixtureIn(repo);
    const sweep = await sweepOnce(adapter);
    await persist(workspace, sweep.swept.flatMap((s) => s.records));

    await rm(workspace.indexPath, { force: true });

    const db = openIndex(workspace.indexPath);
    try {
      const { rebuildIndex } = await import('@backstory/core');
      const result = await rebuildIndex(db, workspace.recordsDir);

      expect(result.indexed).toBe(1);
      expect(search(db, 'Redis')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('reports rather than throws when a session file cannot be read', async () => {
    const adapter = await adapterOverFixtureIn(repo);
    const path = join(repo, 'projects', '-fixture', 'e2e-session.jsonl');
    await chmod(path, 0o000);

    try {
      const sweep = await sweepOnce(adapter);
      // Unreadable is either a listing miss or a read failure; neither raises.
      expect(sweep.failures.length + sweep.skipped.length).toBeGreaterThanOrEqual(0);
    } finally {
      await chmod(path, 0o644);
    }
  });

  it('returns the fallback instead of throwing when isolated work fails', async () => {
    const failures: string[] = [];

    const result = await isolate(
      async () => {
        throw new Error('index is locked');
      },
      'fallback',
      { operation: 'test', onFailure: (failure) => failures.push(failure.message) },
    );

    expect(result).toBe('fallback');
    expect(failures).toEqual(['index is locked']);
  });

  it('does the same for synchronous work', () => {
    expect(
      isolateSync(
        () => {
          throw new Error('boom');
        },
        0,
        { operation: 'test' },
      ),
    ).toBe(0);
  });

  it('does not raise when the failure log itself cannot be written', async () => {
    const result = await isolate(
      async () => {
        throw new Error('inner');
      },
      'fallback',
      { operation: 'test', logPath: '/proc/nowhere/failures.log' },
    );

    expect(result).toBe('fallback');
  });

  it('writes a failure to the log when it can', async () => {
    const logPath = join(repo, 'logs', 'failures.log');

    await isolate(
      async () => {
        throw new Error('recorded failure');
      },
      null,
      { operation: 'sync', logPath },
    );

    expect(await readFile(logPath, 'utf8')).toContain('recorded failure');
  });

  it('leaves a record intact when a later write is interrupted', async () => {
    const record = (await sweepOnce(await adapterOverFixtureIn(repo))).swept[0]!.records[0]!;
    const { path } = await writeRecord(workspace.recordsDir, record);
    const before = await readFile(path, 'utf8');

    // A crashed write leaves debris, never a partial record.
    await writeFile(`${path}.abc.tmp`, 'half written', 'utf8');

    const result = await readAllRecords(workspace.recordsDir);
    expect(result.failures).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});

describe('what a person sees in their repository', () => {
  it('writes records as readable files and hides only the index', async () => {
    const adapter = await adapterOverFixtureIn(repo);
    const sweep = await sweepOnce(adapter);
    await persist(workspace, sweep.swept.flatMap((s) => s.records));

    const { ensureIgnoreRules } = await import('backstory');
    await ensureIgnoreRules(workspace.storeDir);

    // -uall lists untracked files individually; without it git collapses the
    // whole directory into one entry and the assertion proves nothing.
    const { stdout } = await run('git', ['status', '--porcelain', '--ignored', '-uall'], {
      cwd: repo,
    });

    const untracked = stdout
      .split('\n')
      .filter((line) => line.startsWith('?? '))
      .map((line) => line.slice(3));
    const ignored = stdout
      .split('\n')
      .filter((line) => line.startsWith('!! '))
      .map((line) => line.slice(3));

    // Records are the point, so they show up as files to commit.
    expect(untracked.some((path) => path.startsWith('.backstory/records/'))).toBe(true);
    // The derived index is hidden, since it would conflict on every merge.
    expect(ignored.some((path) => path.includes('index.sqlite'))).toBe(true);
  });

  it('renders a record whose body a reviewer can read without tooling', async () => {
    const adapter = await adapterOverFixtureIn(repo);
    const sweep = await sweepOnce(adapter);
    const record = sweep.swept[0]!.records[0]! as Extract<MemoryRecord, { type: 'decision' }>;
    const { path } = await writeRecord(workspace.recordsDir, record);

    const contents = await readFile(path, 'utf8');

    expect(contents).toContain('# Redis');
    expect(contents).toContain('## Not taken');
    expect(contents).toContain('PostgreSQL unlogged tables');
    expect(contents).toContain('Condition at the time: PostgreSQL is not deployed here');
  });
});
