import type { FastifyInstance } from "fastify";
import { resolve } from "path";
import { statSync } from "fs";
import { config } from "../config.js";
import { getDb, listCollections } from "../storage/index.js";
import { getTokenCounts } from "../utils/token-tracker.js";

export function registerHealthRoutes(server: FastifyInstance) {
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
      checks.database = { status: "ok", detail: dbPath };
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
    // Only allow from localhost
    const remote = request.ip ?? "";
    const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!isLocal) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    reply.send({ status: "shutting down" });
    // Graceful shutdown after response is sent
    setTimeout(() => process.exit(0), 200);
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

    return {
      collections: collections.length,
      documents: totals.documents,
      chunks: totals.chunks,
      tokens: totals.tokens,
      dbSizeMB,
      localTokens: getTokenCounts(),
    };
  });
}
