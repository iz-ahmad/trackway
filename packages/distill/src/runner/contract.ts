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
