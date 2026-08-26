import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ui = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ui, path), 'utf8');

/**
 * The explorer promises to open with no network.
 *
 * A single stylesheet link once undid that: the interface fetched two typefaces
 * from Google on every open, which told Google each time a developer read their
 * own decision history. Nothing in the build noticed. These tests are the thing
 * that notices.
 */
describe('the explorer makes no third-party requests', () => {
  it('the page links nothing off this machine', () => {
    const html = read('index.html');
    const external = [...html.matchAll(/(?:href|src)=["'](https?:)?\/\/[^"']+/gi)].map((m) => m[0]);
    expect(external).toEqual([]);
  });

  it('every font is served from this repository', () => {
    const css = read('src/styles.css');
    const sources = [...css.matchAll(/src:\s*url\(['"]?([^'")]+)/g)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    );

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source, `${source} is not a local path`).toMatch(/^\/fonts\//);
    }
  });

  it('every font file the stylesheet names is actually present', () => {
    const css = read('src/styles.css');
    const sources = [...css.matchAll(/src:\s*url\(['"]?\/fonts\/([^'")]+)/g)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    );

    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      expect(() => readFileSync(join(ui, 'public/fonts', file))).not.toThrow();
    }
  });

  it('no stylesheet reaches a remote host', () => {
    const css = read('src/styles.css');
    expect(css).not.toMatch(/@import|url\(['"]?https?:/i);
  });
});
