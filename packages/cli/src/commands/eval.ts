import { ClaudeCodeAdapter } from '@trackway/adapters';
import {
  ClaudeDistillRunner,
  createDistiller,
  createJudge,
  runEval,
  summarize,
} from '@trackway/distill';
import type { Io } from './index.js';

export interface EvalCommandOptions {
  limit?: number;
  json?: boolean;
}

/**
 * Measures extraction against the answer key the sessions carry themselves.
 *
 * Reports, never gates. Suppressing a useful record to protect a score would be
 * the wrong trade, so this exists to tune the extractor and to make a
 * regression visible when the prompt changes.
 */
export async function evalCommand(
  options: EvalCommandOptions,
  io: Io,
): Promise<number> {
  const runner = new ClaudeDistillRunner();

  const availability = await runner.isAvailable();
  if (!availability.available) {
    io.err(`Cannot run the evaluation: ${availability.reason ?? 'no agent available'}`);
    return 1;
  }

  const limit = options.limit ?? 5;
  if (!options.json) {
    io.out(`Scoring up to ${limit} sessions. Each one costs a model call, so this takes a while.\n`);
  }

  const report = await runEval({
    adapter: new ClaudeCodeAdapter(),
    distill: createDistiller({ runner }),
    judge: createJudge(runner),
    limit,
    ...(options.json ? {} : { onProgress: (message) => io.out(message) }),
  });

  if (options.json) {
    io.out(JSON.stringify(report, null, 2));
    return 0;
  }

  io.out(`\nSessions carrying an answer key: ${report.candidates}`);
  io.out(summarize(report.sessions));

  if (report.failures.length > 0) {
    io.out(`\nFailed to score ${report.failures.length}:`);
    for (const failure of report.failures) {
      io.err(`  ${failure.sessionId.slice(0, 12)}  ${failure.reason.slice(0, 90)}`);
    }
  }

  io.out('\nThis measures quality. It does not gate anything.');
  return 0;
}
