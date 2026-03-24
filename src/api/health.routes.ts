import type { FastifyInstance } from "fastify";
import { resolve } from "path";
import { statSync } from "fs";
import { config } from "../config.js";
import { getDb, listCollections } from "../storage/index.js";
import { getGraphDb } from "../storage/graph-sqlite.js";
import { getTokenCounts } from "../utils/token-tracker.js";
import { isLocalRequest } from "./guards.js";

export function registerHealthRoutes(server: FastifyInstance, onShutdown?: () => Promise<void>) {
  server.get("/health", async () => {
    const checks: Record<string, { status: string; detail?: string }> = {};

    // Check embedding server
    try {
      const res = await fetch(`${config.embedding.url.replace("/v1", "")}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const data = await res.json() as Record<string, unknown>;
      checks.embedding = { status: "ok", detail: config.embedding.model };
      checks.reranker = {
        status: (data as { models?: { rerank?: { ready?: boolean } } }).models?.rerank?.ready ? "ok" : "down",
      };
    } catch {
      checks.embedding = { status: "down" };
      checks.reranker = { status: "down" };
    }

    // Check database
    try {
      const dbPath = resolve(config.dataDir, "clawcore.db");
      statSync(dbPath);
      checks.database = { status: "ok" };
    } catch {
      checks.database = { status: "missing" };
    }

    const allOk = Object.values(checks).every((c) => c.status === "ok");

    return {
      status: allOk ? "healthy" : "degraded",
      services: checks,
    };
  });

  server.post("/shutdown", async (request, reply) => {
    if (!isLocalRequest(request)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    reply.send({ status: "shutting down" });
    // Graceful shutdown after response is sent
    if (onShutdown) {
      setImmediate(() => onShutdown());
    } else {
      setTimeout(() => process.exit(0), 200);
    }
  });

  server.get("/stats", async () => {
    const db = getDb(resolve(config.dataDir, "clawcore.db"));

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
    const dbPath = resolve(config.dataDir, "clawcore.db");
    let dbSizeMB = 0;
    try {
      const pageCount = (db.pragma("page_count") as { page_count: number }[])[0]?.page_count ?? 0;
      const pageSize = (db.pragma("page_size") as { page_size: number }[])[0]?.page_size ?? 4096;
      const freePages = (db.pragma("freelist_count") as { freelist_count: number }[])[0]?.freelist_count ?? 0;
      dbSizeMB = Math.round((pageCount - freePages) * pageSize / 1024 / 1024 * 100) / 100;
    } catch {
      // Fallback to file size
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
          entities: safe("SELECT COUNT(*) as cnt FROM entities"),
          mentions: safe("SELECT COUNT(*) as cnt FROM entity_mentions"),
          evidenceEvents: safe("SELECT COUNT(*) as cnt FROM evidence_log"),
          graphDbSizeMB: Math.round(statSync(config.relations.graphDbPath).size / 1024 / 1024 * 100) / 100,
        };
      } catch {}
    }

    return {
      collections: collections.length,
      documents: totals.documents,
      chunks: totals.chunks,
      tokens: totals.tokens,
      dbSizeMB,
      localTokens: getTokenCounts(),
      graphStats,
    };
  });
}
