import { useState } from 'react';
import { DecisionMap } from './views/DecisionMap.js';
import { History } from './views/History.js';
import { Search } from './views/Search.js';
import { Timeline } from './views/Timeline.js';

type View = 'timeline' | 'map' | 'history' | 'search';

export function App(): JSX.Element {
  // Timeline is the default. The spec calls it the view that must be easy to
  // scan, and the map is the secondary lens rather than the entry point.
  const [view, setView] = useState<View>('timeline');

  return (
    <>
      <header>
        <div className="brand">
          Backstory<span>the history behind your code</span>
        </div>
        <nav>
          {(['timeline', 'map', 'history', 'search'] as const).map((name) => (
            <button key={name} aria-current={view === name} onClick={() => setView(name)}>
              {name === 'map' ? 'decision map' : name}
            </button>
          ))}
        </nav>
      </header>

      <main className={view === 'map' ? 'wide' : undefined}>
        {view === 'timeline' ? <Timeline /> : null}
        {view === 'map' ? <DecisionMap /> : null}
        {view === 'history' ? <History onOpen={() => setView('timeline')} /> : null}
        {view === 'search' ? <Search /> : null}
      </main>
    </>
  );
}
