import { describe, expect, it } from 'vitest';
import { parseRemote } from '../src/index.js';

describe('turning a git remote into a web address', () => {
  it('reads the scp form every ssh remote uses', () => {
    const forge = parseRemote('git@github.com:me-shaon/trackway.git');

    expect(forge?.commitUrl('abc123')).toBe('https://github.com/me-shaon/trackway/commit/abc123');
  });

  it('reads an https remote', () => {
    const forge = parseRemote('https://github.com/me-shaon/trackway.git');

    expect(forge?.commitUrl('abc123')).toBe('https://github.com/me-shaon/trackway/commit/abc123');
  });

  it('keeps a nested group path intact', () => {
    const forge = parseRemote('git@gitlab.com:team/sub/project.git');

    expect(forge?.commitUrl('abc')).toBe('https://gitlab.com/team/sub/project/-/commit/abc');
  });

  it('uses the route each forge actually serves commits on', () => {
    expect(parseRemote('git@bitbucket.org:t/r.git')?.commitUrl('a')).toContain('/commits/a');
    expect(parseRemote('git@gitlab.com:t/r.git')?.commitUrl('a')).toContain('/-/commit/a');
    expect(parseRemote('git@github.com:t/r.git')?.commitUrl('a')).toContain('/commit/a');
  });

  it('recognises a self-hosted gitlab by its hostname', () => {
    const forge = parseRemote('git@gitlab.acme.internal:team/app.git');

    expect(forge?.commitUrl('a')).toBe('https://gitlab.acme.internal/team/app/-/commit/a');
  });

  it('browses over https even when the remote is ssh', () => {
    // A reader clicks this. ssh:// in an anchor is not a link.
    const forge = parseRemote('ssh://git@github.com/t/r.git');

    expect(forge?.commitUrl('a').startsWith('https://')).toBe(true);
  });

  it('offers no link for a host it does not know', () => {
    // A link that 404s is worse than no link, and this ends up in an anchor.
    expect(parseRemote('git@git.unknown-host.example:t/r.git')).toBeNull();
  });

  it('refuses a local path, which has nothing to browse', () => {
    expect(parseRemote('/srv/git/repo.git')).toBeNull();
    expect(parseRemote('file:///srv/git/repo.git')).toBeNull();
  });

  it('refuses anything that is not a remote at all', () => {
    expect(parseRemote('')).toBeNull();
    expect(parseRemote('   ')).toBeNull();
    expect(parseRemote('not a url')).toBeNull();
  });

  it('refuses a path trying to climb out of the repository', () => {
    expect(parseRemote('git@github.com:../../etc/passwd')).toBeNull();
  });

  it('escapes the hash rather than pasting it into a URL', () => {
    const forge = parseRemote('git@github.com:t/r.git');

    expect(forge?.commitUrl('a b/../x')).not.toContain('../');
  });

  it('names the host, so a reader knows where a link goes', () => {
    expect(parseRemote('git@github.com:t/r.git')?.host).toBe('github.com');
  });
});
