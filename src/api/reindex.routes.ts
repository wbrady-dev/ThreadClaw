import type { FastifyInstance } from "fastify";
import { resolve } from "path";
import { existsSync } from "fs";
import { config } from "../config.js";
import { getDb } from "../storage/index.js";
import { logger } from "../utils/logger.js";
import { ingestFile } from "../ingest/pipeline.js";
import { clearCache } from "../query/cache.js";
import { isLocalRequest } from "./guards.js";

/**
 * Re-indexing routes.
 * Re-ingest documents from their original source paths with current settings.
 * Useful when chunking config, embedding model, or other settings change.
 */
export function registerReindexRoutes(server: FastifyInstance) {
  /**
   * POST /reindex — re-ingest all documents in a collection (or all collections).
   * Documents are re-read from their original source_path, re-chunked, and re-embedded.
   * Skipped if source file no longer exists.
   *
   * Body: { collection?: string, dry_run?: boolean }
   * Returns: { reindexed, skipped, failed, elapsed_ms }
   */
  server.post("/reindex", async (req, reply) => {
    if (!isLocalRequest(req)) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    const { collection, dry_run } = req.body as {
      collection?: string;
      dry_run?: boolean;
    } ?? {};

    const db = getDb(resolve(config.dataDir, "clawcore.db"));

    // Get documents to reindex
    let docs: { id: string; source_path: string; collection_name: string }[];
    if (collection) {
      docs = db.prepare(`
        SELECT d.id, d.source_path, c.name as collection_name
        FROM documents d
        JOIN collections c ON c.id = d.collection_id
        WHERE c.name = ?
        ORDER BY d.created_at
      `).all(collection) as typeof docs;
    } else {
      docs = db.prepare(`
        SELECT d.id, d.source_path, c.name as collection_name
        FROM documents d
        JOIN collections c ON c.id = d.collection_id
        ORDER BY d.created_at
      `).all() as typeof docs;
    }

    if (dry_run) {
      const available = docs.filter((d) => d.source_path && existsSync(d.source_path));
      const missing = docs.filter((d) => !d.source_path || !existsSync(d.source_path));
      return {
        dry_run: true,
        total: docs.length,
        available: available.length,
        missing: missing.length,
        missing_paths: missing.map((d) => d.source_path),
      };
    }

    const start = Date.now();
    let reindexed = 0;
    let skipped = 0;
    let failed = 0;

    for (const doc of docs) {
      if (!doc.source_path || !existsSync(doc.source_path)) {
        skipped++;
        continue;
      }

      try {
        await ingestFile(doc.source_path, {
          collection: doc.collection_name,
          force: true, // force re-ingest even if hash matches
        });
        reindexed++;
      } catch (err) {
        logger.error({ path: doc.source_path, error: String(err) }, "Reindex failed for document");
        failed++;
      }
    }

    // Clear query cache since results may have changed
    clearCache();

    return {
      reindexed,
      skipped,
      failed,
      total: docs.length,
      elapsed_ms: Date.now() - start,
    };
  });

  /**
   * POST /reindex/stale — re-ingest only documents whose source file has changed
   * since last ingestion (based on file_mtime).
   */
  server.post("/reindex/stale", async (req, reply) => {
    if (!isLocalRequest(req)) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    const { collection } = req.body as { collection?: string } ?? {};
    const db = getDb(resolve(config.dataDir, "clawcore.db"));
    const { stat } = await import("fs/promises");

    let docs: { id: string; source_path: string; collection_name: string; file_mtime: string | null }[];
    if (collection) {
      docs = db.prepare(`
        SELECT d.id, d.source_path, c.name as collection_name, d.file_mtime
        FROM documents d
        JOIN collections c ON c.id = d.collection_id
        WHERE c.name = ?
      `).all(collection) as typeof docs;
    } else {
      docs = db.prepare(`
        SELECT d.id, d.source_path, c.name as collection_name, d.file_mtime
        FROM documents d
        JOIN collections c ON c.id = d.collection_id
      `).all() as typeof docs;
    }

    const start = Date.now();
    let reindexed = 0;
    let upToDate = 0;
    let skipped = 0;
    let failed = 0;

    for (const doc of docs) {
      if (!doc.source_path || !existsSync(doc.source_path)) {
        skipped++;
        continue;
      }

      try {
        const st = await stat(doc.source_path);
        const currentMtime = st.mtime.toISOString();

        if (doc.file_mtime && currentMtime <= doc.file_mtime) {
          upToDate++;
          continue;
        }

        await ingestFile(doc.source_path, {
          collection: doc.collection_name,
          force: true,
        });
        reindexed++;
      } catch (err) {
        logger.error({ path: doc.source_path, error: String(err) }, "Stale reindex failed");
        failed++;
      }
    }

    if (reindexed > 0) clearCache();

    return {
      reindexed,
      upToDate,
      skipped,
      failed,
      total: docs.length,
      elapsed_ms: Date.now() - start,
    };
  });
}
