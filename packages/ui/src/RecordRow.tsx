import type { ReactElement } from 'react';
import {
  KIND_LABEL,
  attributionOf,
  kindOf,
  titleOf,
  type MemoryRecord,
} from './types.js';

interface Props {
  record: MemoryRecord;
}

/**
 * One record.
 *
 * A decision shows its rejected options inline, because that is the thing the
 * product exists to preserve and hiding it behind a click would bury the point.
 * Everything else stays to a line or two.
 */
export function RecordRow({ record }: Props): ReactElement {
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

      {/*
        A decision is a fork, so it is drawn as one: the question asked, then
        every option with the one taken marked. Rendered as stacked paragraphs
        it was impossible to tell what was asked from what was chosen.
      */}
      {record.type === 'decision' ? (
        <>
          <h3>{record.question}</h3>

          <div className="fork">
            <div className="opt taken">
              <span className="mark" aria-hidden="true">
                ✓
              </span>
              <div>
                <div className="label">{record.choice}</div>
                <div className="reason">{record.reason}</div>
              </div>
            </div>

            {record.alternatives.map((alternative) => (
              <div className="opt dropped" key={alternative.choice}>
                <span className="mark" aria-hidden="true">
                  ✗
                </span>
                <div>
                  <div className="label">{alternative.choice}</div>
                  <div className="reason">{alternative.reason}</div>
                  {alternative.condition ? (
                    <div className="cond">True then: {alternative.condition}</div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <h3>{titleOf(record)}</h3>
      )}

      {record.type === 'question' ? (
        <p className="why">Never resolved during the session.</p>
      ) : null}

      {record.type === 'action' && record.files.length > 0 ? (
        <div className="files">{record.files.join('  ')}</div>
      ) : null}

      {/*
        No "see the fork" link: the fork is right here now. It earned its place
        when the row was a summary, and became a link to what the reader was
        already looking at.
      */}
    </article>
  );
}
