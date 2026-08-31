import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the single package that gets published.
 *
 * The workspace is six packages and the registry sees one. Publishing all six
 * would mean an npm organisation, six releases to keep in version lockstep,
 * and a user installing a CLI that drags in five scoped packages. Bundling the
 * workspace into the binary costs a build step and removes all of that.
 *
 * Only workspace code is inlined. Real dependencies stay external: better-sqlite3
 * is a native module that cannot be bundled at all, and inlining the rest would
 * trade a shared install for a larger tarball and a worse deduplication story.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages', 'cli');
const out = join(cli, 'npm');

const workspace = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(cli, 'package.json'), 'utf8'));

/** Every dependency any workspace package needs at runtime, minus our own. */
async function runtimeDependencies() {
  const merged = {};
  for (const name of ['core', 'adapters', 'distill', 'server', 'cli']) {
    const pkg = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8'));
    for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
      if (dep.startsWith('@trackway/')) continue;
      // Two packages disagreeing about a dependency is not something to
      // resolve by taking whichever was read last. better-sqlite3 was declared
      // ^11 in one package and ^13 in another, and the published range would
      // have permitted a native module version nothing here was tested against.
      if (merged[dep] !== undefined && merged[dep] !== range) {
        throw new Error(
          `${dep} is declared as both ${merged[dep]} and ${range} in the workspace. ` +
            'Reconcile them before publishing; the registry only sees one.',
        );
      }
      merged[dep] = range;
    }
  }
  // react and react-dom build the explorer; they are not loaded at runtime.
  delete merged.react;
  delete merged['react-dom'];
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
}

const dependencies = await runtimeDependencies();

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'bin'), { recursive: true });

await build({
  entryPoints: [join(cli, 'dist', 'bin.js')],
  outfile: join(out, 'bin', 'trackway.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: Object.keys(dependencies),
  banner: {
    // esbuild's ESM output has no require, and one transitive dependency still
    // reaches for it. Giving it one is cheaper than shipping CommonJS.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'warning',
});

const ui = join(root, 'packages', 'ui', 'dist');
if (!existsSync(join(ui, 'index.html'))) {
  throw new Error('The explorer is not built. Run `npm run build` first.');
}
await cp(ui, join(out, 'ui'), { recursive: true });

for (const file of ['README.md', 'LICENSE']) {
  if (existsSync(join(root, file))) await cp(join(root, file), join(out, file));
}

await writeFile(
  join(out, 'package.json'),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      description: 'Answers why a line of code exists, using the agent session behind it.',
      keywords: [
        'ai',
        'coding-agent',
        'decision-record',
        'adr',
        'claude-code',
        'codex',
        'git',
        'provenance',
      ],
      license: 'MIT',
      author: workspace.author,
      repository: workspace.repository,
      homepage: workspace.homepage,
      bugs: workspace.bugs,
      type: 'module',
      bin: { trackway: './bin/trackway.js' },
      files: ['bin', 'ui', 'README.md', 'LICENSE'],
      engines: workspace.engines,
      dependencies,
    },
    null,
    2,
  ) + '\n',
);

console.log(`built ${out}`);
