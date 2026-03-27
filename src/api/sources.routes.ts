import type { FastifyInstance } from "fastify";
import { stopSources, startSources, getSourceEntries } from "../sources/index.js";
import { logger } from "../utils/logger.js";
import { isLocalRequest } from "./guards.js";

/** Concurrency guard: prevents overlapping reload operations */
let reloadInProgress = false;

export function registerSourceRoutes(server: FastifyInstance) {
  /** Reload source config — stop all adapters, re-read .env, restart enabled ones */
  server.post("/sources/reload", async (req, reply) => {
    if (!isLocalRequest(req)) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    if (reloadInProgress) {
      return reply.status(409).send({ error: "Source reload already in progress" });
    }

    reloadInProgress = true;
    try {
      logger.info("Reloading source adapters...");
      await stopSources();
      await startSources();
      logger.info("Source adapters reloaded");
      return reply.send({ status: "ok", message: "Sources reloaded" });
    } catch (err) {
      logger.error({ error: String(err) }, "Failed to reload sources");
      return reply.status(500).send({ error: String(err) });
    } finally {
      reloadInProgress = false;
    }
  });

  /** Get current source status */
  server.get("/sources", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });
    try {
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
    } catch (err) {
      return reply.code(500).send({ error: `Failed to fetch sources: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}
