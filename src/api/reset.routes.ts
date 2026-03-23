import type { FastifyInstance } from "fastify";
import { resolve } from "path";
import { config } from "../config.js";
import { getDb } from "../storage/index.js";
import { resetKnowledgeBase } from "../storage/collections.js";
import { clearCache } from "../query/cache.js";
import { logger } from "../utils/logger.js";
import { isLocalRequest } from "./guards.js";

function db() {
  return getDb(resolve(config.dataDir, "clawcore.db"));
}

export function registerResetRoutes(server: FastifyInstance) {
  server.post("/reset", async (req, reply) => {
    // Destructive operation — localhost only (same pattern as /shutdown)
    if (!isLocalRequest(req)) {
      return reply.status(403).send({ error: "Forbidden — reset only allowed from localhost" });
    }

    const { clearGraph = true, clearMemory = false } = (req.body as { clearGraph?: boolean; clearMemory?: boolean }) ?? {};

    logger.warn({ clearGraph, clearMemory }, "Knowledge base reset requested");

    const database = db();
    const stats = resetKnowledgeBase(database);
    clearCache();

    let graphCleared = false;
    if (clearGraph) {
      try {
        // Clear evidence graph tables if they exist
        const graphDbPath = config.relations?.graphDbPath;
        if (graphDbPath) {
          const { getGraphDb } = await import("../storage/graph-sqlite.js");
          const { clearAllGraphTables } = await import("../relations/ingest-hook.js");
          const graphDb = getGraphDb(graphDbPath);
          clearAllGraphTables(graphDb);
          try { graphDb.pragma("wal_checkpoint(TRUNCATE)"); } catch (e: any) {
            logger.warn({ error: e?.message }, "WAL checkpoint failed after reset");
          }
          try { graphDb.exec("VACUUM"); } catch (e: any) {
            logger.warn({ error: e?.message }, "VACUUM failed after reset");
          }
          graphCleared = true;
        }
      } catch (e: any) {
        logger.warn({ error: e?.message ?? String(e) }, "Graph reset failed");
      }
    }

    let memoryCleared = false;
    let memoryStats: { conversations: number; messages: number; summaries: number; contextItems: number } | undefined;
    if (clearMemory) {
      try {
        const { DatabaseSync } = await import("node:sqlite");
        const memPath = resolve(config.dataDir, "memory.db");
        const memDb = new DatabaseSync(memPath);
        // Count before deleting
        const safeCount = (tbl: string) => { try { return (memDb.prepare(`SELECT COUNT(*) as c FROM ${tbl}`).get() as any)?.c ?? 0; } catch { return 0; } };
        memoryStats = {
          conversations: safeCount("conversations"),
          messages: safeCount("messages"),
          summaries: safeCount("summaries"),
          contextItems: safeCount("context_items"),
        };
        // Delete in FK-safe order: children first, then parents
        const memTables = ["context_items", "summary_parents", "summary_messages", "message_parts", "large_files", "summaries", "messages", "conversations"];
        for (const tbl of memTables) { try { memDb.exec(`DELETE FROM ${tbl}`); } catch {} }
        try { memDb.exec("DELETE FROM messages_fts"); } catch {}
        try { memDb.exec("DELETE FROM summaries_fts"); } catch {}
        try { memDb.exec("VACUUM"); } catch {}
        memDb.close();
        memoryCleared = true;
        logger.warn(memoryStats, "Conversation memory wiped");
      } catch (e: any) {
        logger.warn({ error: e?.message ?? String(e) }, "Memory reset failed");
      }
    }

    logger.warn(stats, "Knowledge base reset complete");

    return {
      reset: true,
      ...stats,
      graphCleared,
      memoryCleared,
      memoryStats,
    };
  });
}
