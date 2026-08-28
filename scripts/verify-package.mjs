import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Installs the tarball the way a user would, then uses it.
 *
 * Inspecting a build tells you what is in it, not whether it works. The
 * published layout differs from the repository in the one way that matters:
 * the explorer moves from `packages/ui/dist` to `ui/` beside the binary, and
 * the code that finds it is the code most likely to be wrong.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const staged = join(root, 'packages', 'cli', 'npm');

if (!existsSync(join(staged, 'package.json'))) {
  throw new Error('Nothing staged. Run `npm run build:package` first.');
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};

const scratch = await mkdtemp(join(tmpdir(), 'trackway-verify-'));
let server;

try {
  const { stdout: packed } = await run('npm', ['pack', '--silent'], { cwd: staged });
  const tarball = join(staged, packed.trim().split('\n').pop());

  await writeFile(join(scratch, 'package.json'), JSON.stringify({ name: 'scratch', private: true }));
  await run('npm', ['install', '--silent', tarball], { cwd: scratch });

  const cli = join(scratch, 'node_modules', '.bin', 'trackway');
  check('the binary is on the path', existsSync(cli));

  const { stdout: version } = await run(cli, ['--version']);
  check('it reports a version', /^\d+\.\d+\.\d+/.test(version.trim()), version.trim());

  const repo = join(scratch, 'repo');
  await mkdir(repo);
  await run('git', ['init', '-q'], { cwd: repo });
  await run('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  await run(cli, ['init'], { cwd: repo });
  check('it initialises a repository', existsSync(join(repo, '.trackway', 'config.yml')));

  // A recorded fork, which is the accurate path and the thing worth protecting.
  await writeFile(
    join(repo, 'chat.json'),
    JSON.stringify({
      agent: 'verify',
      sessionId: 'v1',
      cwd: '.',
      startedAt: '2026-08-28T10:00:00Z',
      entries: [
        {
          role: 'tool',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Where should rate limiting live?',
                options: [
                  { label: 'At the edge', description: 'No per-user quota.' },
                  { label: 'In the app', description: 'Costs a Redis hop.' },
                ],
              },
            ],
          },
          output: 'The user answered: "Where should rate limiting live?"="In the app"',
        },
      ],
    }),
  );

  await run(cli, ['ingest', 'chat.json'], { cwd: repo });
  const { stdout: rejected } = await run(cli, ['rejected'], { cwd: repo });
  check('a rejected option survives the round trip', rejected.includes('At the edge'));
  check('with the reason it was rejected', rejected.includes('No per-user quota'));

  const port = 7931;
  server = execFile(cli, ['graph', '--port', String(port), '--no-open'], { cwd: repo });
  await new Promise((resolve) => setTimeout(resolve, 4000));

  const get = async (path) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, type: response.headers.get('content-type') ?? '', body: await response.text() };
  };

  const page = await get('/');
  check('the explorer serves its page', page.status === 200);

  const api = await get('/api/overview');
  check('the api answers', api.status === 200);

  // The published layout moves the explorer. These two are the reason this
  // script exists rather than a look at the file list.
  const css = page.body.match(/assets\/[^"']+\.css/)?.[0];
  const styles = css ? await get(`/${css}`) : { status: 0, type: '', body: '' };
  check('its stylesheet is found in the published layout', styles.status === 200, css ?? 'no stylesheet linked');

  const font = styles.body.match(/\/fonts\/[^)'"]+\.woff2/)?.[0];
  const served = font ? await get(font) : { status: 0, type: '' };
  check('its self-hosted fonts are found', served.status === 200 && served.type.includes('font'), font ?? 'no font referenced');
  check('nothing is fetched from another host', !page.body.includes('https://') || !/fonts\.(googleapis|gstatic)/.test(page.body));
} finally {
  server?.kill();
  await rm(scratch, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.error(`\nNot publishable: ${failed.map((entry) => entry.name).join(', ')}`);
  process.exit(1);
}
