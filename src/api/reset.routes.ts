import type { FastifyInstance } from "fastify";
import { resolve } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { config } from "../config.js";
import { getMainDb } from "../storage/index.js";
import { resetKnowledgeBase } from "../storage/collections.js";
import { clearCache } from "../query/cache.js";
import { logger } from "../utils/logger.js";
import { isLocalRequest } from "./guards.js";

function db() {
  return getMainDb();
}

export function registerResetRoutes(server: FastifyInstance) {
  server.post("/reset", async (req, reply) => {
    // Destructive operation — localhost only (same pattern as /shutdown)
    if (!isLocalRequest(req)) {
      return reply.status(403).send({ error: "Forbidden — reset only allowed from localhost" });
    }

    const { clearGraph = true, clearMemory = false, confirm = false } = (req.body as {
      clearGraph?: boolean;
      clearMemory?: boolean;
      confirm?: boolean;
    }) ?? {};

    // Require explicit confirmation for this destructive operation
    if (!confirm) {
      return reply.status(400).send({ error: "Destructive operation requires confirm: true in request body" });
    }

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
          try { graphDb.pragma("wal_checkpoint(TRUNCATE)"); } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn({ error: msg }, "WAL checkpoint failed after reset");
          }
          try { graphDb.exec("VACUUM"); } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn({ error: msg }, "VACUUM failed after reset");
          }
          graphCleared = true;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn({ error: msg }, "Graph reset failed");
      }
    }

    let memoryCleared = false;
    let memoryStats: { conversations: number; messages: number; summaries: number; contextItems: number } | undefined;
    const deleteErrors: string[] = [];
    if (clearMemory) {
      try {
        // Memory DB may be at config dataDir OR ~/.threadclaw/data/ (plugin default)
        const memCandidates = [
          resolve(config.dataDir, "memory.db"),
          resolve(homedir(), ".threadclaw", "data", "memory.db"),
        ];
        const memPath = memCandidates.find((p) => existsSync(p));
        if (!memPath) {
          logger.warn("No memory DB found at any candidate path");
        } else {
          // Use getDb pattern (better-sqlite3) instead of node:sqlite DatabaseSync
          const Database = (await import("better-sqlite3")).default;
          const memDb = new Database(memPath);
          // Allowlist of valid memory tables to prevent SQL injection via table name interpolation
          const ALLOWED_MEM_TABLES = new Set([
            "context_items", "summary_parents", "summary_messages", "message_parts",
            "large_files", "summaries", "messages", "conversations",
            "messages_fts", "summaries_fts",
          ]);
          const validateTable = (tbl: string) => { if (!ALLOWED_MEM_TABLES.has(tbl)) throw new Error(`Invalid table name: ${tbl}`); };
          // Count before deleting
          const safeCount = (tbl: string) => { try { validateTable(tbl); return (memDb.prepare(`SELECT COUNT(*) as c FROM ${tbl}`).get() as { c: number })?.c ?? 0; } catch { return 0; } };
          memoryStats = {
            conversations: safeCount("conversations"),
            messages: safeCount("messages"),
            summaries: safeCount("summaries"),
            contextItems: safeCount("context_items"),
          };
          // Delete in FK-safe order: children first, then parents
          const memTables = ["context_items", "summary_parents", "summary_messages", "message_parts", "large_files", "summaries", "messages", "conversations"];
          for (const tbl of memTables) {
            try {
              validateTable(tbl);
              memDb.exec(`DELETE FROM ${tbl}`);
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              deleteErrors.push(`${tbl}: ${msg}`);
            }
          }
          try { validateTable("messages_fts"); memDb.exec("DELETE FROM messages_fts"); } catch (e: unknown) {
            deleteErrors.push(`messages_fts: ${e instanceof Error ? e.message : String(e)}`);
          }
          try { validateTable("summaries_fts"); memDb.exec("DELETE FROM summaries_fts"); } catch (e: unknown) {
            deleteErrors.push(`summaries_fts: ${e instanceof Error ? e.message : String(e)}`);
          }
          try { memDb.exec("VACUUM"); } catch {}
          memDb.close();
          memoryCleared = true;
          logger.warn(memoryStats, "Conversation memory wiped");
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn({ error: msg }, "Memory reset failed");
      }
    }

    logger.warn(stats, "Knowledge base reset complete");

    return {
      reset: true,
      ...stats,
      graphCleared,
      memoryCleared,
      memoryStats,
      ...(deleteErrors.length > 0 ? { deleteErrors } : {}),
    };
  });
}
