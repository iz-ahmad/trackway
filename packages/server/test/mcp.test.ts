import { openIndex, upsertRecords, type IndexDatabase, type MemoryRecord } from '@backstory/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MCP_TOOL_NAMES,
  createMcpServer,
  memoryContext,
  memoryGet,
  memoryRejected,
  memorySearch,
  renderRecord,
} from '../src/index.js';

let db: IndexDatabase;

const decision: MemoryRecord = {
  id: 'dec-20260825-aaaaaaaa',
  type: 'decision',
  sessionId: 'ses-1',
  episodeId: null,
  significance: 'technical',
  createdAt: '2026-06-12T09:18:00Z',
  source: {
    adapter: 'claude-code',
    sessionId: 'ses-1',
    sessionFile: '/tmp/ses-1.jsonl',
    fromOffset: 0,
    toOffset: 12,
  },
  question: 'Should subscription cancellation be synchronous?',
  choice: 'Asynchronous cancellation via the queue',
  reason: 'Provider callbacks can take several seconds.',
  alternatives: [
    {
      choice: 'Synchronous cancellation in the request',
      status: 'rejected',
      reason: 'Would block the request for the callback duration.',
      condition: 'Provider callbacks take several seconds',
    },
  ],
  attribution: {
    proposedBy: { type: 'agent', id: 'agent:claude-code' },
    acceptedBy: { type: 'human', id: 'human:local' },
  },
  status: 'accepted',
  supersededBy: null,
  relationships: [],
};

const implicitDecision: MemoryRecord = {
  ...decision,
  id: 'dec-20260825-cccccccc',
  question: 'Which log level for the cancellation worker?',
  choice: 'Warn',
  reason: 'Matches the rest of the workers.',
  alternatives: [],
  attribution: {
    proposedBy: { type: 'agent', id: 'agent:claude-code' },
    acceptedBy: 'implicit',
  },
};

beforeEach(() => {
  db = openIndex(':memory:');
  upsertRecords(db, [decision, implicitDecision]);
});

afterEach(() => {
  db.close();
});

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ db });
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
  };
  return result.content.map((part) => part.text ?? '').join('\n');
}

describe('the MCP surface', () => {
  it('exposes the retrieval tools', async () => {
    const client = await connect();

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it('exposes no tool that writes a record', async () => {
    const client = await connect();

    const { tools } = await client.listTools();

    // Distillation stays the single write path. A second one would have its own
    // failure modes and its own attribution, with no way to tell them apart.
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/record|write|create|add|save|delete|update/i);
    }
  });

  it('answers a search with dated attributed records', async () => {
    const client = await connect();

    const text = await callText(client, 'memory_search', { query: 'cancellation' });

    expect(text).toContain('2026-06-12');
    expect(text).toContain('dec-20260825-aaaaaaaa');
    expect(text).toContain('from session ses-1');
  });

  it('frames records as past reasoning rather than current requirements', async () => {
    const client = await connect();

    const text = await callText(client, 'memory_search', { query: 'cancellation' });

    expect(text).toContain('not current requirements');
    expect(text).toContain('Weigh them against what you find in the code now');
  });

  it('uses no imperative phrasing that would read as a rule', async () => {
    const text = memorySearch({ db }, 'cancellation');

    // "Do not make cancellation synchronous" is the failure this avoids: a
    // record stated as a command becomes a constraint the agent cannot weigh.
    expect(text).not.toMatch(/\bdo not\b|\bmust\b|\bnever\b|\balways\b/i);
  });

  it('surfaces options that were ruled out, with the reason', async () => {
    const client = await connect();

    const text = await callText(client, 'memory_rejected', { topic: 'cancellation' });

    expect(text).toContain('Synchronous cancellation in the request');
    expect(text).toContain('Would block the request');
    expect(text).toContain('Chosen instead: Asynchronous cancellation via the queue');
  });

  it('reports the condition that made a rejection valid at the time', async () => {
    const text = memoryRejected({ db }, 'cancellation');

    expect(text).toContain('True at the time: Provider callbacks take several seconds');
  });

  it('gives context on a topic including what was ruled out', async () => {
    const client = await connect();

    const text = await callText(client, 'memory_context', { topic: 'cancellation' });

    expect(text).toContain('Asynchronous cancellation via the queue');
    expect(text).toContain('not taken');
  });

  it('says plainly when nothing is recorded about a topic', async () => {
    const client = await connect();

    const text = await callText(client, 'memory_context', { topic: 'kubernetes' });

    expect(text).toContain('Nothing recorded about');
  });

  it('fetches one record by id', async () => {
    const client = await connect();

    const text = await callText(client, 'memory_get', { id: decision.id });

    expect(text).toContain('Asynchronous cancellation via the queue');
  });

  it('reports an unknown id rather than returning nothing', async () => {
    const client = await connect();

    expect(await callText(client, 'memory_get', { id: 'dec-nope' })).toContain('No record with id');
  });

  it('returns recent memory', async () => {
    const client = await connect();

    expect(await callText(client, 'memory_recent', { limit: 5 })).toContain('dec-2026');
  });
});

describe('how a record reads to an agent', () => {
  it('names a person as the decider when a person accepted', () => {
    expect(renderRecord(decision)).toContain('the agent proposed and a person accepted');
  });

  it('says plainly when the agent proceeded with no approval', () => {
    // Claiming a human approved something they never saw would make the whole
    // store untrustworthy, so this reads exactly as what happened.
    expect(renderRecord(implicitDecision)).toContain('with no recorded human approval');
  });

  it('marks a superseded decision as superseded', () => {
    const superseded = { ...decision, status: 'superseded' as const, supersededBy: 'dec-later' };

    expect(renderRecord(superseded)).toContain('later superseded by dec-later');
  });

  it('marks an unresolved question as unresolved', () => {
    const question: MemoryRecord = {
      id: 'q-1',
      type: 'question',
      sessionId: 'ses-1',
      episodeId: null,
      significance: 'technical',
      createdAt: '2026-06-12T09:00:00Z',
      source: decision.source,
      question: 'Do we need a dead letter queue?',
      answer: null,
      status: 'open',
      actor: { type: 'human', id: 'human:local' },
    };

    expect(renderRecord(question)).toContain('left unresolved');
  });

  it('reports a missing record for an unknown id', () => {
    expect(memoryGet({ db }, 'nope')).toContain('No record with id');
  });

  it('reports nothing found rather than an empty answer', () => {
    expect(memoryContext({ db }, 'graphql')).toContain('Nothing recorded about');
  });
});
