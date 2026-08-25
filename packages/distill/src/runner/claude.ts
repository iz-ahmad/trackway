import { spawn } from 'node:child_process';
import { RunnerError, type DistillRunner, type RunOptions } from './contract.js';

const RUNNER_ID = 'claude-code';
const DEFAULT_TIMEOUT_MS = 120_000;

/** Extraction is a structured task, so it defaults to the cheap fast model. */
export const DEFAULT_DISTILL_MODEL = 'claude-haiku-4-5-20251001';

export interface ClaudeRunnerOptions {
  binary?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * Runs the developer's own Claude Code non-interactively.
 *
 * This is what makes "no second API key" real rather than aspirational: the
 * subprocess reuses the authentication already on the machine. It is still a
 * separate inference, with its own cost and rate-limit draw, which is why the
 * invocation is stripped down as far as it goes.
 *
 * A plain `claude -p` inherits the developer's settings, plugins, and MCP
 * servers. Measured against a two-word prompt that cost $0.19 a call, almost
 * all of it loading context the extractor never uses. Disabling settings, MCP,
 * and tools brings the same call to $0.02.
 *
 * It never runs inside the developer's session and never touches its context.
 */
export class ClaudeDistillRunner implements DistillRunner {
  readonly id = RUNNER_ID;

  private readonly binary: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: ClaudeRunnerOptions = {}) {
    this.binary = options.binary ?? 'claude';
    this.model = options.model ?? DEFAULT_DISTILL_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.exec(['--version'], '', 10_000);
      return { available: true };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof RunnerError ? error.message : String(error),
      };
    }
  }

  async run(prompt: string, options: RunOptions = {}): Promise<string> {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      this.model,
      // Nothing from the developer's environment. The extractor needs the model
      // and the prompt, and loading anything else is cost with no benefit.
      '--settings',
      '{}',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      // Extraction reads the prompt and writes JSON. It has no reason to touch
      // the filesystem, and denying that outright is cheaper than trusting it.
      '--disallowed-tools',
      'Bash,Read,Write,Edit,NotebookEdit,WebSearch,WebFetch,Task,Glob,Grep',
    ];

    const raw = await this.exec(args, prompt, options.timeoutMs ?? this.timeoutMs, options.signal);

    let envelope: { result?: unknown; is_error?: unknown };
    try {
      envelope = JSON.parse(raw) as typeof envelope;
    } catch (cause) {
      throw new RunnerError(RUNNER_ID, 'output', 'output was not valid JSON', { cause });
    }

    if (envelope.is_error === true) {
      throw new RunnerError(RUNNER_ID, 'exit', `agent reported an error: ${String(envelope.result)}`);
    }

    if (typeof envelope.result !== 'string') {
      throw new RunnerError(RUNNER_ID, 'output', 'response envelope carried no result text');
    }

    return envelope.result;
  }

  private exec(
    args: string[],
    input: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;

      try {
        child = spawn(this.binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (cause) {
        reject(new RunnerError(RUNNER_ID, 'unavailable', `could not start ${this.binary}`, { cause }));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() =>
          reject(new RunnerError(RUNNER_ID, 'timeout', `timed out after ${timeoutMs}ms`)),
        );
      }, timeoutMs);

      const onAbort = () => {
        child.kill('SIGKILL');
        finish(() => reject(new RunnerError(RUNNER_ID, 'timeout', 'cancelled')));
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (cause) => {
        finish(() =>
          reject(
            new RunnerError(RUNNER_ID, 'unavailable', `${this.binary} could not be run`, { cause }),
          ),
        );
      });

      child.on('close', (code) => {
        finish(() => {
          if (code === 0) resolve(stdout.trim());
          else
            reject(
              new RunnerError(
                RUNNER_ID,
                'exit',
                `exited with code ${code}: ${stderr.trim().slice(0, 300)}`,
              ),
            );
        });
      });

      child.stdin?.on('error', () => {
        // The process can exit before stdin drains. The close handler reports it.
      });
      child.stdin?.end(input);
    });
  }
}
