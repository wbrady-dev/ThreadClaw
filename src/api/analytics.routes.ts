import type { FastifyInstance } from "fastify";
import { existsSync, statSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { basename } from "path";
import { isLocalRequest } from "./guards.js";
import { getRecords, clearRecords } from "../analytics/query-recorder.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { toClientError } from "../utils/errors.js";

/** Cached memory DB connection for diagnostics (avoids opening a new connection per request) */
let cachedMemDb: import("better-sqlite3").Database | null = null;
let cachedMemDbPath: string | null = null;

function getMemoryDb(memDbPath: string): import("better-sqlite3").Database | null {
  if (cachedMemDb && cachedMemDbPath === memDbPath) return cachedMemDb;
  try {
    // Dynamic import is acceptable here — this is a lazily-loaded optional dependency
    const Database = require("better-sqlite3");
    if (cachedMemDb) try { cachedMemDb.close(); } catch {}
    cachedMemDb = new Database(memDbPath, { readonly: true });
    cachedMemDbPath = memDbPath;
    return cachedMemDb;
  } catch {
    return null;
  }
}

export function registerAnalyticsRoutes(server: FastifyInstance) {
  /**
   * GET /analytics — query performance summary.
   * Returns aggregate stats and recent low-confidence queries.
   */
  server.get("/analytics", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });
    try {
      const records = getRecords();
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
          query: r.query.substring(0, 80),
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
          query: r.query.substring(0, 80),
          collection: r.collection,
          vectorHits: r.vectorHits,
          bm25Hits: r.bm25Hits,
        }));

      // Slow queries (>2s)
      const slow = records
        .filter((r) => r.elapsedMs > 2000 && !r.cached)
        .slice(-10)
        .map((r) => ({
          query: r.query.substring(0, 80),
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
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to fetch analytics");
      return reply.code(500).send({ error: toClientError(err, "Fetch analytics") });
    }
  });

  /**
   * GET /analytics/recent — last N queries with full details.
   */
  server.get("/analytics/recent", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });
    try {
      const records = getRecords();
      const { limit } = req.query as { limit?: string };
      const parsed = parseInt(limit ?? "20", 10);
      const n = Math.min(isNaN(parsed) ? 20 : Math.max(1, parsed), 100);
      return { queries: records.slice(-n).reverse() };
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to fetch recent analytics");
      return reply.code(500).send({ error: toClientError(err, "Fetch recent analytics") });
    }
  });

  /**
   * DELETE /analytics — clear analytics data.
   * Requires { confirm: true } in body to prevent accidental deletion.
   */
  server.delete("/analytics", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });
    const { confirm } = (req.body as { confirm?: boolean }) ?? {};
    if (confirm !== true) {
      return reply.status(400).send({ error: "Must send { confirm: true } to clear analytics" });
    }
    clearRecords();
    return { cleared: true };
  });

  /**
   * GET /analytics/awareness — awareness layer stats.
   *
   * Awareness stats are tracked in the memory-engine process (OpenClaw plugin),
   * not in the ThreadClaw HTTP server. This endpoint returns stats if the awareness
   * module has been loaded into this process, or a fallback otherwise.
   *
   * For full awareness metrics, use the eval harness via the OpenClaw plugin API.
   */
  server.get("/analytics/awareness", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });
    // The awareness eval module may be loaded into this process if the
    // memory-engine plugin is colocated. Try to access it.
    if (awarenessStatsGetter) {
      const { window } = req.query as { window?: string };
      const parsed = parseInt(window ?? "", 10);
      // Use proper NaN check: parseInt("0") returns 0 which is valid
      const windowMs = (!isNaN(parsed) && parsed > 0) ? parsed * 1000 : 86_400_000;
      return awarenessStatsGetter(windowMs);
    }
    return {
      message: "Awareness stats are tracked in the OpenClaw agent process, not the ThreadClaw HTTP server.",
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

/** Close the cached memory DB connection. Call during server shutdown. */
export function closeAnalyticsDb(): void {
  if (cachedMemDb) {
    try { cachedMemDb.close(); } catch {}
    cachedMemDb = null;
    cachedMemDbPath = null;
  }
}

/**
 * GET /analytics/diagnostics — full RSMA health for external monitoring.
 * Returns evidence graph stats, awareness metrics, and config state.
 *
 * Note: This is registered separately from registerAnalyticsRoutes because
 * it has heavier dependencies (graph DB, memory DB) that not all deployments need.
 * Both are wired up in routes.ts.
 */
export function registerDiagnosticsRoute(server: FastifyInstance) {
  server.get("/analytics/diagnostics", async (req, reply) => {
    if (!isLocalRequest(req)) {
      return reply.status(403).send({ error: "Forbidden" });
    }
    const records = getRecords();

    const result: Record<string, unknown> = {};

    // Graph DB stats (use getGraphDb singleton — same driver as rest of ThreadClaw)
    const graphDbPath = config.relations.graphDbPath;
    if (existsSync(graphDbPath)) {
      try {
        const { getGraphDb } = await import("../storage/graph-sqlite.js");
        const db = getGraphDb(graphDbPath);
        const safe = (sql: string): number => {
          try { return (db.prepare(sql).get() as { cnt: number }).cnt; } catch { return -1; }
        };
        result.graphDb = {
          path: basename(graphDbPath), // redact to basename — don't expose internal paths
          sizeMb: +(statSync(graphDbPath).size / 1024 / 1024).toFixed(2),
          entities: safe("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'entity'"),
          mentions: safe("SELECT COUNT(*) as cnt FROM provenance_links WHERE predicate = 'mentioned_in'"),
          evidenceEvents: safe("SELECT COUNT(*) as cnt FROM evidence_log"),
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        result.graphDb = { error: msg };
      }
    } else {
      result.graphDb = { error: "not found" };
    }

    // Memory DB stats (reuse cached connection)
    const memDbPath = resolve(homedir(), ".threadclaw", "data", "memory.db");
    if (existsSync(memDbPath)) {
      try {
        const db = getMemoryDb(memDbPath);
        if (db) {
          const safe = (sql: string): number => {
            try { return (db.prepare(sql).get() as { cnt: number }).cnt; } catch { return -1; }
          };
          result.memoryDb = {
            path: basename(memDbPath), // redact to basename
            sizeMb: +(statSync(memDbPath).size / 1024 / 1024).toFixed(2),
            conversations: safe("SELECT COUNT(*) as cnt FROM conversations"),
            messages: safe("SELECT COUNT(*) as cnt FROM messages"),
            summaries: safe("SELECT COUNT(*) as cnt FROM summaries"),
          };
        } else {
          result.memoryDb = { error: "could not open" };
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        result.memoryDb = { error: msg };
      }
    }

    // Awareness
    if (awarenessStatsGetter) {
      result.awareness = awarenessStatsGetter();
    }

    // Config (redact full paths)
    result.config = {
      relationsEnabled: config.relations.enabled,
      dataDir: basename(config.dataDir),
      graphDbPath: basename(config.relations.graphDbPath),
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
