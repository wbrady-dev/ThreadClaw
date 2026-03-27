import type { FastifyInstance } from "fastify";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { config } from "../config.js";
import { getGraphDb } from "../storage/graph-sqlite.js";

import { logger } from "../utils/logger.js";
import { isLocalRequest } from "./guards.js";
import { escapeLike } from "../utils/sql.js";

const TERMS_PATH = join(homedir(), ".threadclaw", "relations-terms.json");
const VALID_TERM_RE = /^[\p{L}\p{N}\s\-_.'"]+$/u;

export function registerGraphRoutes(server: FastifyInstance) {
  /**
   * GET /graph/entities — list entities sorted by mention_count DESC.
   * Query params: limit (default 50), offset (default 0), search (optional).
   */
  server.get("/graph/entities", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });

    const { limit: limitStr, offset: offsetStr, search } = req.query as {
      limit?: string; offset?: string; search?: string;
    };
    const parsedLimit = parseInt(limitStr ?? "50", 10);
    const limit = isNaN(parsedLimit) ? 50 : Math.min(200, Math.max(1, parsedLimit));
    const parsedOffset = parseInt(offsetStr ?? "0", 10);
    const offset = isNaN(parsedOffset) ? 0 : Math.max(0, parsedOffset);

    const graphDbPath = config.relations?.graphDbPath;
    if (!graphDbPath) return reply.status(404).send({ error: "Relations not configured" });

    try {
      const db = getGraphDb(graphDbPath);

      let entities;
      let total: number;

      if (search && search.trim()) {
        const pattern = `%${escapeLike(search.toLowerCase().trim())}%`;
        entities = db.prepare(`
          SELECT id,
            json_extract(structured_json, '$.name') as name,
            json_extract(structured_json, '$.displayName') as display_name,
            json_extract(structured_json, '$.entityType') as entity_type,
            json_extract(structured_json, '$.mentionCount') as mention_count,
            created_at as first_seen_at, last_observed_at as last_seen_at
          FROM memory_objects
          WHERE kind = 'entity' AND json_extract(structured_json, '$.name') LIKE ? ESCAPE '\\'
          ORDER BY json_extract(structured_json, '$.mentionCount') DESC
          LIMIT ? OFFSET ?
        `).all(pattern, limit, offset);

        // Fix: total count respects search filter
        total = (db.prepare(
          "SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'entity' AND json_extract(structured_json, '$.name') LIKE ? ESCAPE '\\\\'",
        ).get(pattern) as { cnt: number }).cnt;
      } else {
        entities = db.prepare(`
          SELECT id,
            json_extract(structured_json, '$.name') as name,
            json_extract(structured_json, '$.displayName') as display_name,
            json_extract(structured_json, '$.entityType') as entity_type,
            json_extract(structured_json, '$.mentionCount') as mention_count,
            created_at as first_seen_at, last_observed_at as last_seen_at
          FROM memory_objects
          WHERE kind = 'entity'
          ORDER BY json_extract(structured_json, '$.mentionCount') DESC
          LIMIT ? OFFSET ?
        `).all(limit, offset);

        total = (db.prepare(
          "SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'entity'",
        ).get() as { cnt: number }).cnt;
      }

      // Note: json_extract in ORDER BY prevents index usage on mentionCount.
      // Acceptable for current data sizes; consider a materialized column if this
      // becomes a bottleneck at scale.

      return { entities, total, limit, offset };
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to list graph entities");
      return reply.status(503).send({ error: "Graph DB unavailable" });
    }
  });

  /**
   * GET /graph/entities/:id — entity detail with recent mentions.
   */
  server.get("/graph/entities/:id", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });

    const { id } = req.params as { id: string };
    const idNum = parseInt(id, 10);
    if (isNaN(idNum)) return reply.status(400).send({ error: "Invalid entity ID" });

    const graphDbPath = config.relations?.graphDbPath;
    if (!graphDbPath) return reply.status(404).send({ error: "Relations not configured" });

    try {
      const db = getGraphDb(graphDbPath);

      const entity = db.prepare(`
        SELECT id,
          json_extract(structured_json, '$.name') as name,
          json_extract(structured_json, '$.displayName') as display_name,
          json_extract(structured_json, '$.entityType') as entity_type,
          json_extract(structured_json, '$.mentionCount') as mention_count,
          created_at as first_seen_at, last_observed_at as last_seen_at
        FROM memory_objects
        WHERE kind = 'entity' AND id = ?
      `).get(idNum);

      if (!entity) return reply.status(404).send({ error: "Entity not found" });

      // Get mention data from provenance_links
      const entityRow = db.prepare(
        "SELECT composite_id FROM memory_objects WHERE id = ?",
      ).get(idNum) as { composite_id: string } | undefined;
      const mentions = entityRow ? db.prepare(`
        SELECT pl.id, pl.object_id as source_ref, pl.detail as source_detail,
               json_extract(pl.metadata, '$.context_terms') as context_terms,
               json_extract(pl.metadata, '$.actor') as actor, pl.created_at
        FROM provenance_links pl
        WHERE pl.subject_id = ? AND pl.predicate = 'mentioned_in'
        ORDER BY pl.created_at DESC LIMIT 50
      `).all(entityRow.composite_id) : [];

      return { entity, mentions };
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to get entity detail");
      return reply.status(503).send({ error: "Graph DB unavailable" });
    }
  });

  /**
   * GET /graph/terms — read the user terms list.
   */
  server.get("/graph/terms", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });

    try {
      const raw = readFileSync(TERMS_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return { terms: Array.isArray(parsed.terms) ? parsed.terms : [] };
    } catch {
      return { terms: [] };
    }
  });

  /**
   * PUT /graph/terms — update the user terms list.
   * Body: { terms: string[] }
   */
  server.put("/graph/terms", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });

    const { terms } = (req.body as { terms?: unknown }) ?? {};
    if (!Array.isArray(terms)) {
      return reply.status(400).send({ error: "Body must have a 'terms' array" });
    }

    // Validate and sanitize — return count of rejected entries
    const validEntries: string[] = [];
    let rejectedCount = 0;
    for (const t of terms.slice(0, 500)) {
      if (typeof t === "string" && t.trim().length > 0 && t.length <= 100 && VALID_TERM_RE.test(t)) {
        validEntries.push(t.trim());
      } else {
        rejectedCount++;
      }
    }

    try {
      mkdirSync(dirname(TERMS_PATH), { recursive: true });
      writeFileSync(TERMS_PATH, JSON.stringify({ terms: validEntries }, null, 2));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ error: msg }, "Failed to save terms");
      return reply.status(500).send({ error: "Failed to save terms" });
    }

    return { terms: validEntries, count: validEntries.length, rejected: rejectedCount };
  });
}
