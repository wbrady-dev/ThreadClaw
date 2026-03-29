import type { FastifyInstance, FastifyReply } from "fastify";
import { query } from "../query/pipeline.js";
import { logger } from "../utils/logger.js";
import { isLocalRequest } from "./guards.js";
import { toClientError } from "../utils/errors.js";

const MAX_TOP_K = 100;
const MAX_TOKEN_BUDGET = 50000;
const MAX_QUERY_BYTES = 8000; // 8KB byte limit for queries
const MAX_QUERY_LENGTH = 2000;
const COLLECTION_RE = /^[\w\s\-_.]{1,100}$/;

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
    return reply.status(503).send({ error: toClientError(err, "Embedding service unavailable", 503) });
  }
  return reply.status(500).send({ error: toClientError(err, label) });
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
      synthesize,
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
      synthesize?: boolean;
    };

    if (!queryText || typeof queryText !== "string" || queryText.length > MAX_QUERY_LENGTH) {
      return reply.code(400).send({ error: `Invalid query (max ${MAX_QUERY_LENGTH} characters)` });
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
      // Default to brief mode when neither brief nor titles_only is specified (matches MCP default)
      const effectiveBrief = brief ?? (titles_only ? false : true);

      const result = await query(queryText, {
        collection,
        topK: clampTopK(top_k),
        tokenBudget: clampBudget(token_budget),
        useReranker: use_reranker,
        useBm25: use_bm25,
        expand,
        brief: effectiveBrief,
        titlesOnly: titles_only,
        synthesize,
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

    if (!queryText || typeof queryText !== "string" || queryText.length > MAX_QUERY_LENGTH) {
      return reply.code(400).send({ error: `Invalid query (max ${MAX_QUERY_LENGTH} characters)` });
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
