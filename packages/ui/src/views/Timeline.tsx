import { useMemo, useState, type ReactElement } from 'react';
import { Caret } from '../icons.js';
import { RecordRow } from '../RecordRow.js';
import type { Episode, MemoryRecord } from '../types.js';

interface Props {
  /** Everything in this session, for the counts the stream reports. */
  records: MemoryRecord[];
  /** What the rail's current filters leave. */
  visible: MemoryRecord[];
  episodes: Episode[];
  topicId: string | null;
  onClearFilters: () => void;
}

/**
 * What happened on this project, in the order it happened.
 *
 * The view holds no filter state of its own. Everything that decides what
 * appears here lives in the rail, so the controls and their result are never
 * out of step.
 */
export function Timeline({
  records,
  visible,
  episodes,
  topicId,
  onClearFilters,
}: Props): ReactElement {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const grouped = useMemo(() => groupByEpisode(visible, episodes), [visible, episodes]);

  if (records.length === 0) return <FirstRun />;

  if (visible.length === 0) {
    return (
      <div className="empty">
        <h3>Nothing matches these filters</h3>
        <p>
          {topicId === null
            ? 'Tick another kind on the left to bring records back.'
            : 'Nothing in this topic matches the kinds you ticked.'}{' '}
          <button type="button" className="linkish" onClick={onClearFilters}>
            Reset the filters
          </button>
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="count">
        Showing {visible.length} of {records.length} records
      </p>

      {grouped.map((group) => {
        const open = !collapsed.has(group.id);

        return (
          <section className="episode" key={group.id} id={`ep-${group.id}`}>
            <button
              type="button"
              className="episode-head"
              aria-expanded={open}
              onClick={() => setCollapsed(toggle(collapsed, group.id))}
            >
              <Caret className="caret" />
              <h2>{group.title}</h2>
              <span className="meta">
                {group.records.length} · {group.records[0]?.createdAt.slice(0, 10) ?? ''}
              </span>
            </button>

            {open ? group.records.map((record) => <RecordRow key={record.id} record={record} />) : null}
          </section>
        );
      })}
    </>
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
    .map(([id, list]) => ({ id, title: titles.get(id) ?? 'Everything else', records: list }))
    .sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * Before anything has been recorded. Shared, because two views reaching the
 * same state should not describe it in two different ways.
 */
export function FirstRun(): ReactElement {
  return (
    <div className="empty">
      <h3>Nothing recorded yet</h3>
      <p>
        Trackway reads a session once it goes quiet. Run <code>trackway sync</code> to turn the
        sessions already on disk into records.
      </p>
    </div>
  );
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
      <h3>Could not reach the local server</h3>
      <p>
        The explorer reads from a server on this machine. If it has stopped, run{' '}
        <code>trackway graph</code> again.
      </p>
      <p className="detail">{detail}</p>
    </div>
  );
}
