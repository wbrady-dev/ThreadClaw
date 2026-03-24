import { createHash } from "node:crypto";
import { config } from "../config.js";

/**
 * LRU query cache — avoids redundant searches within a session.
 * Same query + collection = instant return, zero embedding/reranking cost.
 *
 * Configurable entries max and TTL. No persistence — memory only.
 */

const MAX_ENTRIES = config.query.cacheMaxEntries;
const TTL_MS = config.query.cacheTtlMs;

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
  return createHash("sha256").update(`${query}|${collection}|${JSON.stringify(sorted)}`).digest("hex");
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

  cache.set(key, { result: structuredClone(result), timestamp: Date.now() });
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
  // With hashed keys, we cannot inspect individual entries.
  // Clear entire cache when any collection changes — safe since TTL is only 5 min.
  cache.clear();
}

