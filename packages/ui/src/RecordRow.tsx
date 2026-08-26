import type { ReactElement } from 'react';
import { ArrowRight } from './icons.js';
import {
  KIND_LABEL,
  attributionOf,
  kindOf,
  titleOf,
  type MemoryRecord,
} from './types.js';

interface Props {
  record: MemoryRecord;
  onOpenDecision?: (id: string) => void;
}

/**
 * One record.
 *
 * A decision shows its rejected options inline, because that is the thing the
 * product exists to preserve and hiding it behind a click would bury the point.
 * Everything else stays to a line or two.
 */
export function RecordRow({ record, onOpenDecision }: Props): ReactElement {
  const kind = kindOf(record);
  const who = attributionOf(record);

  return (
    <article className="record" data-kind={kind}>
      <div className="record-head">
        <span className="tag" data-kind={kind}>
          {record.type === 'decision' ? 'decision' : record.type}
        </span>
        {kind !== 'working' ? (
          <span className="tag" data-kind={kind}>
            {KIND_LABEL[kind]}
          </span>
        ) : null}
        {who ? <span className="who">{who}</span> : null}
        <span className="time">{record.createdAt.slice(11, 16)}</span>
      </div>

      {record.type === 'decision' ? (
        <p className="question-line">{record.question}</p>
      ) : null}

      <h3>{titleOf(record)}</h3>

      {record.type === 'decision' ? <p className="why">{record.reason}</p> : null}
      {record.type === 'question' && record.answer ? (
        <p className="why">{record.answer}</p>
      ) : null}

      {record.type === 'decision' && record.alternatives.length > 0 ? (
        <div className="alts">
          {record.alternatives.map((alternative) => (
            <div className="alt" key={alternative.choice}>
              <span className="choice">{alternative.choice}</span>{' '}
              <span className="reason">{alternative.reason}</span>
              {alternative.condition ? (
                <span className="cond">Held because: {alternative.condition}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {record.type === 'action' && record.files.length > 0 ? (
        <div className="files">{record.files.join('  ')}</div>
      ) : null}

      {record.type === 'decision' && onOpenDecision ? (
        <button className="linkish" onClick={() => onOpenDecision(record.id)}>
          See the fork <ArrowRight />
        </button>
      ) : null}
    </article>
  );
}
