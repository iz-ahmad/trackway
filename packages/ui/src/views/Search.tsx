import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { attributionOf, titleOf, type MemoryRecord } from '../types.js';

export function Search(): JSX.Element {
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState<MemoryRecord[]>([]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setRecords([]);
      return;
    }

    // Debounced so typing does not fire a query per keystroke.
    const timer = setTimeout(() => {
      api.search(query).then((data) => setRecords(data.records)).catch(() => setRecords([]));
    }, 200);

    return () => clearTimeout(timer);
  }, [query]);

  return (
    <>
      <input
        type="search"
        value={query}
        placeholder="Search decisions, discoveries, questions…"
        onChange={(event) => setQuery(event.target.value)}
      />

      {query.trim().length >= 2 && records.length === 0 ? (
        <p className="empty">Nothing found.</p>
      ) : null}

      {records.map((record) => (
        <div className="card" key={record.id}>
          <div className="kind">
            {record.type}
            {attributionOf(record) ? <span className="badge">{attributionOf(record)}</span> : null}
          </div>
          <div className="title">{titleOf(record)}</div>
          {record.type === 'decision' ? <div className="muted">{record.reason}</div> : null}
        </div>
      ))}
    </>
  );
}
