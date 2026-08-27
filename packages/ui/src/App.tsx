import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { api } from './api.js';
import { Search as SearchIcon } from './icons.js';
import { Rail } from './Rail.js';
import { Decisions } from './views/Decisions.js';
import { History } from './views/History.js';
import { Search } from './views/Search.js';
import { Loading, Problem, Timeline, plural } from './views/Timeline.js';
import {
  kindOf,
  type Episode,
  type MemoryRecord,
  type SessionSummary,
  type Significance,
} from './types.js';

type View = 'story' | 'decisions' | 'overview';

const LIT: Significance[] = ['business', 'technical', 'direction'];

const TABS = [
  ['story', 'Story'],
  ['decisions', 'Decisions'],
  ['overview', 'Overview'],
] as const;

/**
 * One frame for every view.
 *
 * The rail and the reading column are the application's only structure, and
 * they do not change when the view does. Each view used to bring its own page
 * shape, so moving between them moved everything at once.
 */
export function App(): ReactElement {
  const [view, setView] = useState<View>('story');
  const [query, setQuery] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const [records, setRecords] = useState<MemoryRecord[] | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [active, setActive] = useState<Set<Significance>>(new Set(LIT));
  const [topicId, setTopicId] = useState<string | null>(null);

  useEffect(() => {
    api.sessions().then((data) => setSessions(data.sessions)).catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    setRecords(null);
    Promise.all([api.records(sessionId), api.overview()])
      .then(([r, o]) => {
        setRecords(r.records);
        setEpisodes(o.episodes);
      })
      .catch((cause: unknown) => setError(String(cause)));
  }, [sessionId]);

  const counts = useMemo(() => {
    const tally: Record<string, number> = { business: 0, technical: 0, direction: 0, working: 0 };
    for (const record of records ?? []) tally[kindOf(record)] = (tally[kindOf(record)] ?? 0) + 1;
    return tally;
  }, [records]);

  // Unticking a kind removes those records. The first version dimmed them in
  // place, which read as a rendering fault rather than a filter.
  const byKind = useMemo(
    () => (records ?? []).filter((record) => active.has(kindOf(record))),
    [records, active],
  );

  const visible = useMemo(
    () => byKind.filter((record) => topicId === null || record.episodeId === topicId),
    [byKind, topicId],
  );

  // Counted after the kind filters and before the topic filter, so each topic
  // reports what opening it would actually show.
  const topicCounts = useMemo(() => {
    const tally: Record<string, number> = {};
    for (const record of byKind) {
      const key = record.episodeId ?? '__ungrouped';
      tally[key] = (tally[key] ?? 0) + 1;
    }
    return tally;
  }, [byKind]);

  const summary = useMemo(() => describe(records ?? [], sessions.length), [records, sessions]);

  // Typing in the search box is its own view. It replaces whatever is showing
  // and returns you where you were, so search never costs you your place.
  const searching = query.trim().length >= 2;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wrap">
          <div className="bar">
            <div className="wordmark">
              <h1>Trackway</h1>
              <p>The history behind your code</p>
            </div>

            <div className="omni">
              <SearchIcon />
              <input
                type="search"
                value={query}
                placeholder="Search decisions and discoveries"
                aria-label="Search decisions and discoveries"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setQuery('');
                }}
              />
            </div>
          </div>

          <nav className="tabs" aria-label="Views">
            {TABS.map(([id, label]) => (
              <button
                key={id}
                type="button"
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
        </div>
      </header>

      <div className="wrap split">
        <Rail
          counts={counts}
          topicCounts={topicCounts}
          matching={byKind.length}
          shown={visible.length}
          total={records?.length ?? 0}
          episodes={episodes}
          topicId={topicId}
          sessions={sessions}
          sessionId={sessionId}
          active={active}
          summary={summary}
          onToggleKind={(kind) => setActive(toggle(active, kind))}
          onPickTopic={setTopicId}
          onPickSession={setSessionId}
        />

        <main className="content">
          {error ? (
            <Problem detail={error} />
          ) : records === null ? (
            <Loading />
          ) : searching ? (
            <Search query={query} />
          ) : view === 'decisions' ? (
            <Decisions records={visible} all={records} />
          ) : view === 'overview' ? (
            <History
              records={records}
              visible={visible}
              episodes={episodes}
              sessions={sessions.length}
              onOpenTopic={(id) => {
                setTopicId(id);
                setView('story');
              }}
            />
          ) : (
            <Timeline
              records={records}
              visible={visible}
              episodes={episodes}
              topicId={topicId}
              onClearFilters={() => {
                setActive(new Set(LIT));
                setTopicId(null);
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}

/** The project in one sentence, from the records themselves. */
function describe(records: readonly MemoryRecord[], sessionCount: number): string {
  if (records.length === 0) return 'Nothing recorded yet.';

  const decisions = records.filter((record) => record.type === 'decision');
  const kept = decisions.reduce(
    (n, record) => n + (record.type === 'decision' ? record.alternatives.length : 0),
    0,
  );
  const sessions = Math.max(1, sessionCount);

  return `${records.length} records from ${sessions} ${plural(sessions, 'session')}. ${
    decisions.length
  } ${plural(decisions.length, 'decision')}, holding ${kept} ${plural(
    kept,
    'option',
  )} that ${kept === 1 ? 'was' : 'were'} not taken.`;
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
