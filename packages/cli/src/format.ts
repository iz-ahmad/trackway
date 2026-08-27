import type { AlternativeHit, MemoryRecord } from '@trackway/core';

const TYPE_LABEL: Record<MemoryRecord['type'], string> = {
  question: 'QUESTION',
  discovery: 'DISCOVERY',
  decision: 'DECISION',
  action: 'ACTION',
  outcome: 'OUTCOME',
};

export function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

export function shortTime(iso: string): string {
  return iso.slice(11, 16);
}

/**
 * Who decided, in words rather than a data shape.
 *
 * The distinction between an agent proposing and a human accepting, and an
 * agent simply proceeding, is the thing the product promises to keep straight,
 * so it is spelled out rather than abbreviated.
 */
/**
 * How to address a person on screen.
 *
 * "You" is only true for one reader. A project has several developers in it and
 * their records end up in the same store, so a name is used wherever the record
 * carries one. Records written before authorship existed carry `human:local`
 * and no name, and those still read as "you" rather than inventing somebody.
 */
function personName(actor: { id: string; name?: string | undefined }): string {
  return actor.name ?? 'YOU';
}

export function describeActor(record: MemoryRecord): string {
  if (record.type === 'decision') {
    const { proposedBy, acceptedBy } = record.attribution;
    if (acceptedBy === 'implicit') return 'AGENT, no explicit approval';
    if (proposedBy.type === 'human') return personName(proposedBy);
    if (acceptedBy.type === 'human') return `AGENT, ${personName(acceptedBy)} accepted`;
    return 'AGENT';
  }

  if (record.type === 'question') {
    return record.actor.type === 'human' ? personName(record.actor) : 'AGENT';
  }
  return '';
}

export function title(record: MemoryRecord): string {
  switch (record.type) {
    case 'question':
      return record.question;
    case 'discovery':
      return record.text;
    case 'decision':
      return record.choice;
    case 'action':
      return record.description;
    case 'outcome':
      return record.text;
  }
}

export function oneLine(record: MemoryRecord): string {
  const actor = describeActor(record);
  const suffix = actor ? `  [${actor}]` : '';
  return `${record.id}  ${TYPE_LABEL[record.type].padEnd(9)} ${truncate(title(record), 68)}${suffix}`;
}

export function detail(record: MemoryRecord): string {
  const lines = [
    `${TYPE_LABEL[record.type]}  ${record.id}`,
    `${shortDate(record.createdAt)} ${shortTime(record.createdAt)}  session ${record.sessionId}`,
    '',
  ];

  switch (record.type) {
    case 'question':
      lines.push(record.question, '');
      lines.push(record.answer ?? '(unresolved)');
      lines.push('', `Asked by: ${describeActor(record)}`);
      break;

    case 'discovery':
      lines.push(record.text);
      break;

    case 'decision':
      lines.push(`Question: ${record.question}`, '', `Chose:    ${record.choice}`, '');
      lines.push(record.reason, '', `Decided by: ${describeActor(record)}`);

      if (record.alternatives.length > 0) {
        lines.push('', 'Not taken:');
        for (const alternative of record.alternatives) {
          lines.push(`  ${alternative.choice} (${alternative.status})`);
          lines.push(`    ${alternative.reason}`);
          if (alternative.condition) {
            lines.push(`    Held because: ${alternative.condition}`);
          }
        }
      }

      if (record.status === 'superseded' && record.supersededBy) {
        lines.push('', `Superseded by ${record.supersededBy}`);
      }
      break;

    case 'action':
      lines.push(record.description, '', `Status: ${record.status}`);
      if (record.files.length > 0) lines.push('', 'Files:', ...record.files.map((f) => `  ${f}`));
      break;

    case 'outcome':
      lines.push(record.text, '', `Result: ${record.result}`);
      break;
  }

  return lines.join('\n');
}

export function alternativeLine(hit: AlternativeHit): string {
  const condition = hit.condition ? `\n     held because: ${hit.condition}` : '';
  return [
    `  ${hit.choice}  (${hit.status}, ${shortDate(hit.createdAt)})`,
    `     ${hit.reason}`,
    `     instead: ${hit.decisionChoice}  [${hit.decisionId}]${condition}`,
  ].join('\n');
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
