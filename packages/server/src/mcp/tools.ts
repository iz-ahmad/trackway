import {
  getRecord,
  listRecords,
  search,
  searchAlternatives,
  type IndexDatabase,
  type MemoryRecord,
} from '@backstory/core';

/**
 * How a record is presented to a consuming agent.
 *
 * Records are prior evidence, not instructions. The framing is deliberate:
 * without a date and an author, "cancellation is asynchronous" reads as a rule
 * the agent must obey, and a stale or mistaken record then becomes a binding
 * constraint on work it should not constrain. With them it reads as something
 * a person decided on a day, which the agent can weigh.
 */
export function renderRecord(record: MemoryRecord): string {
  const when = record.createdAt.slice(0, 10);
  const lines: string[] = [];

  switch (record.type) {
    case 'decision': {
      const who = describeDecider(record);
      lines.push(`On ${when}, ${who} chose: ${record.choice}`);
      lines.push(`  Question at the time: ${record.question}`);
      lines.push(`  Reason given: ${record.reason}`);

      for (const alternative of record.alternatives) {
        lines.push(`  Considered and ${alternative.status}: ${alternative.choice}`);
        lines.push(`    Reason: ${alternative.reason}`);
        if (alternative.condition) {
          lines.push(`    True at the time: ${alternative.condition}`);
        }
      }

      if (record.status === 'superseded') {
        lines.push(`  This decision was later superseded${record.supersededBy ? ` by ${record.supersededBy}` : ''}.`);
      }
      break;
    }

    case 'discovery':
      lines.push(`On ${when}, this was observed: ${record.text}`);
      break;

    case 'question':
      lines.push(
        record.status === 'open'
          ? `On ${when}, this was asked and left unresolved: ${record.question}`
          : `On ${when}, this was asked: ${record.question}`,
      );
      if (record.answer) lines.push(`  Answer recorded: ${record.answer}`);
      break;

    case 'action':
      lines.push(`On ${when}, this work was done: ${record.description}`);
      if (record.files.length > 0) lines.push(`  Files: ${record.files.join(', ')}`);
      break;

    case 'outcome':
      lines.push(`On ${when}, the outcome was ${record.result}: ${record.text}`);
      break;
  }

  lines.push(`  [${record.id}, from session ${record.sessionId}]`);
  return lines.join('\n');
}

function describeDecider(record: Extract<MemoryRecord, { type: 'decision' }>): string {
  const { proposedBy, acceptedBy } = record.attribution;

  if (acceptedBy === 'implicit') return 'the agent, with no recorded human approval,';
  if (proposedBy.type === 'agent' && acceptedBy.type === 'human') {
    return 'the agent proposed and a person accepted, so they';
  }
  if (proposedBy.type === 'human') return 'a person';
  return 'the agent';
}

const PREAMBLE =
  'These are records of what was decided and observed previously. They describe past reasoning, not current requirements. Weigh them against what you find in the code now.';

export function renderResults(records: readonly MemoryRecord[], emptyMessage: string): string {
  if (records.length === 0) return emptyMessage;
  return [PREAMBLE, '', ...records.map(renderRecord)].join('\n\n');
}

export interface ToolContext {
  db: IndexDatabase;
}

export function memorySearch(context: ToolContext, query: string, limit = 20): string {
  const hits = search(context.db, query, { limit });
  return renderResults(
    hits.map((hit) => hit.record),
    `Nothing recorded matches "${query}".`,
  );
}

export function memoryGet(context: ToolContext, id: string): string {
  const record = getRecord(context.db, id);
  return record ? renderResults([record], '') : `No record with id ${id}.`;
}

/**
 * What was decided about a topic or a file.
 *
 * Rejected options are surfaced alongside, because the reason an agent should
 * consult this at all is to avoid re-proposing something already ruled out.
 */
export function memoryContext(context: ToolContext, topic: string, limit = 15): string {
  const hits = search(context.db, topic, { limit });
  const alternatives = searchAlternatives(context.db, topic, { limit: 10 });

  const sections: string[] = [];

  if (hits.length > 0) {
    sections.push(renderResults(hits.map((hit) => hit.record), ''));
  }

  if (alternatives.length > 0) {
    sections.push(
      [
        'Options considered previously and not taken:',
        ...alternatives.map((alternative) =>
          [
            `  ${alternative.choice} (${alternative.status} on ${alternative.createdAt.slice(0, 10)})`,
            `    Reason: ${alternative.reason}`,
            alternative.condition ? `    True at the time: ${alternative.condition}` : '',
            `    Chosen instead: ${alternative.decisionChoice}`,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      ].join('\n'),
    );
  }

  return sections.length > 0 ? sections.join('\n\n') : `Nothing recorded about "${topic}".`;
}

export function memoryRejected(context: ToolContext, topic: string, limit = 20): string {
  const alternatives = searchAlternatives(context.db, topic, { limit });

  if (alternatives.length === 0) return `No discarded options recorded about "${topic}".`;

  return [
    'Options that were considered and not taken. Each records why, as of the date shown.',
    '',
    ...alternatives.map((alternative) =>
      [
        `${alternative.choice}: ${alternative.status} on ${alternative.createdAt.slice(0, 10)}`,
        `  Reason: ${alternative.reason}`,
        alternative.condition ? `  True at the time: ${alternative.condition}` : '',
        `  Chosen instead: ${alternative.decisionChoice} [${alternative.decisionId}]`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ].join('\n\n');
}

export function memoryRecent(context: ToolContext, limit = 20): string {
  return renderResults(listRecords(context.db, { limit }), 'Nothing recorded yet.');
}
