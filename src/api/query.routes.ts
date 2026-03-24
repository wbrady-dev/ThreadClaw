import type { FastifyInstance } from "fastify";
import { query } from "../query/pipeline.js";
import { logger } from "../utils/logger.js";
import { isLocalRequest } from "./guards.js";

const MAX_TOP_K = 100;
const MAX_TOKEN_BUDGET = 50000;

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

    try {
      return await query(queryText, {
        collection,
        topK: clampTopK(top_k),
        tokenBudget: clampBudget(token_budget),
        useReranker: use_reranker,
        useBm25: use_bm25,
        expand,
        brief,
        titlesOnly: titles_only,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("Failed to fetch") || msg.includes("embedding")) {
        return reply.status(503).send({ error: `Embedding service unavailable: ${msg}. Ensure the embedding model is running (threadclaw start).` });
      }
      return reply.status(500).send({ error: `Query failed: ${msg}` });
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

    try {
      return await query(queryText, {
        collection,
        topK: clampTopK(top_k),
        useReranker: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("Failed to fetch") || msg.includes("embedding")) {
        return reply.status(503).send({ error: `Embedding service unavailable: ${msg}. Ensure the embedding model is running (threadclaw start).` });
      }
      return reply.status(500).send({ error: `Search failed: ${msg}` });
    }
  });
}
