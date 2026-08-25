import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { attributionOf, type DecisionRecord, type MemoryRecord } from '../types.js';

/** Above this many decisions the map shows the spine only. */
const SPINE_THRESHOLD = 25;

const ROW_HEIGHT = 150;
const BRANCH_X = 320;

/**
 * One decision, its chosen path, and the options that were dropped.
 *
 * Layout is computed rather than simulated, so the same records always draw the
 * same shape. A force layout that rearranges itself between visits makes the
 * map impossible to recognise, which defeats the point of a map.
 */
export function DecisionMap(): JSX.Element {
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .decisions()
      .then((data) => setDecisions(data.records.filter(isDecision)))
      .catch((cause: unknown) => setError(String(cause)));
  }, []);

  const spineOnly = decisions.length > SPINE_THRESHOLD;
  const { nodes, edges } = useMemo(() => buildGraph(decisions, spineOnly), [decisions, spineOnly]);

  if (error) return <p className="empty">{error}</p>;
  if (decisions.length === 0) return <p className="empty">No decisions recorded yet.</p>;

  return (
    <>
      {spineOnly ? (
        <p className="muted" style={{ marginBottom: 12 }}>
          {decisions.length} decisions. Showing the spine only so the map stays readable; open a
          decision in the timeline to see its alternatives.
        </p>
      ) : null}

      <div className="graph">
        <ReactFlow nodes={nodes} edges={edges} fitView proOptions={{ hideAttribution: true }}>
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </>
  );
}

function isDecision(record: MemoryRecord): record is DecisionRecord {
  return record.type === 'decision';
}

export function buildGraph(
  decisions: readonly DecisionRecord[],
  spineOnly: boolean,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  decisions.forEach((decision, row) => {
    const y = row * ROW_HEIGHT;

    nodes.push({
      id: decision.id,
      position: { x: 0, y },
      data: {
        label: (
          <div className="node taken">
            <div className="muted" style={{ fontSize: 11 }}>
              {decision.question}
            </div>
            <div>
              <span className="mark">✓</span>
              {decision.choice}
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              {attributionOf(decision)}
            </div>
          </div>
        ),
      },
      type: 'default',
    });

    if (!spineOnly) {
      decision.alternatives.forEach((alternative, index) => {
        const id = `${decision.id}:alt${index}`;

        nodes.push({
          id,
          position: { x: BRANCH_X, y: y + index * 70 },
          data: {
            label: (
              <div className="node dropped">
                <div>
                  <span className="mark">✗</span>
                  {alternative.choice}
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {alternative.reason}
                </div>
                {alternative.condition ? (
                  <div className="muted" style={{ fontSize: 11 }}>
                    held because: {alternative.condition}
                  </div>
                ) : null}
              </div>
            ),
          },
          type: 'default',
        });

        edges.push({ id: `e-${id}`, source: decision.id, target: id, animated: false });
      });
    }

    if (decision.supersededBy) {
      edges.push({
        id: `e-sup-${decision.id}`,
        source: decision.id,
        target: decision.supersededBy,
        label: 'superseded by',
        style: { strokeDasharray: '4 4' },
      });
    }
  });

  // A supersession edge pointing at a decision outside the current set would
  // render as a dangling arrow, so those are dropped.
  const present = new Set(nodes.map((node) => node.id));
  return { nodes, edges: edges.filter((edge) => present.has(edge.target)) };
}
