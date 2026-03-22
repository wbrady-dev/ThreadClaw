import type { FastifyInstance } from "fastify";
import { resolve } from "path";
import { config } from "../config.js";
import { getDb } from "../storage/index.js";
import { resetKnowledgeBase } from "../storage/collections.js";
import { clearCache } from "../query/cache.js";
import { logger } from "../utils/logger.js";

function db() {
  return getDb(resolve(config.dataDir, "clawcore.db"));
}

export function registerResetRoutes(server: FastifyInstance) {
  server.post("/reset", async (req, reply) => {
    // Destructive operation — localhost only (same pattern as /shutdown)
    const ip = req.ip;
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
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
          const { getDb: getGraphDb } = await import("../storage/index.js");
          const graphDb = getGraphDb(graphDbPath);
          try { graphDb.prepare("DELETE FROM entity_mentions").run(); } catch {}
          try { graphDb.prepare("DELETE FROM entities").run(); } catch {}
          try { graphDb.prepare("DELETE FROM evidence_log").run(); } catch {}
          try { graphDb.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
          graphCleared = true;
        }
      } catch {
        // Graph DB may not exist or be configured
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
