import { describe, expect, it } from 'vitest';
import type { MemoryEvent } from '@trackway/core';
import {
  EXTRACTION_MARKER,
  RunnerError,
  buildPrompt,
  collectText,
  createRunnerChain,
  defaultRunners,
  distillEnv,
  insideDistillation,
  isFatal,
  isOwnExtraction,
  runnerWorkingDir,
  type DistillRunner,
} from '../src/index.js';

function eventAt(offset: number, type: MemoryEvent['type'], payload: unknown): MemoryEvent {
  return {
    id: `claude-code:ses-1:${offset}`,
    sessionId: 'ses-1',
    timestamp: '2026-08-31T09:00:00Z',
    type,
    actor: type === 'user_prompt' ? { type: 'human', id: 'human:local' } : { type: 'agent', id: 'agent:claude-code' },
    payload,
    source: { adapter: 'claude-code', sessionFile: '/tmp/ses-1.jsonl', offset },
  };
}

function stub(id: string, behaviour: () => Promise<string>): DistillRunner {
  return { id, isAvailable: async () => ({ available: true }), run: behaviour };
}

describe('refusing to distil our own distillation', () => {
  /*
   * A sweep distils by starting an agent session, and the agent records that
   * session like any other. Those were then discovered and distilled, which
   * started more of them. On this repository 143 of 151 discovered sessions
   * were Trackway's own calls.
   */
  it('recognises a session that is one of our extraction calls', () => {
    const events = [
      eventAt(0, 'user_prompt', { content: buildPrompt({ events: [], adapterId: 'claude-code' }) }),
      eventAt(1, 'agent_message', { content: [{ type: 'text', text: '{}' }] }),
    ];

    expect(isOwnExtraction(events)).toBe(true);
  });

  // The payload is adapter-shaped. Reading `payload.text` matched none of 151
  // real sessions, because Claude Code calls the field `content`.
  it('finds the prompt wherever the adapter put it', () => {
    expect(isOwnExtraction([eventAt(0, 'user_prompt', { content: EXTRACTION_MARKER })])).toBe(true);
    expect(isOwnExtraction([eventAt(0, 'user_prompt', { text: EXTRACTION_MARKER })])).toBe(true);
    expect(
      isOwnExtraction([eventAt(0, 'user_prompt', { content: [{ type: 'text', text: EXTRACTION_MARKER }] })]),
    ).toBe(true);
  });

  it('leaves real work alone', () => {
    const events = [
      eventAt(0, 'user_prompt', { content: 'Why is the cache invalidating on every write?' }),
      eventAt(1, 'agent_message', { content: [{ type: 'text', text: 'Because the key includes a timestamp.' }] }),
    ];

    expect(isOwnExtraction(events)).toBe(false);
  });

  // The marker has to survive the prompt being edited, so it is derived from
  // the prompt rather than copied out of it.
  it('takes its marker from the prompt itself', () => {
    expect(buildPrompt({ events: [], adapterId: 'claude-code' })).toContain(EXTRACTION_MARKER);
  });
});

describe('not starting a sweep from inside a sweep', () => {
  /*
   * The agent runs the developer's hooks when a session ends, and the hook
   * Trackway installs starts a sweep. The sweep's own subprocess therefore
   * fired the hook that starts a sweep. Thirty-nine concurrent syncs appeared
   * on a real machine within a few minutes.
   */
  it('marks the subprocess environment', () => {
    expect(distillEnv({ PATH: '/usr/bin' })).toMatchObject({
      PATH: '/usr/bin',
      TRACKWAY_DISTILLING: '1',
    });
  });

  it('recognises the mark', () => {
    expect(insideDistillation({ TRACKWAY_DISTILLING: '1' })).toBe(true);
    expect(insideDistillation({})).toBe(false);
  });

  it('runs subprocesses outside any repository', () => {
    // Claude Code records the working directory, and Trackway matches sessions
    // to a repository by exactly that. Run from the repository and every call
    // produces a session the next sweep picks up.
    expect(runnerWorkingDir('/home/dev')).toBe('/home/dev/.trackway/runner');
  });
});

describe('falling back to whichever agent this machine has', () => {
  it('uses the first runner that works', async () => {
    const chain = createRunnerChain([
      stub('claude-code', async () => 'from claude'),
      stub('codex', async () => 'from codex'),
    ]);

    expect(await chain.run('prompt')).toBe('from claude');
  });

  it('moves on when a runner is not installed', async () => {
    const chain = createRunnerChain([
      stub('claude-code', async () => {
        throw new RunnerError('claude-code', 'unavailable', 'could not start claude');
      }),
      stub('codex', async () => 'from codex'),
    ]);

    expect(await chain.run('prompt')).toBe('from codex');
  });

  /*
   * A runner can pass an availability check and still fail every call: `codex
   * exec` printed its version happily and then returned 402 Payment Required
   * with `deactivated_workspace` on a real machine.
   */
  it('treats an account failure as fatal, not as something to retry', () => {
    const dead = new RunnerError('codex', 'exit', 'exited with code 1: unexpected status 402 Payment Required');
    const stalled = new RunnerError('claude-code', 'timeout', 'timed out after 300000ms');

    expect(isFatal(dead)).toBe(true);
    expect(isFatal(stalled)).toBe(false);
  });

  it('falls through an account failure to the next agent', async () => {
    const chain = createRunnerChain([
      stub('codex', async () => {
        throw new RunnerError('codex', 'exit', 'exited with code 1: 402 Payment Required');
      }),
      stub('opencode', async () => 'from opencode'),
    ]);

    expect(await chain.run('prompt')).toBe('from opencode');
  });

  it('stops asking a runner that already proved dead', async () => {
    let asked = 0;
    const chain = createRunnerChain([
      stub('codex', async () => {
        asked += 1;
        throw new RunnerError('codex', 'exit', 'exited with code 1: 401 unauthorized');
      }),
      stub('opencode', async () => 'from opencode'),
    ]);

    await chain.run('one');
    await chain.run('two');
    await chain.run('three');

    expect(asked).toBe(1);
  });

  // A timeout is circumstance. Handing it to the next agent would spend a
  // second full call on something the caller is about to retry anyway.
  it('lets a transient failure reach the caller instead of switching agent', async () => {
    let secondAsked = false;
    const chain = createRunnerChain([
      stub('claude-code', async () => {
        throw new RunnerError('claude-code', 'timeout', 'timed out');
      }),
      stub('codex', async () => {
        secondAsked = true;
        return 'from codex';
      }),
    ]);

    await expect(chain.run('prompt')).rejects.toThrow(RunnerError);
    expect(secondAsked).toBe(false);
  });

  it('offers every shipped agent, Claude first because its call is cheapest', () => {
    expect(defaultRunners().map((runner) => runner.id)).toEqual(['claude-code', 'codex', 'opencode']);
  });
});

describe('reading an OpenCode run back', () => {
  it('joins the text parts and ignores the lifecycle around them', () => {
    const stream = [
      JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: '{"decisions":' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: '[]}' } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish' } }),
    ].join('\n');

    expect(collectText(stream)).toBe('{"decisions":[]}');
  });

  // OpenCode's event vocabulary is internal, not a published contract, so an
  // unfamiliar line should cost nothing.
  it('skips a line it cannot parse rather than refusing the run', () => {
    expect(collectText('not json\n' + JSON.stringify({ type: 'text', part: { text: 'ok' } }))).toBe('ok');
  });
});

describe('telling a deliberate skip from an agent that cannot distil', () => {
  // Reporting our own exhaust as "this agent cannot distil" told the reader
  // the wrong thing about 143 of 151 sessions.
  it('carries the reason a session was declined', async () => {
    const { markSkipped, skippedReason } = await import('../src/index.js');

    expect(skippedReason(markSkipped('one of our own distillation calls'))).toBe(
      'one of our own distillation calls',
    );
    expect(skippedReason([])).toBeUndefined();
    expect(skippedReason(null)).toBeUndefined();
  });
});
