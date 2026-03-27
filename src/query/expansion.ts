import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Optional query expansion module.
 * Only active when QUERY_EXPANSION_ENABLED=true in .env.
 * Uses a configurable chat LLM endpoint (local or remote).
 *
 * Provides three expansion techniques:
 * 1. Decomposition — break complex queries into sub-queries
 * 2. HyDE — generate hypothetical answer, embed for retrieval
 * 3. Multi-query — rephrase query from different angles
 */

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResponse {
  choices: { message: { content: string } }[];
}

// NOTE: No rate limiting on LLM calls. Query expansion fires up to 3 parallel
// LLM requests (decompose, HyDE, multi-query). If the LLM endpoint has rate limits,
// consider adding a semaphore or token bucket here.
async function chatComplete(messages: ChatMessage[]): Promise<string | null> {
  if (!config.queryExpansion.enabled || !config.queryExpansion.model) {
    return null;
  }

  // Strip trailing slashes from the base URL to prevent double-slash in path
  const baseUrl = config.queryExpansion.url.replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const apiKey = config.queryExpansion.apiKey;
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.queryExpansion.model,
        messages,
        temperature: config.queryExpansion.temperature,
        max_tokens: config.queryExpansion.maxTokens,
      }),
      signal: AbortSignal.timeout(config.queryExpansion.timeoutMs),
    });

    if (!response.ok) {
      logger.warn({ status: response.status, url }, "Query expansion LLM returned non-OK response");
      return null;
    }

    const data = (await response.json()) as ChatResponse;
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    logger.warn("Query expansion LLM unavailable");
    return null;
  }
}

/**
 * Decompose a complex query into 2-4 simpler sub-queries.
 */
export async function decomposeQuery(query: string): Promise<string[]> {
  const response = await chatComplete([
    {
      role: "system",
      content:
        "Break the user's question into 2-4 simpler, independent sub-queries. Return ONLY the sub-queries, one per line, no numbering.",
    },
    { role: "user", content: query },
  ]);

  if (!response) return [query];

  const subs = response
    .split("\n")
    .map((l) => l.replace(/^[-•*\d.)\s]+/, "").trim())
    .filter((l) => l.length > 5 && l.length < 200);

  return subs.length > 0 ? subs : [query];
}

/**
 * Generate a hypothetical answer paragraph for embedding.
 */
export async function generateHyDE(query: string): Promise<string | null> {
  return chatComplete([
    {
      role: "system",
      content:
        "Write a short paragraph (100-150 words) that would be a good answer to the question. Write it as if from an authoritative document. No preamble.",
    },
    { role: "user", content: query },
  ]);
}

/**
 * Generate 3 query rephrasings for broader recall.
 */
export async function generateMultiQuery(query: string): Promise<string[]> {
  const response = await chatComplete([
    {
      role: "system",
      content:
        "Generate 3 alternative phrasings of the user's question using different words. Return ONLY the 3 variants, one per line, no numbering.",
    },
    { role: "user", content: query },
  ]);

  if (!response) return [];

  return response
    .split("\n")
    .map((l) => l.replace(/^[-•*\d.)\s]+/, "").trim())
    .filter((l) => l.length > 5 && l.length < 200);
}

/**
 * Check if query expansion is available and enabled.
 */
export function isExpansionEnabled(): boolean {
  return config.queryExpansion.enabled && !!config.queryExpansion.model;
}
