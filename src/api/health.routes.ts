import type { FastifyInstance } from "fastify";
import { resolve } from "path";
import { statSync } from "fs"; // statSync is acceptable in /stats (localhost-only, infrequent)
import { config } from "../config.js";
import { getMainDb, listCollections } from "../storage/index.js";
import { getGraphDb } from "../storage/graph-sqlite.js";
import { getTokenCounts } from "../utils/token-tracker.js";
import { isLocalRequest } from "./guards.js";
import { logger } from "../utils/logger.js";
import { toClientError } from "../utils/errors.js";

/** Short-lived TTL cache for /stats to avoid unparameterized queries on every call */
let statsCache: { data: Record<string, unknown>; ts: number } | null = null;
const STATS_CACHE_TTL_MS = 5000; // 5 seconds

export function registerHealthRoutes(server: FastifyInstance, onShutdown?: () => Promise<void>) {
  server.get("/health", async (request, reply) => {
    // Non-local requests get minimal status only (no internal details)
    if (!isLocalRequest(request)) {
      const checks: Record<string, { status: string }> = {};
      try {
        const embeddingBase = new URL(config.embedding.url).origin;
        const res = await fetch(`${embeddingBase}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        checks.embedding = { status: res.ok ? "ok" : "down" };
      } catch {
        checks.embedding = { status: "down" };
      }
      try {
        statSync(resolve(config.dataDir, "threadclaw.db"));
        checks.database = { status: "ok" };
      } catch {
        checks.database = { status: "missing" };
      }
      const allOk = Object.values(checks).every((c) => c.status === "ok");
      return reply.code(allOk ? 200 : 503).send({ status: allOk ? "healthy" : "degraded" });
    }

    const checks: Record<string, { status: string; detail?: string }> = {};

    // Check embedding server — use URL parsing instead of fragile string replace
    try {
      const embeddingBase = new URL(config.embedding.url).origin;
      const res = await fetch(`${embeddingBase}/health`, {
        signal: AbortSignal.timeout(3000),
      });

      // Safely parse response: check Content-Type before calling .json()
      if (res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          let data: Record<string, unknown> = {};
          try { data = await res.json() as Record<string, unknown>; } catch { /* malformed JSON */ }
          checks.embedding = { status: "ok", detail: config.embedding.model };
          checks.reranker = {
            status: (data as { models?: { rerank?: { ready?: boolean } } }).models?.rerank?.ready ? "ok" : "down",
          };
        } else {
          // Non-JSON response but server is up
          checks.embedding = { status: "ok", detail: config.embedding.model };
          checks.reranker = { status: "unknown" };
        }
      } else {
        checks.embedding = { status: "down", detail: `HTTP ${res.status}` };
        checks.reranker = { status: "down" };
      }
    } catch {
      checks.embedding = { status: "down" };
      checks.reranker = { status: "down" };
    }

    // Check database (statSync acceptable here — localhost-only, infrequent)
    try {
      const dbPath = resolve(config.dataDir, "threadclaw.db");
      statSync(dbPath);
      checks.database = { status: "ok" };
    } catch {
      checks.database = { status: "missing" };
    }

    const allOk = Object.values(checks).every((c) => c.status === "ok");
    const status = allOk ? "healthy" : "degraded";

    return reply.code(allOk ? 200 : 503).send({
      status,
      services: checks,
    });
  });

  server.post("/shutdown", async (request, reply) => {
    if (!isLocalRequest(request)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    reply.send({ status: "shutting down" });
    // Graceful shutdown after response is sent
    if (onShutdown) {
      setImmediate(() => onShutdown().catch((err) => logger.error({ error: String(err) }, "Shutdown handler error")));
    } else {
      setImmediate(() => {
        try { server.close(); } catch {}
        setTimeout(() => process.exit(0), 500);
      });
    }
  });

  server.get("/stats", async (request, reply) => {
    if (!isLocalRequest(request)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    // Return cached stats if within TTL
    if (statsCache && Date.now() - statsCache.ts < STATS_CACHE_TTL_MS) {
      return reply.send(statsCache.data);
    }

    try {
      const db = getMainDb();

      const collections = listCollections(db);

      const totals = db.prepare(`
        SELECT
          COUNT(DISTINCT d.id) as documents,
          COUNT(c.id) as chunks,
          COALESCE(SUM(c.token_count), 0) as tokens
        FROM documents d
        LEFT JOIN chunks c ON c.document_id = d.id
      `).get() as { documents: number; chunks: number; tokens: number };

      // Use SQLite's internal page accounting for accurate size (not affected by WAL bloat)
      const dbPath = resolve(config.dataDir, "threadclaw.db");
      let dbSizeMB = 0;
      try {
        // Pragma returns may be array of objects or single values — handle both
        const rawPageCount = db.pragma("page_count");
        const rawPageSize = db.pragma("page_size");
        const rawFreePages = db.pragma("freelist_count");
        const extractPragma = (raw: unknown, key: string, fallback: number): number => {
          if (Array.isArray(raw) && raw.length > 0) return (raw[0] as Record<string, number>)[key] ?? fallback;
          if (typeof raw === "number") return raw;
          return fallback;
        };
        const pageCount = extractPragma(rawPageCount, "page_count", 0);
        const pageSize = extractPragma(rawPageSize, "page_size", 4096);
        const freePages = extractPragma(rawFreePages, "freelist_count", 0);
        dbSizeMB = Math.round((pageCount - freePages) * pageSize / 1024 / 1024 * 100) / 100;
      } catch {
        // Fallback to file size (statSync acceptable — localhost-only, infrequent)
        try { dbSizeMB = Math.round(statSync(dbPath).size / 1024 / 1024 * 100) / 100; } catch {}
      }

      // Graph DB stats (if relations enabled)
      let graphStats: Record<string, unknown> | null = null;
      if (config.relations?.enabled) {
        try {
          const graphDb = getGraphDb(config.relations.graphDbPath);
          const safe = (sql: string): number => {
            try { return (graphDb.prepare(sql).get() as { cnt: number }).cnt; } catch { return 0; }
          };
          graphStats = {
            entities: safe("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'entity'"),
            mentions: safe("SELECT COUNT(*) as cnt FROM provenance_links WHERE predicate = 'mentioned_in'"),
            claims: safe("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'claim' AND status = 'active'"),
            decisions: safe("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'decision' AND status = 'active'"),
            loops: safe("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'loop' AND status = 'active'"),
            relations: safe("SELECT COUNT(*) as cnt FROM provenance_links WHERE predicate = 'relates_to'")
              || safe("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'relation' AND status = 'active'"),
            attempts: safe("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'attempt'"),
            evidenceEvents: safe("SELECT COUNT(*) as cnt FROM evidence_log"),
            graphDbSizeMB: Math.round(statSync(config.relations.graphDbPath).size / 1024 / 1024 * 100) / 100,
          };
        } catch (err) {
          logger.debug({ error: err instanceof Error ? err.message : String(err) }, "Failed to fetch graph DB stats");
        }
      }

      const result = {
        status: "ok",
        collections: collections.length,
        documents: totals.documents,
        chunks: totals.chunks,
        tokens: totals.tokens,
        dbSizeMB,
        localTokens: getTokenCounts(),
        graphStats,
      };

      // Update cache
      statsCache = { data: result, ts: Date.now() };

      return reply.send(result);
    } catch (err) {
      return reply.code(500).send({ error: toClientError(err, "Fetch stats") });
    }
  });
}
