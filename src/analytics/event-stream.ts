/**
 * Real-time event stream for Neural Viz.
 * Emits structured events for every pipeline operation so the 3D graph
 * can show pings in sync with actual system activity.
 */

import { logger } from "../utils/logger.js";

export interface PipelineEvent {
  ts: number;
  type:
    | "query.start"
    | "query.embed"
    | "query.vector_search"
    | "query.bm25"
    | "query.rerank"
    | "query.expansion"
    | "query.pack"
    | "query.done"
    | "ingest.start"
    | "ingest.embed"
    | "ingest.chunk"
    | "ingest.store"
    | "ingest.done"
    | "ingest.parse"
    | "graph.extract"
    | "graph.store"
    | "health.check";
  detail: Record<string, unknown>;
}

type Listener = (event: PipelineEvent) => void;

/** Maximum number of listeners to prevent memory leaks */
const MAX_LISTENERS = 100;

const listeners = new Set<Listener>();

/** Subscribe to pipeline events. Returns unsubscribe function. */
export function onPipelineEvent(fn: Listener): () => void {
  if (listeners.size >= MAX_LISTENERS) {
    logger.warn({ count: listeners.size }, "Pipeline event listener limit reached, rejecting new listener");
    return () => {}; // no-op unsubscribe
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Emit a pipeline event to all listeners. */
export function emitPipelineEvent(
  type: PipelineEvent["type"],
  detail: Record<string, unknown> = {}
): void {
  const event: PipelineEvent = { ts: Date.now(), type, detail };
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      logger.debug({ error: String(err), type }, "Pipeline event listener threw");
    }
  }
}

/** Number of active SSE listeners. */
export function listenerCount(): number {
  return listeners.size;
}

/** Remove all listeners. Call during shutdown for cleanup. */
export function removeAllListeners(): void {
  listeners.clear();
}
