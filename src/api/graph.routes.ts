import type { FastifyInstance } from "fastify";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { config } from "../config.js";
import { getGraphDb } from "../storage/graph-sqlite.js";
import { ensureGraphSchema } from "../relations/ingest-hook.js";

const TERMS_PATH = join(homedir(), ".clawcore", "relations-terms.json");
const VALID_TERM_RE = /^[\p{L}\p{N}\s\-_.'"]+$/u;

function isLocal(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function registerGraphRoutes(server: FastifyInstance) {
  /**
   * GET /graph/entities — list entities sorted by mention_count DESC.
   * Query params: limit (default 50), offset (default 0), search (optional).
   */
  server.get("/graph/entities", async (req, reply) => {
    if (!isLocal(req.ip ?? "")) return reply.status(403).send({ error: "Forbidden" });

    const { limit: limitStr, offset: offsetStr, search } = req.query as {
      limit?: string; offset?: string; search?: string;
    };
    const limit = Math.min(200, Math.max(1, parseInt(limitStr ?? "50", 10)));
    const offset = Math.max(0, parseInt(offsetStr ?? "0", 10));

    const graphDbPath = config.relations?.graphDbPath;
    if (!graphDbPath) return reply.status(404).send({ error: "Relations not configured" });

    const db = getGraphDb(graphDbPath);
    ensureGraphSchema(db);

    let entities;
    if (search && search.trim()) {
      const pattern = `%${search.toLowerCase().trim()}%`;
      entities = db.prepare(
        "SELECT id, name, display_name, entity_type, mention_count, first_seen_at, last_seen_at FROM entities WHERE name LIKE ? ORDER BY mention_count DESC LIMIT ? OFFSET ?",
      ).all(pattern, limit, offset);
    } else {
      entities = db.prepare(
        "SELECT id, name, display_name, entity_type, mention_count, first_seen_at, last_seen_at FROM entities ORDER BY mention_count DESC LIMIT ? OFFSET ?",
      ).all(limit, offset);
    }

    const total = (db.prepare("SELECT COUNT(*) as cnt FROM entities").get() as { cnt: number }).cnt;

    return { entities, total, limit, offset };
  });

  /**
   * GET /graph/entities/:id — entity detail with recent mentions.
   */
  server.get("/graph/entities/:id", async (req, reply) => {
    if (!isLocal(req.ip ?? "")) return reply.status(403).send({ error: "Forbidden" });

    const { id } = req.params as { id: string };
    const graphDbPath = config.relations?.graphDbPath;
    if (!graphDbPath) return reply.status(404).send({ error: "Relations not configured" });

    const db = getGraphDb(graphDbPath);
    const entity = db.prepare(
      "SELECT id, name, display_name, entity_type, mention_count, first_seen_at, last_seen_at FROM entities WHERE id = ?",
    ).get(parseInt(id, 10));

    if (!entity) return reply.status(404).send({ error: "Entity not found" });

    const mentions = db.prepare(
      "SELECT id, source_type, source_id, source_detail, context_terms, actor, created_at FROM entity_mentions WHERE entity_id = ? ORDER BY created_at DESC LIMIT 50",
    ).all(parseInt(id, 10));

    return { entity, mentions };
  });

  /**
   * GET /graph/terms — read the user terms list.
   */
  server.get("/graph/terms", async (req, reply) => {
    if (!isLocal(req.ip ?? "")) return reply.status(403).send({ error: "Forbidden" });

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
    if (!isLocal(req.ip ?? "")) return reply.status(403).send({ error: "Forbidden" });

    const { terms } = (req.body as { terms?: unknown }) ?? {};
    if (!Array.isArray(terms)) {
      return reply.status(400).send({ error: "Body must have a 'terms' array" });
    }

    // Validate and sanitize
    const cleaned = terms
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0 && t.length <= 100 && VALID_TERM_RE.test(t))
      .map((t) => t.trim())
      .slice(0, 500);

    mkdirSync(dirname(TERMS_PATH), { recursive: true });
    writeFileSync(TERMS_PATH, JSON.stringify({ terms: cleaned }, null, 2));

    return { terms: cleaned, count: cleaned.length };
  });
}
