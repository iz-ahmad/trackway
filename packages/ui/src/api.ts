import type { MemoryRecord, Overview, SessionSummary } from './types.js';

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} responded ${response.status}`);
  return (await response.json()) as T;
}

export const api = {
  overview: () => get<Overview>('/api/overview'),
  sessions: () => get<{ sessions: SessionSummary[] }>('/api/sessions'),
  records: (sessionId: string | null) =>
    get<{ records: MemoryRecord[] }>(
      sessionId ? `/api/records?session=${encodeURIComponent(sessionId)}` : '/api/records',
    ),
  decisions: () => get<{ records: MemoryRecord[] }>('/api/decisions'),
  search: (query: string) =>
    get<{ records: MemoryRecord[] }>(`/api/search?q=${encodeURIComponent(query)}`),
};
