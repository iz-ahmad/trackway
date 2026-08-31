/**
 * Runs a prompt through a coding agent non-interactively and returns its raw
 * text output.
 *
 * Mirrors the adapter contract so a second implementation can be added without
 * touching anything above it. The runner knows nothing about records: it takes
 * a prompt, returns text, and the layer above validates.
 */
export interface DistillRunner {
  readonly id: string;

  /** Whether this runner can be used right now. Never throws. */
  isAvailable(): Promise<{ available: boolean; reason?: string }>;

  /**
   * Runs the prompt. Throws RunnerError on any failure, including a non-zero
   * exit, a timeout, or unreadable output.
   */
  run(prompt: string, options?: RunOptions): Promise<string>;
}

/**
 * Set in every distillation subprocess, so a sweep can tell it is already
 * inside one.
 *
 * A coding agent runs the developer's hooks when a session ends, and the hook
 * Trackway installs starts a sweep. A sweep distils by starting an agent
 * session, so the sweep's own subprocess fired the hook that starts a sweep.
 * Measured on a real machine: thirty-nine concurrent syncs inside a few
 * minutes, each spawning its own model calls.
 *
 * Disabling hooks in the child is not available: the flag that does it also
 * turns off the OAuth the whole design depends on. So the recursion is broken
 * from Trackway's side instead, which has the advantage of working the same way
 * for every agent rather than depending on one agent's flags.
 */
export const DISTILL_ENV_MARKER = 'TRACKWAY_DISTILLING';

/** True when this process was started by a distillation run. */
export function insideDistillation(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DISTILL_ENV_MARKER] === '1';
}

/** The environment a runner subprocess gets. */
export function distillEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, [DISTILL_ENV_MARKER]: '1' };
}

export interface RunOptions {
  /** Milliseconds before the process is killed. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class RunnerError extends Error {
  constructor(
    readonly runnerId: string,
    readonly kind: 'unavailable' | 'timeout' | 'exit' | 'output',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${runnerId}: ${message}`, options);
    this.name = 'RunnerError';
  }
}
