import { useEffect, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { Loading, Problem, plural } from './Timeline.js';
import {
  KIND_LABEL,
  attributionOf,
  isForeground,
  kindOf,
  type DecisionRecord,
  type MemoryRecord,
} from '../types.js';

interface Props {
  focusId: string | null;
  onFocus: (id: string) => void;
}

/**
 * One fork at a time.
 *
 * The first version drew every decision and every branch on one canvas, which
 * was accurate and unreadable: a wall of small boxes with no entry point and no
 * way to tell which mattered. A decision map is for understanding one choice,
 * so the list picks and the stage shows.
 */
export function DecisionMap({ focusId, onFocus }: Props): ReactElement {
  const [decisions, setDecisions] = useState<DecisionRecord[] | null>(null);
  const [showWorking, setShowWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .decisions()
      .then((data) => setDecisions(data.records.filter(isDecision)))
      .catch((cause: unknown) => setError(String(cause)));
  }, []);

  if (error) return <Problem detail={error} />;
  if (decisions === null) return <Loading />;

  // Ordered by how much each fork records, so the list agrees with the stage
  // and the first thing a reader sees is a real choice with its alternatives.
  const shown = decisions
    .filter((decision) => showWorking || isForeground(decision))
    .sort((a, b) => b.alternatives.length - a.alternatives.length);
  const workingCount = decisions.length - decisions.filter(isForeground).length;
  // Landing on a decision with no alternatives shows an empty stage and teaches
  // the reader nothing, so the list is ordered richest first and the stage
  // follows it.
  const focused = shown.find((d) => d.id === focusId) ?? shown[0] ?? null;

  if (decisions.length === 0) {
    return (
      <div className="empty">
        <h3>No decisions recorded yet</h3>
        <p>Decisions appear here once a session has been distilled.</p>
      </div>
    );
  }

  return (
    <div className="map">
      <aside className="map-list">
        <div className="rail-label">
          {shown.length} {plural(shown.length, 'decision')}
        </div>

        {shown.map((decision) => (
          <button
            key={decision.id}
            className="map-item"
            aria-current={focused?.id === decision.id}
            onClick={() => onFocus(decision.id)}
          >
            <span className="t">{decision.choice}</span>
            <span className="s">
              {decision.alternatives.length > 0
                ? `${decision.alternatives.length} not taken`
                : 'no alternatives recorded'}
              {' · '}
              {KIND_LABEL[kindOf(decision)]}
            </span>
          </button>
        ))}

        {workingCount > 0 ? (
          <button className="linkish" onClick={() => setShowWorking(!showWorking)}>
            {showWorking ? 'Hide' : 'Show'} {workingCount} working
          </button>
        ) : null}
      </aside>

      <div className="map-stage">
        {focused ? <Fork decision={focused} /> : <p className="empty">Pick a decision.</p>}
      </div>
    </div>
  );
}

function Fork({ decision }: { decision: DecisionRecord }): ReactElement {
  return (
    <div className="map-stage-inner">
      <p className="fork-question">{decision.question}</p>
      <h1 className="fork-title">{decision.choice}</h1>

      <div className="record-head" style={{ marginBottom: 18 }}>
        <span className="tag" data-kind={kindOf(decision)}>
          {KIND_LABEL[kindOf(decision)]}
        </span>
        <span className="who">{attributionOf(decision)}</span>
        <span className="time">{decision.createdAt.slice(0, 10)}</span>
      </div>

      <div className="branch taken">
        <span className="mark">✓</span>
        <div>
          <div className="label">Taken</div>
          <div className="detail">{decision.reason}</div>
        </div>
      </div>

      {decision.alternatives.map((alternative) => (
        <div className="branch dropped" key={alternative.choice}>
          <span className="mark">✗</span>
          <div>
            <div className="label">{alternative.choice}</div>
            <div className="detail">{alternative.reason}</div>
            {alternative.condition ? (
              <span className="cond">
                True at the time: {alternative.condition}. If that has changed, this is worth
                revisiting.
              </span>
            ) : null}
          </div>
        </div>
      ))}

      {decision.alternatives.length === 0 ? (
        <p className="who" style={{ marginTop: 10 }}>
          No alternatives were recorded for this one.
        </p>
      ) : null}

      {decision.status === 'superseded' && decision.supersededBy ? (
        <p className="who" style={{ marginTop: 16 }}>
          Later superseded by {decision.supersededBy}.
        </p>
      ) : null}
    </div>
  );
}

function isDecision(record: MemoryRecord): record is DecisionRecord {
  return record.type === 'decision';
}
