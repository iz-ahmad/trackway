import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface FailureRecord {
  at: string;
  operation: string;
  message: string;
}

export interface IsolateOptions {
  operation: string;
  /** Where to append failures. Omitted in tests and in-memory use. */
  logPath?: string;
  onFailure?: (failure: FailureRecord) => void;
}

/**
 * Runs work that must never take the caller down with it.
 *
 * Backstory runs beside a developer's coding session and, once a hook is
 * installed, inside its lifecycle. An unhandled rejection or a non-zero exit
 * from a sweep surfaces as an error in that session. Interrupting the work the
 * developer is actually doing is the one outcome this system must never cause,
 * so every entry point returns a fallback instead of throwing.
 */
export async function isolate<T>(
  work: () => Promise<T>,
  fallback: T,
  options: IsolateOptions,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const failure: FailureRecord = {
      at: new Date().toISOString(),
      operation: options.operation,
      message: error instanceof Error ? error.message : String(error),
    };

    options.onFailure?.(failure);
    if (options.logPath) await appendFailure(options.logPath, failure);

    return fallback;
  }
}

/** Synchronous counterpart, for callers that are not async. */
export function isolateSync<T>(work: () => T, fallback: T, options: IsolateOptions): T {
  try {
    return work();
  } catch (error) {
    options.onFailure?.({
      at: new Date().toISOString(),
      operation: options.operation,
      message: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

/**
 * Appends a failure to the local log.
 *
 * Logging is itself isolated. A full disk or an unwritable directory must not
 * turn a recoverable failure into a crash.
 */
export async function appendFailure(logPath: string, failure: FailureRecord): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(failure)}\n`, 'utf8');
  } catch {
    // Nothing further to do. Losing a log line is preferable to raising.
  }
}
