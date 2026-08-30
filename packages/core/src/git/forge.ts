import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Where a repository's commits can be read on the web.
 *
 * Derived when the explorer is served rather than stored on each record. A
 * remote can be added, changed, or moved to a different host long after a
 * record is written, and a URL baked into the record would then be wrong with
 * nothing to correct it.
 */
export interface Forge {
  /** Hostname, shown so a reader knows where a link goes before clicking. */
  host: string;
  /** Absolute https URL for one commit. */
  commitUrl: (sha: string) => string;
}

/** Path segment each forge puts between the repository and a commit hash. */
const COMMIT_PATH: ReadonlyArray<{ matches: (host: string) => boolean; path: string }> = [
  { matches: (host) => host === 'github.com' || host.startsWith('github.'), path: 'commit' },
  { matches: (host) => host === 'bitbucket.org', path: 'commits' },
  // GitLab's own and every self-hosted instance. The `-` separates repository
  // path from route, which is why a nested group still resolves.
  { matches: (host) => host.includes('gitlab'), path: '-/commit' },
];

/**
 * Parses a git remote into a web address.
 *
 * Both forms a remote can take, and nothing else. An unrecognised host returns
 * null rather than a guess: a link that 404s is worse than no link, and this
 * value ends up in an anchor.
 */
export function parseRemote(remote: string): Forge | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;

  let host: string;
  let path: string;

  // scp-style: git@host:owner/repo.git
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/)(.+)$/.exec(trimmed);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    // Only ever browse over https. A remote can be ssh, git, or file, and none
    // of those belong in a link a reader clicks.
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    host = url.hostname;
    path = url.pathname;
  }

  const repository = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (!host || !repository || repository.includes('..')) return null;

  const known = COMMIT_PATH.find((entry) => entry.matches(host));
  if (!known) return null;

  return {
    host,
    commitUrl: (sha) => `https://${host}/${repository}/${known.path}/${encodeURIComponent(sha)}`,
  };
}

/** The forge for a working tree, or null when there is no usable remote. */
export async function detectForge(cwd: string): Promise<Forge | null> {
  try {
    const { stdout } = await run('git', ['remote', 'get-url', 'origin'], {
      cwd,
      windowsHide: true,
    });
    return parseRemote(stdout);
  } catch {
    // No remote, or not a repository. Commits still show, just without a link.
    return null;
  }
}
