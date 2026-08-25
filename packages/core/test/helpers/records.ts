import { withDerivedId } from '../../src/ids/derive.js';
import type { DecisionRecord, DiscoveryRecord, MemoryRecord } from '../../src/models/record.js';

export function sourceFor(sessionId = 'ses-1', from = 0, to = 12) {
  return {
    adapter: 'claude-code',
    sessionId,
    sessionFile: `/tmp/${sessionId}.jsonl`,
    fromOffset: from,
    toOffset: to,
  };
}

export function makeDecision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return withDerivedId({
    type: 'decision',
    sessionId: 'ses-1',
    episodeId: null,
    createdAt: '2026-08-25T09:18:00Z',
    source: sourceFor(),
    question: 'Should cancellation be asynchronous?',
    choice: 'Asynchronous processing',
    reason: 'Provider callbacks can take several seconds.',
    alternatives: [
      {
        choice: 'Synchronous processing',
        status: 'rejected',
        reason: 'Would block the request for the callback duration.',
        condition: 'Provider callbacks take seconds',
      },
    ],
    attribution: {
      proposedBy: { type: 'agent', id: 'agent:claude-code' },
      acceptedBy: { type: 'human', id: 'human:7a91' },
    },
    status: 'accepted',
    supersededBy: null,
    relationships: [],
    ...overrides,
  } as Omit<DecisionRecord, 'id'>) as DecisionRecord;
}

export function makeDiscovery(overrides: Partial<DiscoveryRecord> = {}): DiscoveryRecord {
  return withDerivedId({
    type: 'discovery',
    sessionId: 'ses-1',
    episodeId: null,
    createdAt: '2026-08-25T09:16:00Z',
    source: sourceFor(),
    text: 'Webhooks may be delivered more than once.',
    ...overrides,
  } as Omit<DiscoveryRecord, 'id'>) as DiscoveryRecord;
}

export function allTypes(): MemoryRecord[] {
  return [makeDecision(), makeDiscovery()];
}
