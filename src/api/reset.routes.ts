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

    const { clearGraph = true } = (req.body as { clearGraph?: boolean }) ?? {};

    logger.warn("Knowledge base reset requested");

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

    logger.warn(stats, "Knowledge base reset complete");

    return {
      reset: true,
      ...stats,
      graphCleared,
    };
  });
}
