import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** One commit, with enough of it copied in to read without going back to git. */
export interface Commit {
  sha: string;
  subject: string;
  authoredAt: string;
  author: string;
  authorEmail: string;
}

export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Separators for the log format.
 *
 * A commit subject can contain anything a person can type, tabs and pipes
 * included, so the delimiters are the ASCII unit and record separators. Those
 * are the two characters the format exists for and no editor emits them.
 */
const FIELD = '\x1f';
const RECORD = '\x1e';

const LOG_FORMAT = ['%H', '%s', '%aI', '%an', '%ae'].join(FIELD);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  // execFile, never a shell: a branch or path with a space in it is an
  // argument, not three arguments and a syntax error.
  const { stdout } = await run('git', [...args], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

function parseCommit(entry: string): Commit | null {
  const parts = entry.split(FIELD);
  if (parts.length !== 5 || !parts[0]) return null;
  return {
    sha: parts[0],
    subject: parts[1] ?? '',
    authoredAt: parts[2] ?? new Date(0).toISOString(),
    author: parts[3] ?? 'unknown',
    authorEmail: parts[4] ?? '',
  };
}

/** True when this directory is inside a git working tree. */
export async function isRepository(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Commits authored in a window, oldest first.
 *
 * Author date rather than commit date. Rebasing and amending move the commit
 * date, and the question being asked is when the work happened.
 */
export async function commitsBetween(cwd: string, since: Date, until: Date): Promise<Commit[]> {
  let stdout: string;
  try {
    stdout = await git(cwd, [
      'log',
      `--since=${since.toISOString()}`,
      `--until=${until.toISOString()}`,
      `--pretty=format:${LOG_FORMAT}${RECORD}`,
      '--no-merges',
    ]);
  } catch {
    // A repository with no commits yet exits non-zero. That is not a failure
    // worth propagating: it means there is nothing to link to.
    return [];
  }

  return stdout
    .split(RECORD)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseCommit)
    .filter((commit): commit is Commit => commit !== null)
    .reverse();
}

/** The commit that last touched one line, or null when git cannot say. */
export async function blameLine(cwd: string, file: string, line: number): Promise<string | null> {
  try {
    const stdout = await git(cwd, ['blame', '-L', `${line},${line}`, '--porcelain', '--', file]);
    const sha = stdout.split(/\s/, 1)[0];
    // An uncommitted line blames to all zeroes, which is not a commit.
    if (!sha || !/^[0-9a-f]{40}$/.test(sha) || /^0+$/.test(sha)) return null;
    return sha;
  } catch {
    return null;
  }
}

/** Every commit that touched a file, oldest first, following renames. */
export async function commitsTouching(cwd: string, file: string): Promise<string[]> {
  try {
    const stdout = await git(cwd, ['log', '--pretty=format:%H', '--follow', '--', file]);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

/** One commit by hash, or null when it is not in this repository. */
export async function commitBySha(cwd: string, sha: string): Promise<Commit | null> {
  try {
    return parseCommit((await git(cwd, ['show', '-s', `--pretty=format:${LOG_FORMAT}`, sha])).trim());
  } catch {
    return null;
  }
}

/**
 * Who git thinks is working here.
 *
 * The fallback when a record has no commit to take authorship from. It is the
 * machine's answer rather than the repository's history, so it is only right
 * for whoever is sitting at it.
 */
export async function currentIdentity(cwd: string): Promise<GitIdentity | null> {
  const read = async (key: string): Promise<string> => {
    try {
      return (await git(cwd, ['config', key])).trim();
    } catch {
      // An unset key exits 1. Absent is not broken.
      return '';
    }
  };

  const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
  if (!name && !email) return null;
  return { name: name || email, email };
}
