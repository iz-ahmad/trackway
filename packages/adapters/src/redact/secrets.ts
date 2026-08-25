export interface Redaction {
  kind: string;
  /** Character count removed. The value itself is never retained. */
  length: number;
}

export interface RedactionResult {
  text: string;
  redactions: Redaction[];
}

interface Pattern {
  kind: string;
  regex: RegExp;
}

/**
 * Known credential shapes.
 *
 * Deliberately specific. A loose pattern that redacts ordinary prose makes
 * records useless, which is its own kind of failure.
 */
const PATTERNS: Pattern[] = [
  { kind: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'openai-key', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { kind: 'slack-token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'google-key', regex: /\bAIza[A-Za-z0-9_-]{35}/g },
  { kind: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'stripe-key', regex: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'private-key', regex: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g },
  { kind: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: 'bearer-token', regex: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { kind: 'url-credentials', regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/gi },
];

/**
 * Assignment detection is a match plus explicit validation rather than one
 * regex. Every attempt to express it as a single pattern produced false
 * positives against real transcripts: PHP scope resolution, TypeScript type
 * annotations, and secret words appearing mid-token inside base64 blobs.
 */
const ASSIGNMENT =
  /([A-Za-z_][A-Za-z0-9_-]{0,63})\s*(?:=|:(?!:))\s*(["']?)([^\s"'`,;)}\]\\]{6,200})\2/g;

/** Words that make a key name look like it holds a credential. */
const SECRET_WORDS = new Set([
  'secret', 'secrets', 'password', 'passwd', 'pwd', 'token', 'apikey', 'accesskey',
  'privatekey', 'credential', 'credentials', 'auth', 'authorization', 'bearer',
  'signature', 'passphrase', 'dsn',
]);

/** Splits an identifier into lowercase words across snake, kebab, and camel case. */
function tokenizeKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+|\s+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * True when the key name marks the value as a credential.
 *
 * The secret word must be a whole token. Requiring that is what stops `AuTH`
 * inside a random identifier from making the following text look like a key.
 */
/**
 * Key suffixes that describe configuration around a credential rather than the
 * credential itself. `authEndpoint` and `tokenUrl` are addresses, not secrets.
 */
const CONFIG_SUFFIXES = new Set([
  'endpoint', 'url', 'uri', 'path', 'host', 'hostname', 'port', 'type', 'name',
  'header', 'method', 'scheme', 'enabled', 'expiry', 'expires', 'ttl', 'timeout',
  'provider', 'strategy', 'guard', 'driver', 'prefix', 'field', 'column',
]);

function keyLooksSecret(key: string): boolean {
  const tokens = tokenizeKey(key);

  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && last !== undefined && CONFIG_SUFFIXES.has(last)) return false;
  if (tokens.some((token) => SECRET_WORDS.has(token))) return true;

  // Two-token forms that only read as secrets together: api_key, access_key.
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const pair = `${tokens[i]}${tokens[i + 1]}`;
    if (SECRET_WORDS.has(pair)) return true;
  }

  return false;
}

/** Type names and config literals that are never credential values. */
const NON_SECRET_VALUES = new Set([
  'true', 'false', 'null', 'undefined', 'nil', 'none', 'off', 'on', 'yes', 'no',
  'string', 'number', 'boolean', 'object', 'array', 'any', 'unknown', 'void',
  'class', 'extends', 'implements', 'function', 'const', 'import', 'export',
  'required', 'optional', 'nullable', 'text', 'varchar', 'integer',
]);

/**
 * True when a value has the shape of a real credential.
 *
 * Real keys carry entropy. Requiring a digit, mixed case, or a symbol filters
 * out ordinary words that follow a secret-sounding key, which is where most
 * false positives came from.
 */
function valueLooksSecret(value: string): boolean {
  if (value.length < 8) return false;
  if (NON_SECRET_VALUES.has(value.toLowerCase())) return false;
  if (OBVIOUS_PLACEHOLDERS.test(value)) return false;
  if (value.startsWith('[redacted:')) return false;
  // A value starting with $ is a variable reference, never a literal secret.
  if (/^[$./~]/.test(value)) return false;

  const hasDigit = /\d/.test(value);
  const hasMixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value);
  const hasSymbol = /[_\-+/=~.]/.test(value);

  return hasDigit || hasMixedCase || hasSymbol;
}

const PLACEHOLDER = (kind: string) => `[redacted:${kind}]`;

/**
 * Values that look like a secret but are not, so redacting them only loses
 * information. These appear constantly in real config files.
 */
const OBVIOUS_PLACEHOLDERS =
  /^(?:your[\w-]*|my[\w-]*|xxx+|placeholder|changeme|change[-_]?me|todo|tbd|none|null|undefined|example[\w-]*|test[-_]?(?:key|token|secret)|<[^>]*>|\$\{[^}]*\}|\*+|\.{3,})$/i;

/**
 * Removes credential-shaped content.
 *
 * Best effort by design and documented as such. A secret shaped like ordinary
 * prose passes, and no pattern set fixes that. The goal is to catch the shapes
 * that actually leak: keys, tokens, and env-file assignments.
 */
export function redactSecrets(text: string): RedactionResult {
  if (text.length === 0) return { text, redactions: [] };

  const redactions: Redaction[] = [];
  let output = text;

  for (const { kind, regex } of PATTERNS) {
    output = output.replace(new RegExp(regex.source, regex.flags), (match) => {
      redactions.push({ kind, length: match.length });
      return PLACEHOLDER(kind);
    });
  }

  output = output.replace(ASSIGNMENT, (match, key: string, quote: string, value: string) => {
    if (!keyLooksSecret(key)) return match;
    if (!valueLooksSecret(value)) return match;

    redactions.push({ kind: 'assignment', length: value.length });
    return `${key}=${quote}${PLACEHOLDER('assignment')}${quote}`;
  });

  return { text: output, redactions };
}

/** Walks a value of any shape, redacting every string it contains. */
export function redactDeep(value: unknown): { value: unknown; redactions: Redaction[] } {
  const redactions: Redaction[] = [];

  function walk(node: unknown): unknown {
    if (typeof node === 'string') {
      const result = redactSecrets(node);
      redactions.push(...result.redactions);
      return result.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([key, val]) => [key, walk(val)]),
      );
    }
    return node;
  }

  return { value: walk(value), redactions };
}

export function containsRedaction(text: string): boolean {
  return text.includes('[redacted:');
}
