/**
 * Query analytics store — ring buffer for tracking search quality metrics.
 * Separated from API routes so the query pipeline doesn't depend on HTTP layer.
 * No persistence — resets on restart.
 */

export interface QueryRecord {
  timestamp: number;
  /** NOTE: Raw query text is stored in memory. This is acceptable for analytics
   * but be aware when exposing via API — consider redacting or truncating for
   * privacy-sensitive deployments. */
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

// Ring buffer implementation to avoid O(n) splice on large arrays
let ringBuffer: (QueryRecord | null)[] = new Array(MAX_RECORDS).fill(null);
let writeIndex = 0;
let totalWritten = 0;

/** Record a query for analytics. Called from the query pipeline. */
export function recordQuery(data: QueryRecord): void {
  ringBuffer[writeIndex] = data;
  writeIndex = (writeIndex + 1) % MAX_RECORDS;
  totalWritten++;
}

/** Get a shallow copy of the records array (oldest first). */
// NOTE: No aggregation stats are computed here. Enhancement: add
// getAggregateStats() for avg latency, hit rate, confidence distribution, etc.
export function getRecords(): QueryRecord[] {
  const count = Math.min(totalWritten, MAX_RECORDS);
  const result: QueryRecord[] = [];

  // Read from oldest to newest
  const startIdx = totalWritten > MAX_RECORDS ? writeIndex : 0;
  for (let i = 0; i < count; i++) {
    const idx = (startIdx + i) % MAX_RECORDS;
    const record = ringBuffer[idx];
    if (record) result.push(record);
  }

  return result;
}

/** Clear all recorded queries. */
export function clearRecords(): void {
  ringBuffer = new Array(MAX_RECORDS).fill(null);
  writeIndex = 0;
  totalWritten = 0;
}
