import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Attribution } from '../models/actor.js';
import { MemoryRecord } from '../models/record.js';

const FENCE = '---';

/**
 * Records are markdown with YAML frontmatter. The frontmatter carries the
 * complete record and is what round-trips; the body is a rendering for humans
 * reading the file in a diff or on GitHub.
 *
 * Nothing parses the body. It can be regenerated from frontmatter at any time.
 */
export function serializeRecord(record: MemoryRecord): string {
  const frontmatter = stringifyYaml(record, { lineWidth: 0 }).trimEnd();
  return `${FENCE}\n${frontmatter}\n${FENCE}\n\n${renderBody(record)}\n`;
}

export function deserializeRecord(contents: string): MemoryRecord {
  const trimmed = contents.trimStart();
  if (!trimmed.startsWith(FENCE)) {
    throw new MalformedRecordError('file does not start with YAML frontmatter');
  }

  const end = trimmed.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) {
    throw new MalformedRecordError('frontmatter is not terminated');
  }

  const raw = trimmed.slice(FENCE.length, end);

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (cause) {
    throw new MalformedRecordError('frontmatter is not valid YAML', { cause });
  }

  const result = MemoryRecord.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new MalformedRecordError(`frontmatter is not a valid record (${detail})`);
  }

  return result.data;
}

/**
 * Raised when a record file cannot be read. Callers skip the file and keep
 * going: one bad record must never make the rest of the store unreadable.
 */
export class MalformedRecordError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MalformedRecordError';
  }
}

function renderBody(record: MemoryRecord): string {
  switch (record.type) {
    case 'question': {
      const status = record.status === 'open' ? 'Unresolved' : 'Resolved';
      const answer = record.answer ?? '_No answer recorded._';
      return [`# ${record.question}`, '', `**${status}**`, '', answer].join('\n');
    }

    case 'discovery':
      return [`# Discovery`, '', record.text].join('\n');

    case 'decision': {
      const lines = [`# ${record.choice}`, '', `**Question:** ${record.question}`, ''];
      lines.push(record.reason, '');
      lines.push(`**Decided by:** ${describeAttribution(record.attribution)}`);

      if (record.alternatives.length > 0) {
        lines.push('', '## Not taken', '');
        for (const alt of record.alternatives) {
          lines.push(`- **${alt.choice}** (${alt.status}): ${alt.reason}`);
          if (alt.condition) lines.push(`  - Condition at the time: ${alt.condition}`);
        }
      }

      if (record.status === 'superseded' && record.supersededBy) {
        lines.push('', `**Superseded by:** ${record.supersededBy}`);
      }

      return lines.join('\n');
    }

    case 'action': {
      const lines = [`# ${record.description}`, '', `**Status:** ${record.status}`];
      if (record.files.length > 0) {
        lines.push('', '## Files', '');
        for (const file of record.files) lines.push(`- \`${file}\``);
      }
      return lines.join('\n');
    }

    case 'outcome':
      return [`# Outcome`, '', `**Result:** ${record.result}`, '', record.text].join('\n');
  }
}

function describeAttribution(attribution: Attribution): string {
  const proposed = `${attribution.proposedBy.type} ${attribution.proposedBy.id}`;
  if (attribution.acceptedBy === 'implicit') {
    return `proposed by ${proposed}, no explicit approval recorded`;
  }
  const accepted = `${attribution.acceptedBy.type} ${attribution.acceptedBy.id}`;
  return `proposed by ${proposed}, accepted by ${accepted}`;
}
