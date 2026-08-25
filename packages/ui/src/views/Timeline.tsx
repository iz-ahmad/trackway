import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { attributionOf, titleOf, type MemoryRecord, type SessionSummary } from '../types.js';

interface Entry {
  record: MemoryRecord;
  time: string;
}

/**
 * The default view: one session read top to bottom.
 *
 * Scanning is the whole job, so a row is a time, a kind, and a line. Detail
 * appears only where it changes what the reader understands, which in practice
 * means the reasoning behind a decision and the options that were dropped.
 */
export function Timeline(): JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .sessions()
      .then((data) => {
        setSessions(data.sessions);
        setSelected((current) => current ?? data.sessions[0]?.sessionId ?? null);
      })
      .catch((cause: unknown) => setError(String(cause)));
  }, []);

  useEffect(() => {
    if (!selected) return;
    api
      .timeline(selected)
      .then((data) => setEntries(data.entries))
      .catch((cause: unknown) => setError(String(cause)));
  }, [selected]);

  if (error) return <p className="empty">{error}</p>;

  if (sessions.length === 0) {
    return <p className="empty">Nothing recorded yet. Run backstory sync.</p>;
  }

  return (
    <>
      <select
        value={selected ?? ''}
        onChange={(event) => setSelected(event.target.value)}
        style={{ marginBottom: 18 }}
      >
        {sessions.map((session) => (
          <option key={session.sessionId} value={session.sessionId}>
            {session.lastAt.slice(0, 10)} · {session.sessionId.slice(0, 12)} ({session.recordCount})
          </option>
        ))}
      </select>

      <div className="timeline">
        {entries.map((entry) => (
          <TimelineEntry key={entry.record.id} entry={entry} />
        ))}
      </div>
    </>
  );
}

function TimelineEntry({ entry }: { entry: Entry }): JSX.Element {
  const { record } = entry;
  const attribution = attributionOf(record);

  return (
    <div className="entry" data-type={record.type}>
      <span className="time">{entry.time}</span>
      <div className="kind">
        {record.type}
        {attribution ? <span className="badge">{attribution}</span> : null}
      </div>
      <div className="title">{titleOf(record)}</div>

      {record.type === 'decision' ? (
        <>
          <div className="muted">{record.reason}</div>
          {record.alternatives.map((alternative) => (
            <div className="alt" key={alternative.choice}>
              <span className="choice">{alternative.choice}</span>: {alternative.reason}
              {alternative.condition ? (
                <div className="cond">held because: {alternative.condition}</div>
              ) : null}
            </div>
          ))}
        </>
      ) : null}

      {record.type === 'question' && record.answer ? (
        <div className="muted">{record.answer}</div>
      ) : null}

      {record.type === 'action' && record.files.length > 0 ? (
        <div className="muted">{record.files.join(', ')}</div>
      ) : null}
    </div>
  );
}
