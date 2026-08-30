import { useEffect, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { RecordRow } from '../RecordRow.js';
import { plural } from './Timeline.js';
import type { Forge, MemoryRecord } from '../types.js';

/**
 * Answering "why is this like this?" is the question the product exists for, so
 * search returns whole records rather than links to them.
 */
export function Search({ query, forge }: { query: string; forge?: Forge | undefined }): ReactElement {
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

  if (searched && records.length === 0) {
    return (
      <div className="empty">
        <h3>Nothing matches “{query}”</h3>
        <p>
          Trackway searches the records it wrote, not the raw session files behind them. Try a
          different word, or clear the search to browse by topic.
        </p>
        <p>
          Options you ruled out are searchable on their own, so an approach that was never built
          can still be found by name.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* The same count line every other view uses, and readable by a screen
          reader: it was hidden from one for no reason. */}
      <p className="count">
        {records.length} {plural(records.length, 'result')} for “{query}”
      </p>
      {records.map((record) => (
        <RecordRow key={record.id} record={record} forge={forge} />
      ))}
    </>
  );
}
