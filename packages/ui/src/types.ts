export type RecordType = 'question' | 'discovery' | 'decision' | 'action' | 'outcome';

export type Significance = 'business' | 'technical' | 'direction' | 'working';

export const KIND_LABEL: Record<Significance, string> = {
  business: 'product',
  technical: 'technical',
  direction: 'your call',
  working: 'working',
};

/** What each kind means, shown where a reader might not know. */
export const KIND_BLURB: Record<Significance, string> = {
  business: 'What the product should do, and why',
  technical: 'An engineering choice you made or approved',
  direction: 'Something you told the agent to do',
  working: "The agent's own detail while building",
};

export interface ActorRef {
  type: 'human' | 'agent';
  id: string;
}

export interface Alternative {
  choice: string;
  status: 'rejected' | 'considered';
  reason: string;
  condition: string | null;
}

interface BaseRecord {
  id: string;
  sessionId: string;
  episodeId: string | null;
  createdAt: string;
  significance: Significance;
}

export interface QuestionRecord extends BaseRecord {
  type: 'question';
  question: string;
  answer: string | null;
  status: 'open' | 'resolved';
  actor: ActorRef;
}

export interface DiscoveryRecord extends BaseRecord {
  type: 'discovery';
  text: string;
}

export interface DecisionRecord extends BaseRecord {
  type: 'decision';
  question: string;
  choice: string;
  reason: string;
  alternatives: Alternative[];
  attribution: { proposedBy: ActorRef; acceptedBy: ActorRef | 'implicit' };
  status: 'accepted' | 'superseded';
  supersededBy: string | null;
}

export interface ActionRecord extends BaseRecord {
  type: 'action';
  description: string;
  status: 'completed' | 'partial' | 'failed';
  files: string[];
}

export interface OutcomeRecord extends BaseRecord {
  type: 'outcome';
  text: string;
  result: 'passed' | 'failed' | 'unresolved';
}

export type MemoryRecord =
  | QuestionRecord
  | DiscoveryRecord
  | DecisionRecord
  | ActionRecord
  | OutcomeRecord;

export interface SessionSummary {
  sessionId: string;
  adapter: string;
  recordCount: number;
  firstAt: string;
  lastAt: string;
}

export interface Episode {
  id: string;
  title: string;
  count: number;
  foreground: number;
  firstAt: string;
}

export interface Overview {
  sessions: SessionSummary[];
  episodes: Episode[];
  counts: {
    sessions: number;
    records: number;
    decisions: number;
    rejected: number;
    foreground: number;
  };
  byKind: Record<Significance, number>;
}

/** The title a record shows in a list. */
export function titleOf(record: MemoryRecord): string {
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

/**
 * The kind a record counts as, after its recorded attribution is applied.
 *
 * Mirrors the same rule the server uses. The classifier is generous with
 * `technical`, and attribution is the recorded answer to the question it is
 * guessing at: a person's involvement is what makes an engineering choice part
 * of the project's story rather than the agent's working notes.
 */
export function kindOf(record: MemoryRecord): Significance {
  if (record.type === 'decision') {
    const { proposedBy, acceptedBy } = record.attribution;
    if (proposedBy.type === 'human') return 'direction';
    if (acceptedBy === 'implicit') {
      return record.significance === 'business' ? 'business' : 'working';
    }
    return record.significance === 'working' ? 'technical' : record.significance;
  }

  if (record.type === 'question') {
    return record.actor.type === 'human' ? 'direction' : record.significance;
  }

  if (record.type === 'discovery') return record.significance;

  return record.significance === 'business' ? 'business' : 'working';
}

export function isForeground(record: MemoryRecord): boolean {
  return kindOf(record) !== 'working';
}

/**
 * Who decided, in words.
 *
 * The four states the product promises to keep apart are spelled out rather
 * than collapsed into one label, because the difference between "you approved
 * this" and "the agent proceeded" is the whole point of recording attribution.
 */
export function attributionOf(record: MemoryRecord): string | null {
  if (record.type === 'decision') {
    const { proposedBy, acceptedBy } = record.attribution;
    if (acceptedBy === 'implicit') return 'agent decided, no approval';
    if (proposedBy.type === 'agent' && acceptedBy.type === 'human') return 'agent proposed, you accepted';
    if (proposedBy.type === 'human' && acceptedBy.type === 'human') return 'you decided';
    return `${proposedBy.type} to ${acceptedBy.type}`;
  }

  if (record.type === 'question') return record.actor.type === 'human' ? 'you asked' : 'agent asked';
  return null;
}
