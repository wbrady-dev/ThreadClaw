import type { FastifyInstance, FastifyReply } from "fastify";
import { query } from "../query/pipeline.js";
import { logger } from "../utils/logger.js";
import { isLocalRequest } from "./guards.js";

const MAX_TOP_K = 100;
const MAX_TOKEN_BUDGET = 50000;
const MAX_QUERY_BYTES = 8000; // 8KB byte limit for queries
const COLLECTION_RE = /^[\w\-_.]{1,100}$/;

function clampTopK(v?: number): number | undefined {
  if (v == null || typeof v !== "number" || isNaN(v)) return undefined;
  const clamped = Math.min(Math.max(1, v), MAX_TOP_K);
  if (clamped !== v) logger.warn({ requested: v, clamped }, "top_k clamped to safe range");
  return clamped;
}

function clampBudget(v?: number): number | undefined {
  if (v == null || typeof v !== "number" || isNaN(v)) return undefined;
  const clamped = Math.min(Math.max(100, v), MAX_TOKEN_BUDGET);
  if (clamped !== v) logger.warn({ requested: v, clamped }, "token_budget clamped to safe range");
  return clamped;
}

/** Shared error handler for query/search endpoints */
function handleQueryError(err: unknown, reply: FastifyReply, label: string) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("Failed to fetch") || msg.includes("embedding")) {
    return reply.status(503).send({ error: `Embedding service unavailable: ${msg}. Ensure the embedding model is running (threadclaw start).` });
  }
  return reply.status(500).send({ error: `${label} failed: ${msg}` });
}

export function registerQueryRoutes(server: FastifyInstance) {
  server.post("/query", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });
    const {
      query: queryText,
      collection,
      top_k,
      token_budget,
      use_reranker,
      use_bm25,
      expand,
      brief,
      titles_only,
    } = (req.body ?? {}) as {
      query: string;
      collection?: string;
      top_k?: number;
      token_budget?: number;
      use_reranker?: boolean;
      use_bm25?: boolean;
      expand?: boolean;
      brief?: boolean;
      titles_only?: boolean;
    };

    if (!queryText || typeof queryText !== "string" || queryText.length > 2000) {
      return reply.code(400).send({ error: "Invalid query (max 2000 characters)" });
    }

    // Byte-length check to prevent oversized multi-byte payloads
    if (Buffer.byteLength(queryText, "utf-8") > MAX_QUERY_BYTES) {
      return reply.code(400).send({ error: `Query too large (max ${MAX_QUERY_BYTES} bytes)` });
    }

    // Validate collection parameter format
    if (collection != null && (typeof collection !== "string" || !COLLECTION_RE.test(collection))) {
      return reply.code(400).send({ error: "Invalid collection name (letters, numbers, hyphens, underscores, dots; max 100 chars)" });
    }

    try {
      const result = await query(queryText, {
        collection,
        topK: clampTopK(top_k),
        tokenBudget: clampBudget(token_budget),
        useReranker: use_reranker,
        useBm25: use_bm25,
        expand,
        brief,
        titlesOnly: titles_only,
      });
      return reply.send(result);
    } catch (err) {
      return handleQueryError(err, reply, "Query");
    }
  });

  server.post("/search", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });
    const {
      query: queryText,
      collection,
      top_k,
    } = (req.body ?? {}) as {
      query: string;
      collection?: string;
      top_k?: number;
    };

    if (!queryText || typeof queryText !== "string" || queryText.length > 2000) {
      return reply.code(400).send({ error: "Invalid query (max 2000 characters)" });
    }

    // Byte-length check
    if (Buffer.byteLength(queryText, "utf-8") > MAX_QUERY_BYTES) {
      return reply.code(400).send({ error: `Query too large (max ${MAX_QUERY_BYTES} bytes)` });
    }

    // Validate collection parameter format
    if (collection != null && (typeof collection !== "string" || !COLLECTION_RE.test(collection))) {
      return reply.code(400).send({ error: "Invalid collection name (letters, numbers, hyphens, underscores, dots; max 100 chars)" });
    }

    try {
      const result = await query(queryText, {
        collection,
        topK: clampTopK(top_k),
        useReranker: false,
      });
      return reply.send(result);
    } catch (err) {
      return handleQueryError(err, reply, "Search");
    }
  });
}
