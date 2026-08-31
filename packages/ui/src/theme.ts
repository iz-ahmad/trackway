/**
 * Which ground the interface is drawn on.
 *
 * Three states rather than two. `system` sets no attribute and lets the
 * stylesheet's `prefers-color-scheme` block decide, which is the default and
 * the only one that keeps following the machine when it changes at dusk. The
 * other two pin it, and the stylesheet already answers to both.
 */
export type Theme = 'system' | 'light' | 'dark';

export const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

const KEY = 'trackway-theme';

/** Reading storage can throw outright when site data is blocked, not merely return null. */
export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // A browser that refuses storage still gets a working page on the default.
  }
  return 'system';
}

/**
 * Applies a theme and remembers it.
 *
 * `system` removes the attribute rather than setting it to a value, because
 * the stylesheet distinguishes the three states by absence: an explicit
 * `data-theme` is what beats the media query in either direction.
 */
export function applyTheme(theme: Theme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);

  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // The choice still applies to this page; it just will not outlive it.
  }
}
