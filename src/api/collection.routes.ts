import type { FastifyInstance } from "fastify";
import { resolve } from "path";
import { config } from "../config.js";
import { getDb } from "../storage/index.js";
import {
  listCollections,
  createCollection,
  deleteCollection,
  getCollectionStats,
  getCollection,
  getCollectionByName,
} from "../storage/collections.js";
import { invalidateCollection } from "../query/cache.js";
import { isLocalRequest } from "./guards.js";
import { logger } from "../utils/logger.js";

function db() {
  return getDb(resolve(config.dataDir, "clawcore.db"));
}

export function registerCollectionRoutes(server: FastifyInstance) {
  server.get("/collections", async () => {
    const collections = listCollections(db());
    return { collections };
  });

  server.post("/collections", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });
    const { name, description } = (req.body ?? {}) as {
      name: string;
      description?: string;
    };

    if (!name) {
      return reply.status(400).send({ error: "name required" });
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      return reply.status(400).send({ error: "name required" });
    }
    if (trimmedName.length > 100) {
      return reply.status(400).send({ error: "Collection name too long (max 100 characters)" });
    }
    if (!/^[\w\s\-_.]+$/.test(trimmedName)) {
      return reply.status(400).send({ error: "Collection name may only contain letters, numbers, spaces, hyphens, underscores, and dots" });
    }
    if (description && description.length > 1000) {
      return reply.status(400).send({ error: "Description too long (max 1000 characters)" });
    }

    const existing = getCollectionByName(db(), trimmedName);
    if (existing) {
      return reply.status(409).send({ error: "collection with this name already exists", collection: existing });
    }

    const collection = createCollection(db(), trimmedName, description);
    return reply.status(201).send(collection);
  });

  server.delete("/collections/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const collection = getCollection(db(), id);
    if (!collection) {
      return reply.status(404).send({ error: "Collection not found" });
    }
    if (collection.name === config.defaults.collection) {
      return reply.status(400).send({ error: "Cannot delete the default collection" });
    }
    // Get document IDs BEFORE deletion (CASCADE will remove them)
    const database = db();
    const docIds = database.prepare(
      "SELECT id FROM documents WHERE collection_id = ?",
    ).all(id) as Array<{ id: string }>;

    invalidateCollection(collection.name);
    deleteCollection(database, id);

    // Clean up graph data for deleted documents
    if (config.relations?.enabled && docIds.length > 0) {
      try {
        const { getGraphDb } = await import("../storage/graph-sqlite.js");
        const { deleteSourceData } = await import("../relations/ingest-hook.js");
        const graphDb = getGraphDb(config.relations.graphDbPath);
        for (const doc of docIds) {
          deleteSourceData(graphDb, "document", doc.id);
        }
      } catch (e) {
        logger.warn({ collectionId: id, error: String(e) }, "Graph cleanup failed during collection deletion");
      }
    }

    return { deleted: true };
  });

  server.get("/collections/:id/stats", async (req, reply) => {
    const { id } = req.params as { id: string };
    const stats = getCollectionStats(db(), id);
    if (!stats) {
      return reply.status(404).send({ error: "Collection not found" });
    }
    return stats;
  });
}
