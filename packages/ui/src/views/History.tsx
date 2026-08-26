import { useEffect, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { Loading, Problem, plural } from './Timeline.js';
import { KIND_BLURB, KIND_LABEL, type Overview, type Significance } from '../types.js';

const KINDS: Significance[] = ['business', 'technical', 'direction', 'working'];

/**
 * Where a reader orients: what this project's memory actually holds, and which
 * topics are worth opening.
 *
 * The first version showed four totals and a session id, which told a reader
 * nothing they could act on. Counts only earn their place next to the shape of
 * what is inside them.
 */
export function History({ onOpenEpisode }: { onOpenEpisode: () => void }): ReactElement {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.overview().then(setOverview).catch((cause: unknown) => setError(String(cause)));
  }, []);

  if (error) return <Problem detail={error} />;
  if (!overview) return <Loading />;

  if (overview.counts.records === 0) {
    return (
      <div className="empty">
        <h3>Nothing recorded yet</h3>
        <p>
          Run <code>backstory sync</code> and this fills with the decisions behind your work.
        </p>
      </div>
    );
  }

  const { counts, byKind, episodes } = overview;
  const biggest = Math.max(1, ...episodes.map((episode) => episode.count));

  return (
    <>
      <div className="figures">
        <Figure n={counts.foreground} label="worth reading" />
        <Figure n={counts.decisions} label={plural(counts.decisions, 'decision')} />
        <Figure n={counts.rejected} label="options not taken" />
        <Figure n={counts.records} label="records in total" />
      </div>

      <h2 className="section-title">What the records are</h2>
      <div style={{ marginBottom: 26 }}>
        {KINDS.map((kind) => (
          <div key={kind} className="topic-row" style={{ cursor: 'default' }}>
            <div>
              <div className="name" style={{ color: `var(--${kind})` }}>
                {KIND_LABEL[kind]}
              </div>
              <div className="sub">{KIND_BLURB[kind]}</div>
            </div>
            <div className="figures-inline">
              <b>{byKind[kind] ?? 0}</b> of {counts.records}
            </div>
            <div className="bar" title={`${byKind[kind] ?? 0} records`}>
              <i
                style={{
                  width: `${((byKind[kind] ?? 0) / Math.max(1, counts.records)) * 100}%`,
                  background: `var(--${kind})`,
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {episodes.length > 0 ? (
        <>
          <h2 className="section-title">Topics worked on</h2>
          {episodes.map((episode) => (
            <button className="topic-row" key={episode.id} onClick={onOpenEpisode}>
              <div>
                <div className="name">{episode.title}</div>
                <div className="sub">{episode.firstAt.slice(0, 10)}</div>
              </div>
              <div className="figures-inline">
                <b>{episode.foreground}</b> of {episode.count}
              </div>
              <div className="bar" title={`${episode.count} records`}>
                <i
                  style={{
                    width: `${(episode.foreground / Math.max(1, episode.count)) * 100}%`,
                    background: 'var(--accent)',
                  }}
                />
                <i
                  style={{
                    width: `${((episode.count - episode.foreground) / Math.max(1, episode.count)) * 100}%`,
                    background: 'var(--line-strong)',
                  }}
                />
              </div>
            </button>
          ))}
        </>
      ) : null}
    </>
  );
}

function Figure({ n, label }: { n: number; label: string }): ReactElement {
  return (
    <div className="figure">
      <div className="n">{n}</div>
      <div className="l">{label}</div>
    </div>
  );
}
