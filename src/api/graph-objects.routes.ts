import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { getGraphDb } from "../storage/graph-sqlite.js";
import { logger } from "../utils/logger.js";
import { isLocalRequest } from "./guards.js";

/**
 * RSMA object endpoints — claims, decisions, loops, conflicts, procedures.
 * All query memory_objects with appropriate kind filters.
 */
export function registerGraphObjectRoutes(server: FastifyInstance) {
  /**
   * GET /graph/claims — list claims.
   * Query params: scope_id, status, limit (default 50), offset (default 0).
   */
  server.get("/graph/claims", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });

    const { scope_id, status, limit: limitStr, offset: offsetStr } = req.query as {
      scope_id?: string; status?: string; limit?: string; offset?: string;
    };
    const limit = clampInt(limitStr, 50, 1, 200);
    const offset = clampInt(offsetStr, 0, 0);

    const graphDbPath = config.relations?.graphDbPath;
    if (!graphDbPath) return reply.status(404).send({ error: "Relations not configured" });

    try {
      const db = getGraphDb(graphDbPath);

      const conditions = ["kind = 'claim'"];
      const params: unknown[] = [];

      if (scope_id) {
        conditions.push("json_extract(structured_json, '$.scope_id') = ?");
        params.push(scope_id);
      }
      if (status) {
        conditions.push("json_extract(structured_json, '$.status') = ?");
        params.push(status);
      }

      const where = conditions.join(" AND ");

      const total = (db.prepare(
        `SELECT COUNT(*) as cnt FROM memory_objects WHERE ${where}`,
      ).get(...params) as { cnt: number }).cnt;

      params.push(limit, offset);
      const claims = db.prepare(`
        SELECT id, composite_id,
          json_extract(structured_json, '$.subject') as subject,
          json_extract(structured_json, '$.predicate') as predicate,
          json_extract(structured_json, '$.object') as object,
          json_extract(structured_json, '$.confidence') as confidence,
          json_extract(structured_json, '$.status') as status,
          json_extract(structured_json, '$.scope_id') as scope_id,
          created_at, last_observed_at
        FROM memory_objects
        WHERE ${where}
        ORDER BY last_observed_at DESC
        LIMIT ? OFFSET ?
      `).all(...params);

      return { claims, total, limit, offset };
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to list claims");
      return reply.status(503).send({ error: "Graph DB unavailable" });
    }
  });

  /**
   * GET /graph/decisions — list decisions.
   * Query params: scope_id, limit (default 50), offset (default 0).
   */
  server.get("/graph/decisions", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });

    const { scope_id, limit: limitStr, offset: offsetStr } = req.query as {
      scope_id?: string; limit?: string; offset?: string;
    };
    const limit = clampInt(limitStr, 50, 1, 200);
    const offset = clampInt(offsetStr, 0, 0);

    const graphDbPath = config.relations?.graphDbPath;
    if (!graphDbPath) return reply.status(404).send({ error: "Relations not configured" });

    try {
      const db = getGraphDb(graphDbPath);

      const conditions = ["kind = 'decision'"];
      const params: unknown[] = [];

      if (scope_id) {
        conditions.push("json_extract(structured_json, '$.scope_id') = ?");
        params.push(scope_id);
      }

      const where = conditions.join(" AND ");

      const total = (db.prepare(
        `SELECT COUNT(*) as cnt FROM memory_objects WHERE ${where}`,
      ).get(...params) as { cnt: number }).cnt;

      params.push(limit, offset);
      const decisions = db.prepare(`
        SELECT id, composite_id,
          json_extract(structured_json, '$.title') as title,
          json_extract(structured_json, '$.outcome') as outcome,
          json_extract(structured_json, '$.rationale') as rationale,
          json_extract(structured_json, '$.scope_id') as scope_id,
          created_at, last_observed_at
        FROM memory_objects
        WHERE ${where}
        ORDER BY last_observed_at DESC
        LIMIT ? OFFSET ?
      `).all(...params);

      return { decisions, total, limit, offset };
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to list decisions");
      return reply.status(503).send({ error: "Graph DB unavailable" });
    }
  });

  /**
   * GET /graph/loops — list open loops.
   * Query params: status (default: active), limit (default 50), offset (default 0).
   */
  server.get("/graph/loops", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });

    const { status, limit: limitStr, offset: offsetStr } = req.query as {
      status?: string; limit?: string; offset?: string;
    };
    const limit = clampInt(limitStr, 50, 1, 200);
    const offset = clampInt(offsetStr, 0, 0);

    const graphDbPath = config.relations?.graphDbPath;
    if (!graphDbPath) return reply.status(404).send({ error: "Relations not configured" });

    try {
      const db = getGraphDb(graphDbPath);

      const conditions = ["kind = 'loop'"];
      const params: unknown[] = [];

      if (status) {
        conditions.push("json_extract(structured_json, '$.status') = ?");
        params.push(status);
      }

      const where = conditions.join(" AND ");

      const total = (db.prepare(
        `SELECT COUNT(*) as cnt FROM memory_objects WHERE ${where}`,
      ).get(...params) as { cnt: number }).cnt;

      params.push(limit, offset);
      const loops = db.prepare(`
        SELECT id, composite_id,
          json_extract(structured_json, '$.question') as question,
          json_extract(structured_json, '$.status') as status,
          json_extract(structured_json, '$.opened_by') as opened_by,
          json_extract(structured_json, '$.resolution') as resolution,
          created_at, last_observed_at
        FROM memory_objects
        WHERE ${where}
        ORDER BY last_observed_at DESC
        LIMIT ? OFFSET ?
      `).all(...params);

      return { loops, total, limit, offset };
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to list loops");
      return reply.status(503).send({ error: "Graph DB unavailable" });
    }
  });

  /**
   * GET /graph/conflicts — list unresolved conflicts.
   * Query params: limit (default 50), offset (default 0).
   */
  server.get("/graph/conflicts", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });

    const { limit: limitStr, offset: offsetStr } = req.query as {
      limit?: string; offset?: string;
    };
    const limit = clampInt(limitStr, 50, 1, 200);
    const offset = clampInt(offsetStr, 0, 0);

    const graphDbPath = config.relations?.graphDbPath;
    if (!graphDbPath) return reply.status(404).send({ error: "Relations not configured" });

    try {
      const db = getGraphDb(graphDbPath);

      const where = "kind = 'conflict'";

      const total = (db.prepare(
        `SELECT COUNT(*) as cnt FROM memory_objects WHERE ${where}`,
      ).get() as { cnt: number }).cnt;

      const conflicts = db.prepare(`
        SELECT id, composite_id,
          json_extract(structured_json, '$.description') as description,
          json_extract(structured_json, '$.claim_ids') as claim_ids,
          json_extract(structured_json, '$.resolution') as resolution,
          json_extract(structured_json, '$.resolved') as resolved,
          created_at, last_observed_at
        FROM memory_objects
        WHERE ${where}
        ORDER BY last_observed_at DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset);

      return { conflicts, total, limit, offset };
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to list conflicts");
      return reply.status(503).send({ error: "Graph DB unavailable" });
    }
  });

  /**
   * GET /graph/procedures — list runbooks and anti-runbooks.
   * Query params: type (runbook|anti_runbook), limit (default 50), offset (default 0).
   */
  server.get("/graph/procedures", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });

    const { type, limit: limitStr, offset: offsetStr } = req.query as {
      type?: string; limit?: string; offset?: string;
    };
    const limit = clampInt(limitStr, 50, 1, 200);
    const offset = clampInt(offsetStr, 0, 0);

    const graphDbPath = config.relations?.graphDbPath;
    if (!graphDbPath) return reply.status(404).send({ error: "Relations not configured" });

    try {
      const db = getGraphDb(graphDbPath);

      // Procedures include runbook and anti_runbook kinds
      const validTypes = ["runbook", "anti_runbook"];
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (type && validTypes.includes(type)) {
        conditions.push("kind = ?");
        params.push(type);
      } else {
        conditions.push("kind IN ('runbook', 'anti_runbook')");
      }

      const where = conditions.join(" AND ");

      const total = (db.prepare(
        `SELECT COUNT(*) as cnt FROM memory_objects WHERE ${where}`,
      ).get(...params) as { cnt: number }).cnt;

      params.push(limit, offset);
      const procedures = db.prepare(`
        SELECT id, composite_id, kind,
          json_extract(structured_json, '$.title') as title,
          json_extract(structured_json, '$.description') as description,
          json_extract(structured_json, '$.steps') as steps,
          json_extract(structured_json, '$.trigger') as trigger_condition,
          created_at, last_observed_at
        FROM memory_objects
        WHERE ${where}
        ORDER BY last_observed_at DESC
        LIMIT ? OFFSET ?
      `).all(...params);

      return { procedures, total, limit, offset };
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to list procedures");
      return reply.status(503).send({ error: "Graph DB unavailable" });
    }
  });
  // ── Detail endpoints ─────────────────────────────────────────────

  /** GET /graph/claims/:id — claim detail with provenance. */
  server.get("/graph/claims/:id", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });
    const idNum = parseInt((req.params as { id: string }).id, 10);
    if (isNaN(idNum)) return reply.status(400).send({ error: "Invalid ID" });
    const graphDbPath = config.relations?.graphDbPath;
    if (!graphDbPath) return reply.status(404).send({ error: "Relations not configured" });
    try {
      const db = getGraphDb(graphDbPath);
      const claim = db.prepare(`
        SELECT id, composite_id,
          json_extract(structured_json, '$.subject') as subject,
          json_extract(structured_json, '$.predicate') as predicate,
          json_extract(structured_json, '$.object') as object,
          json_extract(structured_json, '$.confidence') as confidence,
          json_extract(structured_json, '$.status') as status,
          json_extract(structured_json, '$.scope_id') as scope_id,
          created_at, last_observed_at
        FROM memory_objects WHERE kind = 'claim' AND id = ?
      `).get(idNum);
      if (!claim) return reply.status(404).send({ error: "Claim not found" });
      const provenance = db.prepare(`
        SELECT id, subject_id, predicate, object_id, confidence, created_at
        FROM provenance_links WHERE subject_id = ? OR object_id = ?
        ORDER BY created_at DESC LIMIT 50
      `).all((claim as any).composite_id, (claim as any).composite_id);
      return { claim, provenance };
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to get claim detail");
      return reply.status(503).send({ error: "Graph DB unavailable" });
    }
  });

  /** GET /graph/decisions/:id — decision detail with provenance. */
  server.get("/graph/decisions/:id", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });
    const idNum = parseInt((req.params as { id: string }).id, 10);
    if (isNaN(idNum)) return reply.status(400).send({ error: "Invalid ID" });
    const graphDbPath = config.relations?.graphDbPath;
    if (!graphDbPath) return reply.status(404).send({ error: "Relations not configured" });
    try {
      const db = getGraphDb(graphDbPath);
      const decision = db.prepare(`
        SELECT id, composite_id,
          json_extract(structured_json, '$.title') as title,
          json_extract(structured_json, '$.outcome') as outcome,
          json_extract(structured_json, '$.rationale') as rationale,
          json_extract(structured_json, '$.scope_id') as scope_id,
          created_at, last_observed_at
        FROM memory_objects WHERE kind = 'decision' AND id = ?
      `).get(idNum);
      if (!decision) return reply.status(404).send({ error: "Decision not found" });
      const provenance = db.prepare(`
        SELECT id, subject_id, predicate, object_id, confidence, created_at
        FROM provenance_links WHERE subject_id = ? OR object_id = ?
        ORDER BY created_at DESC LIMIT 50
      `).all((decision as any).composite_id, (decision as any).composite_id);
      return { decision, provenance };
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to get decision detail");
      return reply.status(503).send({ error: "Graph DB unavailable" });
    }
  });

  /** GET /graph/loops/:id — loop detail with provenance. */
  server.get("/graph/loops/:id", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });
    const idNum = parseInt((req.params as { id: string }).id, 10);
    if (isNaN(idNum)) return reply.status(400).send({ error: "Invalid ID" });
    const graphDbPath = config.relations?.graphDbPath;
    if (!graphDbPath) return reply.status(404).send({ error: "Relations not configured" });
    try {
      const db = getGraphDb(graphDbPath);
      const loop = db.prepare(`
        SELECT id, composite_id,
          json_extract(structured_json, '$.question') as question,
          json_extract(structured_json, '$.status') as status,
          json_extract(structured_json, '$.opened_by') as opened_by,
          json_extract(structured_json, '$.resolution') as resolution,
          created_at, last_observed_at
        FROM memory_objects WHERE kind = 'loop' AND id = ?
      `).get(idNum);
      if (!loop) return reply.status(404).send({ error: "Loop not found" });
      const provenance = db.prepare(`
        SELECT id, subject_id, predicate, object_id, confidence, created_at
        FROM provenance_links WHERE subject_id = ? OR object_id = ?
        ORDER BY created_at DESC LIMIT 50
      `).all((loop as any).composite_id, (loop as any).composite_id);
      return { loop, provenance };
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to get loop detail");
      return reply.status(503).send({ error: "Graph DB unavailable" });
    }
  });
}

/* ── Helpers ──────────────────────────────────────────────────────── */

function clampInt(raw: string | undefined, fallback: number, min: number, max?: number): number {
  const parsed = parseInt(raw ?? String(fallback), 10);
  if (isNaN(parsed)) return fallback;
  const clamped = Math.max(min, parsed);
  return max !== undefined ? Math.min(max, clamped) : clamped;
}
