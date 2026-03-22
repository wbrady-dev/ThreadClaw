import type { FastifyInstance } from "fastify";
import { stopSources, startSources, getSourceEntries } from "../sources/index.js";
import { logger } from "../utils/logger.js";
import { isLocalRequest } from "./guards.js";

export function registerSourceRoutes(server: FastifyInstance) {
  /** Reload source config — stop all adapters, re-read .env, restart enabled ones */
  server.post("/sources/reload", async (req, reply) => {
    if (!isLocalRequest(req)) {
      return reply.status(403).send({ error: "Forbidden" });
    }
    try {
      logger.info("Reloading source adapters...");
      await stopSources();
      await startSources();
      logger.info("Source adapters reloaded");
      return reply.send({ status: "ok", message: "Sources reloaded" });
    } catch (err) {
      logger.error({ error: String(err) }, "Failed to reload sources");
      return reply.status(500).send({ status: "error", message: String(err) });
    }
  });

  /** Get current source status */
  server.get("/sources", async (_req, reply) => {
    const entries = getSourceEntries();
    return reply.send({
      sources: entries.map((e) => ({
        id: e.adapter.id,
        name: e.adapter.name,
        type: e.adapter.type,
        enabled: e.config.enabled,
        status: e.status,
        collections: e.config.collections,
      })),
    });
  });
}
