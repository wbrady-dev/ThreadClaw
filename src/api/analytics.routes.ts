import type { FastifyInstance } from "fastify";
import { logger } from "../utils/logger.js";

/**
 * Query analytics — tracks search quality metrics for diagnostics.
 * Ring buffer of recent queries with performance and quality data.
 * No persistence — resets on restart.
 */

interface QueryRecord {
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

/** Called from query pipeline to record analytics. */
export function recordQuery(data: QueryRecord): void {
  records.push(data);
  if (records.length > MAX_RECORDS) {
    records.splice(0, records.length - MAX_RECORDS);
  }
}

export function registerAnalyticsRoutes(server: FastifyInstance) {
  /**
   * GET /analytics — query performance summary.
   * Returns aggregate stats and recent low-confidence queries.
   */
  server.get("/analytics", async () => {
    if (records.length === 0) {
      return { message: "No queries recorded yet", total: 0 };
    }

    const total = records.length;
    const cached = records.filter((r) => r.cached).length;
    const avgElapsed = Math.round(records.reduce((s, r) => s + r.elapsedMs, 0) / total);
    const avgConfidence = Math.round(records.reduce((s, r) => s + r.confidence, 0) / total * 100) / 100;
    const avgCandidates = Math.round(records.reduce((s, r) => s + r.candidates, 0) / total);

    // Identify low-confidence queries (potential search quality issues)
    const lowConfidence = records
      .filter((r) => r.confidence < 0.3 && !r.cached && r.chunksReturned > 0)
      .slice(-10)
      .map((r) => ({
        query: r.query,
        confidence: r.confidence,
        collection: r.collection,
        strategy: r.strategy,
        bestDistance: r.bestDistance,
        elapsedMs: r.elapsedMs,
      }));

    // Zero-result queries
    const zeroResults = records
      .filter((r) => r.chunksReturned === 0 && !r.cached)
      .slice(-10)
      .map((r) => ({
        query: r.query,
        collection: r.collection,
        vectorHits: r.vectorHits,
        bm25Hits: r.bm25Hits,
      }));

    // Slow queries (>2s)
    const slow = records
      .filter((r) => r.elapsedMs > 2000 && !r.cached)
      .slice(-10)
      .map((r) => ({
        query: r.query,
        elapsedMs: r.elapsedMs,
        strategy: r.strategy,
        candidates: r.candidates,
      }));

    // Strategy distribution
    const strategies: Record<string, number> = {};
    for (const r of records) {
      strategies[r.strategy] = (strategies[r.strategy] ?? 0) + 1;
    }

    // Collection distribution
    const collections: Record<string, number> = {};
    for (const r of records) {
      collections[r.collection] = (collections[r.collection] ?? 0) + 1;
    }

    return {
      total,
      cached,
      cacheHitRate: Math.round(cached / total * 100),
      avgElapsedMs: avgElapsed,
      avgConfidence,
      avgCandidates,
      strategies,
      collections,
      lowConfidence,
      zeroResults,
      slow,
    };
  });

  /**
   * GET /analytics/recent — last N queries with full details.
   */
  server.get("/analytics/recent", async (req) => {
    const { limit } = req.query as { limit?: string };
    const n = Math.min(parseInt(limit ?? "20", 10), 100);
    return { queries: records.slice(-n).reverse() };
  });

  /**
   * DELETE /analytics — clear analytics data.
   */
  server.delete("/analytics", async () => {
    records.length = 0;
    return { cleared: true };
  });

  /**
   * GET /analytics/awareness — awareness layer stats.
   *
   * Awareness stats are tracked in the memory-engine process (OpenClaw plugin),
   * not in the ClawCore HTTP server. This endpoint returns stats if the awareness
   * module has been loaded into this process, or a fallback otherwise.
   *
   * For full awareness metrics, use the eval harness via the OpenClaw plugin API.
   */
  server.get("/analytics/awareness", async (req) => {
    // The awareness eval module may be loaded into this process if the
    // memory-engine plugin is colocated. Try to access it.
    if (awarenessStatsGetter) {
      const { window } = req.query as { window?: string };
      const windowMs = window ? parseInt(window, 10) * 1000 : 86_400_000;
      return awarenessStatsGetter(windowMs);
    }
    return {
      message: "Awareness stats are tracked in the OpenClaw agent process, not the ClawCore HTTP server.",
      totalTurns: 0,
      firedCount: 0,
      fireRate: 0,
      latencyP50: 0,
      latencyP95: 0,
      avgTokensWhenFired: 0,
      noteTypeBreakdown: {},
    };
  });
}

// Optional: allow the awareness eval module to register its stats getter
// when both run in the same process.
type AwarenessStatsGetter = (windowMs?: number) => {
  totalTurns: number;
  firedCount: number;
  fireRate: number;
  latencyP50: number;
  latencyP95: number;
  avgTokensWhenFired: number;
  noteTypeBreakdown: Record<string, number>;
};

let awarenessStatsGetter: AwarenessStatsGetter | null = null;

export function registerAwarenessStatsGetter(getter: AwarenessStatsGetter): void {
  awarenessStatsGetter = getter;
}

/**
 * GET /analytics/diagnostics — full CRAM health for external monitoring.
 * Returns evidence graph stats, awareness metrics, and config state.
 * Available to you (Wesley) via curl or browser.
 */
export function registerDiagnosticsRoute(server: FastifyInstance) {
  server.get("/analytics/diagnostics", async (req, reply) => {
    // Localhost-only — exposes internal paths and config
    const ip = req.ip ?? "";
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
      return reply.status(403).send({ error: "Forbidden" });
    }

    const { config } = await import("../config.js");
    const { existsSync, statSync } = await import("fs");
    const { resolve } = await import("path");
    const { homedir } = await import("os");

    const result: Record<string, unknown> = {};

    // Graph DB stats (use getGraphDb singleton — same driver as rest of ClawCore)
    const graphDbPath = config.relations.graphDbPath;
    if (existsSync(graphDbPath)) {
      try {
        const { getGraphDb } = await import("../storage/graph-sqlite.js");
        const db = getGraphDb(graphDbPath);
        const safe = (sql: string): number => {
          try { return (db.prepare(sql).get() as { cnt: number }).cnt; } catch { return -1; }
        };
        result.graphDb = {
          path: graphDbPath,
          sizeMb: +(statSync(graphDbPath).size / 1024 / 1024).toFixed(2),
          entities: safe("SELECT COUNT(*) as cnt FROM entities"),
          mentions: safe("SELECT COUNT(*) as cnt FROM entity_mentions"),
          claims: safe("SELECT COUNT(*) as cnt FROM claims WHERE status = 'active'"),
          decisions: safe("SELECT COUNT(*) as cnt FROM decisions WHERE status = 'active'"),
          loops: safe("SELECT COUNT(*) as cnt FROM open_loops WHERE status IN ('open','blocked')"),
          attempts: safe("SELECT COUNT(*) as cnt FROM attempts"),
          runbooks: safe("SELECT COUNT(*) as cnt FROM runbooks WHERE status = 'active'"),
          antiRunbooks: safe("SELECT COUNT(*) as cnt FROM anti_runbooks WHERE status = 'active'"),
          relations: safe("SELECT COUNT(*) as cnt FROM entity_relations"),
          evidenceEvents: safe("SELECT COUNT(*) as cnt FROM evidence_log"),
        };
      } catch (e: any) {
        result.graphDb = { error: e.message };
      }
    } else {
      result.graphDb = { error: "not found" };
    }

    // Memory DB stats (temporary connection — not the main DB singleton)
    const memDbPath = resolve(homedir(), ".clawcore", "data", "memory.db");
    if (existsSync(memDbPath)) {
      try {
        const Database = (await import("better-sqlite3")).default;
        const db = new Database(memDbPath, { readonly: true });
        const safe = (sql: string): number => {
          try { return (db.prepare(sql).get() as { cnt: number }).cnt; } catch { return -1; }
        };
        result.memoryDb = {
          path: memDbPath,
          sizeMb: +(statSync(memDbPath).size / 1024 / 1024).toFixed(2),
          conversations: safe("SELECT COUNT(*) as cnt FROM conversations"),
          messages: safe("SELECT COUNT(*) as cnt FROM messages"),
          summaries: safe("SELECT COUNT(*) as cnt FROM summaries"),
        };
        db.close();
      } catch (e: any) {
        result.memoryDb = { error: e.message };
      }
    }

    // Awareness
    if (awarenessStatsGetter) {
      result.awareness = awarenessStatsGetter();
    }

    // Config
    result.config = {
      relationsEnabled: config.relations.enabled,
      dataDir: config.dataDir,
      graphDbPath: config.relations.graphDbPath,
    };

    // Query analytics summary
    result.queries = {
      total: records.length,
      recent: records.slice(-5).map(r => ({
        query: r.query.substring(0, 50),
        confidence: r.confidence,
        strategy: r.strategy,
        elapsedMs: r.elapsedMs,
      })),
    };

    return result;
  });
}
