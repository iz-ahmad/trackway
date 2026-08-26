import { useEffect, useState, type ReactElement } from 'react';
import { api } from './api.js';
import { Search as SearchIcon } from './icons.js';
import { DecisionMap } from './views/DecisionMap.js';
import { History } from './views/History.js';
import { Search } from './views/Search.js';
import { Timeline } from './views/Timeline.js';
import type { SessionSummary } from './types.js';

type View = 'story' | 'map' | 'overview';

export function App(): ReactElement {
  const [view, setView] = useState<View>('story');
  const [query, setQuery] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [focusDecision, setFocusDecision] = useState<string | null>(null);

  useEffect(() => {
    api.sessions().then((data) => setSessions(data.sessions)).catch(() => setSessions([]));
  }, []);

  // Typing in the search box is its own view. It replaces whatever is showing
  // and returns you where you were, so search never costs you your place.
  const searching = query.trim().length >= 2;

  const showRail = !searching && view === 'story' && sessions.length > 1;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wordmark">
          Backstory<span>the history behind your code</span>
        </div>

        <nav className="tabs">
          {(
            [
              ['story', 'Story'],
              ['map', 'Decisions'],
              ['overview', 'Overview'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              aria-current={!searching && view === id}
              onClick={() => {
                setQuery('');
                setView(id);
              }}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="omni">
          <SearchIcon />
          <input
            type="search"
            value={query}
            placeholder="Why did we…?"
            aria-label="Search the record"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('');
            }}
          />
        </div>
      </header>

      <div className={`body${showRail ? '' : ' solo'}`}>
        {showRail ? (
          <aside className="rail">
            <div className="rail-label">Sessions</div>
            <button aria-current={sessionId === null} onClick={() => setSessionId(null)}>
              All sessions
              <span className="count">{sessions.reduce((n, s) => n + s.recordCount, 0)}</span>
            </button>
            {sessions.map((session) => (
              <button
                key={session.sessionId}
                aria-current={sessionId === session.sessionId}
                onClick={() => setSessionId(session.sessionId)}
              >
                {session.lastAt.slice(0, 10)}
                <span className="count">{session.recordCount}</span>
              </button>
            ))}
          </aside>
        ) : null}

        {view === 'map' && !searching ? (
          <DecisionMap focusId={focusDecision} onFocus={setFocusDecision} />
        ) : (
          <main className="main">
            <div className="main-inner">
              {searching ? (
                <Search query={query} />
              ) : view === 'story' ? (
                <Timeline sessionId={sessionId} />
              ) : (
                <History onOpenEpisode={() => setView('story')} />
              )}
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
