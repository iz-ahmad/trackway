import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { Caret } from '../icons.js';
import { RecordRow } from '../RecordRow.js';
import {
  KIND_BLURB,
  KIND_LABEL,
  isForeground,
  kindOf,
  type Episode,
  type MemoryRecord,
  type SessionSummary,
  type Significance,
} from '../types.js';

const KINDS: Significance[] = ['business', 'technical', 'direction'];

interface Props {
  sessionId: string | null;
}

/**
 * The default view: what happened on this project, in the order it happened.
 *
 * Working detail is present but folded away. A session produces roughly three
 * times as much execution detail as project history, and showing both at once
 * is what made the first version unreadable: the decision a person came for sat
 * between two notes about parsing strategy.
 */
export function Timeline({ sessionId }: Props): ReactElement {
  const [records, setRecords] = useState<MemoryRecord[] | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [active, setActive] = useState<Set<Significance>>(new Set(KINDS));
  const [showWorking, setShowWorking] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRecords(null);
    Promise.all([api.records(sessionId), api.overview()])
      .then(([r, o]) => {
        setRecords(r.records);
        setEpisodes(o.episodes);
        setSessions(o.sessions);
      })
      .catch((cause: unknown) => setError(String(cause)));
  }, [sessionId]);

  const counts = useMemo(() => {
    const tally: Record<string, number> = { business: 0, technical: 0, direction: 0, working: 0 };
    for (const record of records ?? []) tally[kindOf(record)] = (tally[kindOf(record)] ?? 0) + 1;
    return tally;
  }, [records]);

  const visible = useMemo(() => {
    return (records ?? []).filter((record) => {
      const kind = kindOf(record);
      return kind === 'working' ? showWorking : active.has(kind);
    });
  }, [records, active, showWorking]);

  const grouped = useMemo(() => groupByEpisode(visible, episodes), [visible, episodes]);

  if (error) return <Problem detail={error} />;
  if (records === null) return <Loading />;

  if (records.length === 0) {
    return (
      <div className="empty">
        <h3>Nothing recorded yet</h3>
        <p>
          Backstory reads sessions once they go quiet. Run <code>backstory sync</code> to distil
          what is waiting.
        </p>
      </div>
    );
  }

  const hiddenWorking = counts['working'] ?? 0;

  const outline = grouped.filter((group) => group.records.length > 0);

  return (
    <div className="with-outline">
      <div className="stream">
      <div className="filters">
        {KINDS.map((kind) => (
          <button
            key={kind}
            className="chip"
            aria-pressed={active.has(kind)}
            title={KIND_BLURB[kind]}
            style={{ color: active.has(kind) ? undefined : `var(--${kind})` }}
            onClick={() => setActive(toggle(active, kind))}
          >
            <span className="dot" style={{ background: `var(--${kind})` }} />
            {KIND_LABEL[kind]}
            <span className="n">{counts[kind] ?? 0}</span>
          </button>
        ))}

        <span className="filter-gap" />

        {sessions.length > 1 ? (
          <span className="who">
            {sessions.length} sessions
          </span>
        ) : null}

        <button className="linkish" onClick={() => setShowWorking(!showWorking)}>
          {showWorking ? 'Hide' : 'Show'} {hiddenWorking} working {plural(hiddenWorking, 'note')}
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="empty">
          <h3>Nothing matches those filters</h3>
          <p>Turn a filter back on, or reveal the working notes.</p>
        </div>
      ) : null}

      {grouped.map((group) => {
        const open = !collapsed.has(group.id);

        return (
          <section className="episode" key={group.id} id={`ep-${group.id}`}>
            <div
              className="episode-head"
              role="button"
              tabIndex={0}
              aria-expanded={open}
              onClick={() => setCollapsed(toggle(collapsed, group.id))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setCollapsed(toggle(collapsed, group.id));
                }
              }}
            >
              <Caret className="caret" />
              <h2>{group.title}</h2>
              <span className="meta">
                {group.records.length} · {group.records[0]?.createdAt.slice(0, 10) ?? ''}
              </span>
            </div>

            {open
              ? group.records.map((record) => (
                  <RecordRow key={record.id} record={record} />
                ))
              : null}
          </section>
        );
      })}
      </div>

      {outline.length > 1 ? (
        <nav className="outline" aria-label="Topics">
          <div className="rail-label">Topics</div>
          {outline.map((group) => (
            <a key={group.id} href={`#ep-${group.id}`}>
              <span>{group.title}</span>
              <span className="n">{group.records.length}</span>
            </a>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

interface Group {
  id: string;
  title: string;
  records: MemoryRecord[];
}

/**
 * Episode order comes from the episode list, not from record timestamps, so
 * topics stay in the order the work happened even when one topic was revisited.
 */
function groupByEpisode(records: readonly MemoryRecord[], episodes: readonly Episode[]): Group[] {
  const titles = new Map(episodes.map((episode) => [episode.id, episode.title]));
  const order = new Map(episodes.map((episode, index) => [episode.id, index]));
  const buckets = new Map<string, MemoryRecord[]>();

  for (const record of records) {
    const key = record.episodeId ?? '__ungrouped';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(record);
    else buckets.set(key, [record]);
  }

  return [...buckets.entries()]
    .map(([id, list]) => ({
      id,
      title: titles.get(id) ?? 'Everything else',
      records: list,
    }))
    .sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

export function Loading(): ReactElement {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {[62, 90, 74, 46, 84, 58].map((width, index) => (
        <i key={index} style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

export function Problem({ detail }: { detail: string }): ReactElement {
  return (
    <div className="empty">
      <h3>Could not load</h3>
      <p>{detail}</p>
    </div>
  );
}
