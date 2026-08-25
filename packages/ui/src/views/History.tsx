import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { Overview } from '../types.js';

/** Where the developer orients: how much is recorded, and across which sessions. */
export function History({ onOpen }: { onOpen: (sessionId: string) => void }): JSX.Element {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.overview().then(setOverview).catch((cause: unknown) => setError(String(cause)));
  }, []);

  if (error) return <p className="empty">{error}</p>;
  if (!overview) return <p className="empty">Loading…</p>;
  if (overview.counts.records === 0) {
    return <p className="empty">Nothing recorded yet. Run backstory sync.</p>;
  }

  return (
    <>
      <div className="stats">
        <Stat n={overview.counts.records} label="records" />
        <Stat n={overview.counts.decisions} label="decisions" />
        <Stat n={overview.counts.rejected} label="options not taken" />
        <Stat n={overview.counts.sessions} label="sessions" />
      </div>

      {overview.sessions.map((session) => (
        <div className="card" key={session.sessionId} onClick={() => onOpen(session.sessionId)}>
          <div className="title">{session.sessionId.slice(0, 20)}</div>
          <div className="muted">
            {session.lastAt.slice(0, 10)} · {session.recordCount} records · {session.adapter}
          </div>
        </div>
      ))}
    </>
  );
}

function Stat({ n, label }: { n: number; label: string }): JSX.Element {
  return (
    <div className="stat">
      <div className="n">{n}</div>
      <div className="l">{label}</div>
    </div>
  );
}
