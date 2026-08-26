import { useEffect, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { RecordRow } from '../RecordRow.js';
import { plural } from './Timeline.js';
import type { MemoryRecord } from '../types.js';

/**
 * Answering "why is this like this?" is the question the product exists for, so
 * search returns whole records rather than links to them.
 */
export function Search({ query }: { query: string }): ReactElement {
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) {
      setRecords([]);
      setSearched(false);
      return;
    }

    // Debounced so typing does not fire a query per keystroke.
    const timer = setTimeout(() => {
      api
        .search(query)
        .then((data) => {
          setRecords(data.records);
          setSearched(true);
        })
        .catch(() => {
          setRecords([]);
          setSearched(true);
        });
    }, 180);

    return () => clearTimeout(timer);
  }, [query]);

  if (query.trim().length < 2) {
    return (
      <div className="empty">
        <h3>Search the record</h3>
        <p>
          Try a topic you half-remember deciding. Rejected options are searchable on their own, so
          an approach you ruled out will surface even though nothing was built from it.
        </p>
      </div>
    );
  }

  if (searched && records.length === 0) {
    return (
      <div className="empty">
        <h3>Nothing matches “{query}”</h3>
        <p>Only distilled records are searchable, not the raw sessions behind them.</p>
      </div>
    );
  }

  return (
    <>
      <div className="filters">
        <span className="who">
          {records.length} {plural(records.length, 'result')} for “{query}”
        </span>
      </div>
      {records.map((record) => (
        <RecordRow key={record.id} record={record} />
      ))}
    </>
  );
}
