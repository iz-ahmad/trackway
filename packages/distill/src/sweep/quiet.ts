import type { SessionDescriptor } from '@backstory/core';
import { resolve } from 'node:path';
import type { SweepState } from './state.js';
import { stateKey } from './state.js';

export type SkipReason =
  | 'still-active'
  | 'already-distilled'
  | 'other-repository'
  | 'no-working-directory'
  | 'repeatedly-failed';

export interface Eligibility {
  descriptor: SessionDescriptor;
  eligible: boolean;
  reason?: SkipReason;
}

export interface EligibilityOptions {
  quietWindowMinutes: number;
  now: Date;
  repoRoot?: string;
  /** Stops retrying a session that keeps failing, so a sweep cannot loop forever. */
  maxFailures?: number;
}

const DEFAULT_MAX_FAILURES = 3;

/**
 * Decides whether a session is ready to distil.
 *
 * A file that has stopped changing is the signal, rather than any
 * session-lifecycle event. There is no reliable "session ended" signal to hook:
 * a terminal can be closed, a session cleared, or the process killed, and none
 * of those announce themselves. A quiet file covers all three identically, and
 * a file still being written is skipped so an active session never contends
 * with the developer's own agent.
 */
export function assessEligibility(
  descriptor: SessionDescriptor,
  state: SweepState,
  options: EligibilityOptions,
): Eligibility {
  if (options.repoRoot) {
    if (!descriptor.cwd) {
      return { descriptor, eligible: false, reason: 'no-working-directory' };
    }
    if (!underRoot(descriptor.cwd, options.repoRoot)) {
      return { descriptor, eligible: false, reason: 'other-repository' };
    }
  }

  const existing = state.sessions[stateKey(descriptor.adapter, descriptor.sessionId)];

  if (existing && existing.failureCount >= (options.maxFailures ?? DEFAULT_MAX_FAILURES)) {
    return { descriptor, eligible: false, reason: 'repeatedly-failed' };
  }

  if (!isQuiet(descriptor.lastModified, options)) {
    return { descriptor, eligible: false, reason: 'still-active' };
  }

  // Unchanged since the last sweep and already processed: nothing new to read.
  if (existing && existing.lastSeenModified === descriptor.lastModified && existing.watermark >= 0) {
    return { descriptor, eligible: false, reason: 'already-distilled' };
  }

  return { descriptor, eligible: true };
}

export function isQuiet(
  lastModified: string,
  options: Pick<EligibilityOptions, 'quietWindowMinutes' | 'now'>,
): boolean {
  const modified = Date.parse(lastModified);
  if (Number.isNaN(modified)) return false;

  const quietFor = options.now.getTime() - modified;
  return quietFor >= options.quietWindowMinutes * 60_000;
}

export function underRoot(cwd: string | null, repoRoot: string): boolean {
  if (!cwd) return false;
  const root = resolve(repoRoot);
  const dir = resolve(cwd);
  return dir === root || dir.startsWith(`${root}/`);
}
