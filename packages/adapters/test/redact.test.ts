import { describe, expect, it } from 'vitest';
import {
  containsReasoning,
  containsRedaction,
  isReasoningBlock,
  redactDeep,
  redactSecrets,
  sanitize,
  stripReasoningBlocks,
  stripReasoningDeep,
} from '../src/index.js';

/**
 * Joins a sample credential from two halves.
 *
 * Every value in this file is obviously fake; the bodies are the alphabet in
 * order. Two of them still have to carry a production prefix, because that is
 * the shape the redactor is being asked to catch, and a whole literal of that
 * shape trips secret scanners and blocks the push for anyone who clones this.
 * Split across an expression, the file holds no credential-shaped string while
 * the test still receives one.
 */
function assemble(prefix: string, body: string): string {
  return prefix + body;
}

describe('reasoning removal', () => {
  const entry = {
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'The user probably wants X because...' },
        { type: 'text', text: 'Use the existing queue abstraction.' },
        { type: 'tool_use', name: 'Read', input: { file_path: 'src/queue.ts' } },
      ],
    },
  };

  // Covers AE3.
  it('removes reasoning blocks from a session entry', () => {
    const cleaned = stripReasoningDeep(entry);

    expect(containsReasoning(cleaned)).toBe(false);
    expect(JSON.stringify(cleaned)).not.toContain('probably wants X');
  });

  it('keeps text and tool blocks alongside the removed reasoning', () => {
    const cleaned = stripReasoningDeep(entry) as typeof entry;

    expect(cleaned.message.content).toHaveLength(2);
    expect(JSON.stringify(cleaned)).toContain('existing queue abstraction');
    expect(JSON.stringify(cleaned)).toContain('src/queue.ts');
  });

  it('removes redacted reasoning blocks too', () => {
    const cleaned = stripReasoningBlocks([
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'visible' },
    ]);

    expect(cleaned).toHaveLength(1);
  });

  it('recognises reasoning under other agent vocabularies', () => {
    expect(isReasoningBlock({ type: 'reasoning', text: 'x' })).toBe(true);
    expect(isReasoningBlock({ type: 'reasoning_content', text: 'x' })).toBe(true);
    expect(isReasoningBlock({ type: 'text', text: 'x' })).toBe(false);
  });

  it('removes a reasoning-named key even when it is not a block', () => {
    const cleaned = stripReasoningDeep({ id: 1, thinking: 'internal monologue' });

    expect(cleaned).toEqual({ id: 1 });
  });

  it('filters by block type rather than by content, so prose about thinking survives', () => {
    const cleaned = stripReasoningDeep([
      { type: 'text', text: 'I was thinking we should cache this.' },
    ]);

    expect(JSON.stringify(cleaned)).toContain('thinking we should cache');
  });

  it('leaves content with no reasoning untouched', () => {
    const clean = [{ type: 'text', text: 'hello' }];
    expect(stripReasoningDeep(clean)).toEqual(clean);
  });
});

describe('secret redaction', () => {
  // Covers AE4.
  it('redacts a vendor API key and records what was removed', () => {
    const result = redactSecrets('export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv');

    expect(result.text).not.toContain('sk-ant-api03');
    expect(containsRedaction(result.text)).toBe(true);
    expect(result.redactions.map((r) => r.kind)).toContain('anthropic-key');
  });

  it('never retains the removed value, only its length', () => {
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const result = redactSecrets(`token: ${secret}`);

    expect(JSON.stringify(result.redactions)).not.toContain(secret);
    expect(result.redactions[0]?.length).toBeGreaterThan(0);
  });

  it.each([
    ['github token', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'],
    ['slack token', assemble('xox', 'b-123456789012-ABCDEFGHIJKLMNOP')],
    ['google key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
    ['aws access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['stripe key', assemble('sk_', 'live_ABCDEFGHIJKLMNOPQRSTUVWX')],
    ['jwt', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ])('redacts a %s', (_label, secret) => {
    const result = redactSecrets(`value is ${secret} here`);

    expect(result.text).not.toContain(secret);
    expect(result.redactions.length).toBeGreaterThan(0);
  });

  it('redacts an entire private key block', () => {
    const key = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const result = redactSecrets(`here it is:\n${key}\ndone`);

    expect(result.text).not.toContain('MIIEow');
    expect(result.text).toContain('done');
  });

  it('redacts credentials embedded in a URL', () => {
    const result = redactSecrets('postgres://admin:hunter2@db.internal:5432/app');

    expect(result.text).not.toContain('hunter2');
  });

  it('redacts an env-file body line by line without dropping the whole block', () => {
    const stripe = assemble('sk_', 'live_ABCDEFGHIJKLMNOPQRSTUVWX');
    const env = [
      'NODE_ENV=production',
      'DATABASE_PASSWORD=s3cretValue123',
      'PORT=3000',
      `STRIPE_SECRET_KEY=${stripe}`,
    ].join('\n');

    const result = redactSecrets(env);

    expect(result.text).toContain('NODE_ENV=production');
    expect(result.text).toContain('PORT=3000');
    expect(result.text).not.toContain('s3cretValue123');
    expect(result.text).not.toContain(stripe);
  });

  it('leaves ordinary prose about passwords alone', () => {
    const text = 'The password reset flow sends an email. We should test the password policy.';

    expect(redactSecrets(text).text).toBe(text);
  });

  it('leaves obvious placeholder values readable', () => {
    for (const line of [
      'API_KEY=your-api-key-here',
      'SECRET_TOKEN=xxxxxxxx',
      'AUTH_TOKEN=${AUTH_TOKEN}',
      'PASSWORD=changeme',
    ]) {
      expect(redactSecrets(line).text).toBe(line);
    }
  });

  it('leaves a long base64 payload that is not a credential intact', () => {
    const payload = Buffer.from('a'.repeat(200)).toString('base64');
    const text = `image data: ${payload}`;

    expect(redactSecrets(text).text).toBe(text);
  });

  it('is idempotent', () => {
    const once = redactSecrets('KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv');
    const twice = redactSecrets(once.text);

    expect(twice.text).toBe(once.text);
  });

  it('handles empty input', () => {
    expect(redactSecrets('')).toEqual({ text: '', redactions: [] });
  });

  it('walks nested structures', () => {
    const { value, redactions } = redactDeep({
      tool: 'Read',
      result: { stdout: ['GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'] },
    });

    expect(JSON.stringify(value)).not.toContain('ghp_ABCDEF');
    expect(redactions.length).toBeGreaterThan(0);
  });
});

describe('sanitize boundary', () => {
  const stripe = assemble('sk_', 'live_ABCDEFGHIJKLMNOPQRSTUVWX');
  const entry = {
    message: {
      content: [
        { type: 'thinking', thinking: 'internal' },
        { type: 'tool_result', content: `STRIPE_SECRET_KEY=${stripe}` },
      ],
    },
  };

  it('removes reasoning and secrets in one pass', () => {
    const { value, redactions } = sanitize(entry);
    const text = JSON.stringify(value);

    expect(text).not.toContain('internal');
    expect(text).not.toContain(stripe);
    expect(redactions.length).toBeGreaterThan(0);
  });

  it('still removes reasoning when secret redaction is delegated to the agent', () => {
    const { value, redactions } = sanitize(entry, { skipSecrets: true });
    const text = JSON.stringify(value);

    expect(text).not.toContain('internal');
    expect(redactions).toEqual([]);
    // The agent's own redaction is trusted for secrets, never for reasoning.
    expect(text).toContain('sk_live_');
  });
});

describe('false positives found against real session data', () => {
  it('leaves PHP and Rust scope resolution alone', () => {
    for (const text of [
      'AuthenticateWithBasicAuth::class,',
      'RedirectIfAuthenticated::class',
      'RequirePassword::class,',
    ]) {
      expect(redactSecrets(text).text).toBe(text);
    }
  });

  it('leaves boolean and numeric config values alone', () => {
    for (const text of ['withCredentials: true', 'AUTH_TIMEOUT = 3000', 'useAuth: false']) {
      expect(redactSecrets(text).text).toBe(text);
    }
  });

  it('does not run a value across an escaped newline in JSONL content', () => {
    // Session files are JSON, so line breaks arrive as a literal backslash-n.
    const line = String.raw`PUSHER_APP_SECRET=abcdef123456\nPUSHER_HOST=example.com`;
    const result = redactSecrets(line);

    expect(result.text).not.toContain('abcdef123456');
    expect(result.text).toContain('PUSHER_HOST=example.com');
  });

  it('still redacts a genuine env assignment after tightening', () => {
    const result = redactSecrets('DATABASE_PASSWORD=s3cretValue123');

    expect(result.text).not.toContain('s3cretValue123');
    expect(result.redactions).toHaveLength(1);
  });
});

describe('configuration around a credential is not the credential', () => {
  it('leaves auth-related addresses and settings readable', () => {
    for (const text of [
      'authEndpoint: /broadcasting/auth',
      'tokenUrl = https://example.com/oauth/token',
      'authHeader: Authorization',
      'tokenExpiry = 3600seconds',
      'authGuard: sanctum-web',
    ]) {
      expect(redactSecrets(text).text).toBe(text);
    }
  });

  it('still redacts the credential itself', () => {
    const result = redactSecrets('authToken = Ab3xYz90QqRs12Tv');
    expect(result.text).not.toContain('Ab3xYz90QqRs12Tv');
  });
});
