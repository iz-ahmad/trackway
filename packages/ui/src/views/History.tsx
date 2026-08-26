import { useMemo, type ReactElement } from 'react';
import { tone } from '../RecordRow.js';
import { FirstRun, plural } from './Timeline.js';
import {
  KIND_BLURB,
  KIND_LABEL,
  kindOf,
  type Episode,
  type MemoryRecord,
  type Significance,
} from '../types.js';

const KINDS: Significance[] = ['business', 'technical', 'direction', 'working'];

interface Props {
  /** Everything in the session, for the totals each proportion is measured against. */
  records: MemoryRecord[];
  /** What the rail's filters leave, so the page answers to the same controls. */
  visible: MemoryRecord[];
  episodes: Episode[];
  sessions: number;
  onOpenTopic: (id: string) => void;
}

/**
 * What this project's memory holds, and which topics are worth opening.
 *
 * Everything here is derived from the records the rail already filtered, so
 * the numbers agree with the page beside them rather than reporting a global
 * total the reader cannot see.
 */
export function History({
  records,
  visible,
  episodes,
  sessions,
  onOpenTopic,
}: Props): ReactElement {
  const byKind = useMemo(() => {
    const tally: Record<string, number> = { business: 0, technical: 0, direction: 0, working: 0 };
    for (const record of records) tally[kindOf(record)] = (tally[kindOf(record)] ?? 0) + 1;
    return tally;
  }, [records]);

  const topics = useMemo(() => {
    const shown = new Map<string, number>();
    for (const record of visible) {
      const key = record.episodeId ?? '__ungrouped';
      shown.set(key, (shown.get(key) ?? 0) + 1);
    }
    return episodes.map((episode) => ({ ...episode, shown: shown.get(episode.id) ?? 0 }));
  }, [visible, episodes]);

  if (records.length === 0) return <FirstRun />;

  const decisions = records.filter((record) => record.type === 'decision');
  const kept = decisions.reduce(
    (n, record) => n + (record.type === 'decision' ? record.alternatives.length : 0),
    0,
  );
  const foreground = records.filter((record) => kindOf(record) !== 'working').length;

  return (
    <>
      <p className="lede">
        <b>{records.length}</b> records from <b>{sessions}</b> {plural(sessions, 'session')}.{' '}
        <b>{foreground}</b> of them carry this project's own history rather than the agent's working
        detail. Across all <b>{decisions.length}</b> {plural(decisions.length, 'decision')},{' '}
        <b>{kept}</b> {plural(kept, 'option')} {kept === 1 ? 'was' : 'were'} recorded and not taken.
      </p>

      <h2 className="section-title">What the records are</h2>
      <div className="rows">
        {KINDS.map((kind) => (
          <div className="row" key={kind} style={tone(kind)}>
            <div>
              <div className="name">{KIND_LABEL[kind]}</div>
              <div className="sub">{KIND_BLURB[kind]}</div>
            </div>
            <div className="amount">
              <b>{byKind[kind] ?? 0}</b> / {records.length}
            </div>
            <div className="spectrum">
              <i style={{ width: `${((byKind[kind] ?? 0) / records.length) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>

      {topics.length > 0 ? (
        <>
          <h2 className="section-title">Topics worked on</h2>
          <div className="rows">
            {topics.map((topic) => (
              <button
                className="row"
                key={topic.id}
                style={tone('direction')}
                disabled={topic.shown === 0}
                onClick={() => onOpenTopic(topic.id)}
              >
                <div>
                  <div className="name">{topic.title}</div>
                  <div className="sub">{topic.firstAt.slice(0, 10)}</div>
                </div>
                <div className="amount">
                  <b>{topic.shown}</b> / {topic.count}
                </div>
                <div className="spectrum">
                  <i style={{ width: `${(topic.shown / Math.max(1, topic.count)) * 100}%` }} />
                </div>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
