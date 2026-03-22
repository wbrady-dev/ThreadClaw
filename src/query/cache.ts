/**
 * LRU query cache — avoids redundant searches within a session.
 * Same query + collection = instant return, zero embedding/reranking cost.
 *
 * 50 entries max, 5 minute TTL. No persistence — memory only.
 */

const MAX_ENTRIES = 50;
const TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  result: unknown;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Generate a cache key from query parameters.
 */
export function cacheKey(query: string, collection: string, options: Record<string, unknown> = {}): string {
  const sorted = Object.keys(options).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = options[k]; return acc; }, {});
  return `${query}\x00${collection}\x00${JSON.stringify(sorted)}`;
}

/**
 * Get a cached result. Returns null if not found or expired.
 */
export function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;

  // Check TTL
  if (Date.now() - entry.timestamp > TTL_MS) {
    cache.delete(key);
    return null;
  }

  // Move to end (LRU)
  cache.delete(key);
  cache.set(key, entry);

  return structuredClone(entry.result) as T;
}

/**
 * Store a result in the cache.
 */
export function setCached(key: string, result: unknown): void {
  // Evict oldest if at capacity
  if (cache.size >= MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }

  cache.set(key, { result, timestamp: Date.now() });
}

/**
 * Clear all cached results.
 */
export function clearCache(): void {
  cache.clear();
}

/**
 * Invalidate cache entries for a specific collection.
 * Call when a collection is deleted or modified.
 */
export function invalidateCollection(collectionName: string): void {
  const toDelete = [...cache.keys()].filter(
    (key) => key.includes(`\x00${collectionName}\x00`) || key.includes(`\x00all\x00`),
  );
  for (const key of toDelete) {
    cache.delete(key);
  }
}

/**
 * Get cache stats for diagnostics.
 */
export function cacheStats(): { size: number; maxSize: number; ttlMs: number } {
  return { size: cache.size, maxSize: MAX_ENTRIES, ttlMs: TTL_MS };
}
