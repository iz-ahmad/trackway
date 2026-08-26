import type { CSSProperties, ReactElement } from 'react';
import { Check, Cross } from './icons.js';
import {
  KIND_LABEL,
  attributionOf,
  kindOf,
  titleOf,
  type MemoryRecord,
} from './types.js';

interface Props {
  record: MemoryRecord;
  /** A record outside the visible bands stays on the page and loses its colour. */
  muted?: boolean;
}

/** The band colour this record's fringe is drawn in. */
export function tone(kind: string): CSSProperties {
  return { '--tone': `var(--band-${kind})` } as CSSProperties;
}

/**
 * One record.
 *
 * Attribution and time live in the left margin so nothing stands between the
 * reader and the question. A decision shows its rejected options inline,
 * because that is the thing the product exists to preserve and hiding it behind
 * a click would bury the point.
 */
export function RecordRow({ record, muted = false }: Props): ReactElement {
  const kind = kindOf(record);
  const who = attributionOf(record);
  // A decision that was later replaced keeps its place and loses its colour,
  // the way a fringe disperses once the droplets stop matching.
  const dispersed = record.type === 'decision' && record.status === 'superseded';

  return (
    <article
      className={`record${muted ? ' muted' : ''}${dispersed ? ' dispersed' : ''}`}
      style={tone(dispersed ? 'working' : kind)}
      data-type={record.type}
    >
      <div className="record-margin">
        <span className="kind">
          {record.type === 'decision' ? KIND_LABEL[kind] : record.type}
        </span>
        {who ? <span>{who}</span> : null}
        {/*
          Date only, never a clock. Records distilled from one chunk all carry
          that chunk's end timestamp, so a time on each implies a precision the
          data does not have.
        */}
        <span className="when">{record.createdAt.slice(0, 10)}</span>
      </div>

      <div className="record-text">
        {record.type === 'decision' ? (
          <>
            <h3>{record.question}</h3>

            <div className="opts">
              <div className="opt taken">
                <span className="mark">
                  <Check />
                </span>
                <div>
                  <div className="label">{record.choice}</div>
                  <div className="reason">{record.reason}</div>
                </div>
              </div>

              {record.alternatives.length > 0 ? (
                <div className="dropped-head">Not taken</div>
              ) : null}

              {record.alternatives.map((alternative) => (
                <div className="opt" key={alternative.choice}>
                  <span className="mark">
                    <Cross />
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

        {/* The record id it was replaced by is not readable and does not link
            anywhere, and the sentence explaining why the tool keeps it belonged
            in the documentation, not in the middle of a record. */}
        {dispersed ? <p className="note">Replaced by a later decision.</p> : null}

        {record.type === 'question' && record.status === 'open' ? (
          <p className="note">Never answered during the session.</p>
        ) : null}

        {record.type === 'action' && record.files.length > 0 ? (
          <div className="files">{record.files.join('  ')}</div>
        ) : null}
      </div>
    </article>
  );
}
