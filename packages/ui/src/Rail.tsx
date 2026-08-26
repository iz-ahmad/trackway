import { useMemo, useState, type ReactElement } from 'react';
import { Check } from './icons.js';
import { tone } from './RecordRow.js';
import {
  KIND_BLURB,
  KIND_LABEL,
  type Episode,
  type SessionSummary,
  type Significance,
} from './types.js';

const KINDS: Significance[] = ['business', 'technical', 'direction', 'working'];

/** Past this many topics the list stops being scannable and earns a filter. */
const FIND_THRESHOLD = 8;

interface Props {
  counts: Record<string, number>;
  /** Records per topic after the kind filters, before the topic filter. */
  topicCounts: Record<string, number>;
  /** How many records the ticked kinds leave, across every topic. */
  matching: number;
  shown: number;
  total: number;
  episodes: Episode[];
  topicId: string | null;
  sessions: SessionSummary[];
  sessionId: string | null;
  active: Set<Significance>;
  summary: string;
  onToggleKind: (kind: Significance) => void;
  onPickTopic: (id: string | null) => void;
  onPickSession: (id: string | null) => void;
}

/**
 * Every control the application has, in one place that never moves.
 *
 * The kinds are checkboxes rather than words with an underline. The first
 * version marked them with type weight and a pale rule and was not readable as
 * a control at all: people could not tell what was on.
 */
export function Rail({
  counts,
  topicCounts,
  matching,
  shown,
  total,
  episodes,
  topicId,
  sessions,
  sessionId,
  active,
  summary,
  onToggleKind,
  onPickTopic,
  onPickSession,
}: Props): ReactElement {
  const [find, setFind] = useState('');
  const [showEmpty, setShowEmpty] = useState(false);

  const needle = find.trim().toLowerCase();

  const { listed, emptyCount } = useMemo(() => {
    const matched = episodes.filter(
      (episode) => needle === '' || episode.title.toLowerCase().includes(needle),
    );
    const empty = matched.filter((episode) => (topicCounts[episode.id] ?? 0) === 0);
    // A topic holding nothing under the current filters is a place you cannot
    // go. It stays available behind one line rather than padding the list.
    const visible = showEmpty || needle !== '' ? matched : matched.filter((e) => !empty.includes(e));
    return { listed: visible, emptyCount: empty.length };
  }, [episodes, topicCounts, needle, showEmpty]);

  return (
    <aside className="side" aria-label="Filters and topics">
      <div className="grp">
        <h2 className="lbl">Show</h2>
        {KINDS.map((kind) => {
          const on = active.has(kind);
          return (
            <button
              key={kind}
              type="button"
              role="checkbox"
              aria-checked={on}
              className="ck"
              style={tone(kind)}
              title={KIND_BLURB[kind]}
              onClick={() => onToggleKind(kind)}
            >
              <span className="box" aria-hidden="true">
                {on ? <Check size={10} /> : null}
              </span>
              {KIND_LABEL[kind]}
              <span className="n">{counts[kind] ?? 0}</span>
            </button>
          );
        })}
      </div>

      {episodes.length > 0 ? (
        <div className="grp">
          <h2 className="lbl">
            Topics
            <span className="n" style={{ marginLeft: 'auto' }}>
              {episodes.length}
            </span>
          </h2>

          {episodes.length > FIND_THRESHOLD ? (
            <input
              type="search"
              className="tp-find"
              value={find}
              placeholder="Filter topics"
              aria-label="Filter topics by name"
              onChange={(event) => setFind(event.target.value)}
            />
          ) : null}

          {needle === '' ? (
            <button
              type="button"
              className="tp"
              aria-current={topicId === null}
              onClick={() => onPickTopic(null)}
            >
              <span>Everything</span>
              <span className="n">{matching}</span>
            </button>
          ) : null}

          {listed.map((episode) => {
            const n = topicCounts[episode.id] ?? 0;
            return (
              <button
                key={episode.id}
                type="button"
                className="tp"
                aria-current={topicId === episode.id}
                disabled={n === 0}
                onClick={() => onPickTopic(episode.id)}
              >
                <span>{episode.title}</span>
                <span className="n">{n}</span>
              </button>
            );
          })}

          {listed.length === 0 ? <p className="none">No topic matches “{find.trim()}”.</p> : null}

          {emptyCount > 0 && needle === '' ? (
            <button type="button" className="fold" onClick={() => setShowEmpty(!showEmpty)}>
              <span>
                {showEmpty ? 'Hide' : 'Show'} {emptyCount} with nothing to read
              </span>
            </button>
          ) : null}
        </div>
      ) : null}

      {sessions.length > 1 ? (
        <div className="grp">
          <h2 className="lbl">Sessions</h2>
          <button
            type="button"
            className="tp"
            aria-current={sessionId === null}
            onClick={() => onPickSession(null)}
          >
            <span>All sessions</span>
            <span className="n">{sessions.reduce((n, s) => n + s.recordCount, 0)}</span>
          </button>
          {sessions.map((session) => (
            <button
              key={session.sessionId}
              type="button"
              className="tp"
              aria-current={sessionId === session.sessionId}
              onClick={() => onPickSession(session.sessionId)}
            >
              <span>{session.lastAt.slice(0, 10)}</span>
              <span className="n">{session.recordCount}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="grp">
        <h2 className="lbl">This project</h2>
        <p className="blurb">{summary}</p>
      </div>

      <p className="sr" role="status">
        Showing {shown} of {total} records
      </p>
    </aside>
  );
}
