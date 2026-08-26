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
    <article className="record" data-kind={kind} data-type={record.type}>
      <div className="record-head">
        {/*
          One badge. Two said the same thing twice: a decision marked
          "technical" is already visibly a decision, and the pair read as noise
          in every row.

          No per-record time either. Records distilled from one chunk all carry
          that chunk's end timestamp, so a clock on each implies a precision the
          data does not have. The date sits on the topic instead.
        */}
        <span className="tag" data-kind={kind}>
          {record.type === 'decision' ? KIND_LABEL[kind] : record.type}
        </span>
        {who ? <span className="who">{who}</span> : null}
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
