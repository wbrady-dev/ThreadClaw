import type { FastifyInstance } from "fastify";
import { resolve } from "path";
import { config } from "../config.js";
import { getDb } from "../storage/index.js";
import { listDocuments, deleteDocument, getCollectionByName } from "../storage/collections.js";
import { clearCache } from "../query/cache.js";

function db() {
  return getDb(resolve(config.dataDir, "clawcore.db"));
}

export function registerDocumentRoutes(server: FastifyInstance) {
  server.get("/documents", async (req, reply) => {
    const { collection } = req.query as { collection?: string };
    const database = db();

    let collectionId: string | undefined;
    if (collection) {
      const coll = getCollectionByName(database, collection);
      if (!coll) return reply.status(404).send({ error: `Collection '${collection}' not found` });
      collectionId = coll.id;
    }

    const documents = listDocuments(database, collectionId);
    return { documents };
  });

  server.delete("/documents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const database = db();

    // Verify document exists
    const doc = database.prepare("SELECT id, source_path FROM documents WHERE id = ?").get(id) as { id: string; source_path: string } | undefined;
    if (!doc) {
      return reply.status(404).send({ error: "Document not found" });
    }

    const result = deleteDocument(database, id);
    clearCache();

    return { deleted: true, chunksRemoved: result.chunksDeleted, source_path: doc.source_path };
  });
}
