import type { FastifyInstance } from "fastify";
import { getMainDb } from "../storage/index.js";
import { listDocuments, deleteDocument, getCollectionByName } from "../storage/collections.js";
import { clearCache } from "../query/cache.js";
import { isLocalRequest } from "./guards.js";
import { toClientError } from "../utils/errors.js";

const DOC_ID_RE = /^[\w\-]{1,128}$/;
const COLLECTION_RE = /^[\w\s\-_.]{1,100}$/;

export function registerDocumentRoutes(server: FastifyInstance) {
  server.get("/documents", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });
    try {
      const { collection } = req.query as { collection?: string };

      if (collection != null && (typeof collection !== "string" || !COLLECTION_RE.test(collection))) {
        return reply.status(400).send({ error: "Invalid collection name (letters, numbers, hyphens, underscores, dots; max 100 chars)" });
      }

      const database = getMainDb();

      let collectionId: string | undefined;
      if (collection) {
        const coll = getCollectionByName(database, collection);
        if (!coll) return reply.status(404).send({ error: `Collection '${collection}' not found` });
        collectionId = coll.id;
      }

      const documents = listDocuments(database, collectionId);
      return { documents };
    } catch (err) {
      return reply.code(500).send({ error: toClientError(err, "List documents") });
    }
  });

  server.delete("/documents/:id", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });

    const { id } = req.params as { id: string };

    // Validate :id parameter format
    if (!DOC_ID_RE.test(id)) {
      return reply.status(400).send({ error: "Invalid document ID format" });
    }

    try {
      const database = getMainDb();

      // Verify document exists
      const doc = database.prepare("SELECT id, source_path FROM documents WHERE id = ?").get(id) as { id: string; source_path: string } | undefined;
      if (!doc) {
        return reply.status(404).send({ error: "Document not found" });
      }

      // deleteDocument handles graph cleanup internally
      const result = deleteDocument(database, id);
      clearCache();

      return { deleted: true, chunksRemoved: result.chunksDeleted, source_path: doc.source_path };
    } catch (err) {
      return reply.code(500).send({ error: toClientError(err, "Delete document") });
    }
  });
}
