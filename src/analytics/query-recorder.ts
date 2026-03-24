/**
 * Query analytics store — ring buffer for tracking search quality metrics.
 * Separated from API routes so the query pipeline doesn't depend on HTTP layer.
 * No persistence — resets on restart.
 */

export interface QueryRecord {
  timestamp: number;
  query: string;
  collection: string;
  strategy: string;
  elapsedMs: number;
  candidates: number;
  chunksReturned: number;
  confidence: number;
  cached: boolean;
  vectorHits: number;
  bm25Hits: number;
  bestDistance: number;
  reranked: boolean;
}

const MAX_RECORDS = 500;
const records: QueryRecord[] = [];

/** Record a query for analytics. Called from the query pipeline. */
export function recordQuery(data: QueryRecord): void {
  records.push(data);
  if (records.length > MAX_RECORDS) {
    records.splice(0, records.length - MAX_RECORDS);
  }
}

/** Get a shallow copy of the records array. */
export function getRecords(): QueryRecord[] {
  return [...records];
}

/** Clear all recorded queries. */
export function clearRecords(): void {
  records.length = 0;
}
