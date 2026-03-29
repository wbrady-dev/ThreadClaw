/**
 * Shared TUI store — observable cache for cross-screen state.
 *
 * Any screen can read or write. The benefit over module-level caches:
 * - Cross-mount persistence (no stale flash on screen transitions)
 * - Deduplication (if HomeScreen already fetched stats, status screen reads from store)
 * - Single subscription API for React hooks
 */

import { useState, useEffect } from "react";

export type StoreKey =
  | "serviceStatus"
  | "gpu"
  | "autoStart"
  | "stats"
  | "sources"
  | "modelHealth"
  | "envContent"
  | "parsedEnv"
  | "ocrInstalled"
  | "collections"
  | "graphStats"
  | "entities"
  | "terms";

const values = new Map<StoreKey, unknown>();
const listeners = new Map<StoreKey, Set<() => void>>();

export function get<T>(key: StoreKey): T | undefined {
  return values.get(key) as T | undefined;
}

export function set<T>(key: StoreKey, value: T): void {
  values.set(key, value);
  const subs = listeners.get(key);
  if (subs) {
    for (const fn of [...subs]) fn();
  }
}

export function subscribe(key: StoreKey, listener: () => void): () => void {
  let subs = listeners.get(key);
  if (!subs) {
    subs = new Set();
    listeners.set(key, subs);
  }
  subs.add(listener);
  return () => { subs!.delete(listener); };
}

/**
 * React hook — subscribes to a store key and re-renders on change.
 * Returns the current value (or `initial` if not yet set).
 */
export function useStoreValue<T>(key: StoreKey, initial?: T): T | undefined {
  const [value, setValue] = useState<T | undefined>(() => (get<T>(key) ?? initial));

  useEffect(() => {
    // Sync on mount in case value was set between render and effect
    const current = get<T>(key);
    if (current !== undefined) setValue(current);

    return subscribe(key, () => {
      setValue(get<T>(key));
    });
  }, [key]);

  return value;
}
