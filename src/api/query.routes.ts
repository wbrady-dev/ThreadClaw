import type { FastifyInstance } from "fastify";
import { query } from "../query/pipeline.js";
import { logger } from "../utils/logger.js";

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
    } = req.body as {
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

    if (!queryText) {
      return reply.status(400).send({ error: "query required" });
    }

    return query(queryText, {
      collection,
      topK: clampTopK(top_k),
      tokenBudget: clampBudget(token_budget),
      useReranker: use_reranker,
      useBm25: use_bm25,
      expand,
      brief,
      titlesOnly: titles_only,
    });
  });

  server.post("/search", async (req, reply) => {
    const {
      query: queryText,
      collection,
      top_k,
    } = req.body as {
      query: string;
      collection?: string;
      top_k?: number;
    };

    if (!queryText) {
      return reply.status(400).send({ error: "query required" });
    }

    return query(queryText, {
      collection,
      topK: clampTopK(top_k),
      useReranker: false,
    });
  });
}
